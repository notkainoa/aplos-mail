import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandBraces, globToRegExp, parseOwners, resolveOwner } from '../owners-check.mjs';

const SCRIPT = fileURLToPath(new URL('../owners-check.mjs', import.meta.url));
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'owners-check-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const OWNERS = `# Ownership

Text and tables without Path and Lane columns are ignored.

| Name | Role |
|---|---|
| web | someone |

| Path | Lane | Thread | Notes |
|---|---|---|---|
| \`apps/web/**\` | web | Platform and website | the site |
| \`scripts/audit/**\`<br>\`.github/workflows/ci.yml\` | plat-ci | Platform and website | |
| \`tools/lint/**\` | plat-ci | Platform and website | except design |
| \`tools/lint/design/**\` | ui-foundation | UI-core | more specific |
| \`apps/desktop/src/renderer/{ui,commands}/**\` | ui-foundation | UI-core | |
| \`packages/engine/src/**\` | eng-store | Engine | |
| \`plans/**\` | integrator | Integrator | |
| \`apps/desktop/src/renderer/screens/home/**\` | ui-home | UI-core | |
| \`apps/desktop/src/renderer/screens/settings/**\` | ui-settings | UI-screens | |
| \`PROGRESS.md\`, \`DECISIONS.md\` | * | | shared |
| \`TODO.md\` | all | | shared |
`;

// A pull request run on Actions sets GITHUB_BASE_REF and GITHUB_HEAD_REF, which change what the script
// checks; the tests start without them and pass them explicitly where they matter.
const { GITHUB_BASE_REF: _base, GITHUB_HEAD_REF: _head, ...outerEnv } = process.env;
const GIT_ENV = {
  ...outerEnv,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const GIT_ARGS = [
  '-c',
  'user.name=Test Author',
  '-c',
  'user.email=k@kainoa.me',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
];

const git = (cwd, ...args) => {
  const result = spawnSync('git', [...GIT_ARGS, ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

let counter = 0;
/** A temp repo whose `main` holds OWNERS.md plus `files`, checked out on `branch`. */
function makeRepo({ branch = 'rv/web/site', owners = OWNERS, files = {} } = {}) {
  const dir = path.join(tmpRoot, `repo-${counter++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  if (owners !== null) write(dir, 'plans/OWNERS.md', owners);
  write(dir, 'README.md', 'seed\n');
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

function write(dir, file, content) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

function commit(dir, files, message = ['change']) {
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', ...message.flatMap(m => ['-m', m]));
}

function run(dir, args = [], env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    env: { ...GIT_ENV, ...env },
    encoding: 'utf8',
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const check = (dir, args = [], env) => run(dir, ['--base', 'main', ...args], env);
const violationFiles = res => JSON.parse(res.out).violations.map(v => v.file);

describe('change check', () => {
  test('a change inside the acting lane passes', () => {
    const dir = makeRepo();
    commit(dir, { 'apps/web/src/a.ts': 'x' });
    const res = check(dir);
    assert.equal(res.code, 0, res.out + res.err);
    assert.match(res.out, /^OK:/m);
  });

  test('a cross-lane change fails and names the owner', () => {
    const dir = makeRepo();
    commit(dir, { 'apps/web/a.ts': 'x', 'packages/engine/src/store.ts': 'y' });
    const res = check(dir);
    assert.equal(res.code, 1);
    assert.match(res.out, /packages\/engine\/src\/store\.ts\s+eng-store\s+web/);
    assert.match(res.out, /FAIL: 1 of 2/);
    assert.deepEqual(violationFiles(check(dir, ['--json'])), ['packages/engine/src/store.ts']);
  });

  test('a Lane-Approved commit trailer approves the owning lane', () => {
    const dir = makeRepo();
    commit(dir, { 'packages/engine/src/store.ts': 'y' }, [
      'touch engine',
      'Lane-Approved: eng-store',
    ]);
    const res = check(dir, ['--trailers']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /eng-store \(trailer [0-9a-f]{7}\)/);
    // The PR author wrote that trailer, so by default it approves nothing.
    assert.equal(check(dir).code, 1);
  });

  test('a trailer for another lane does not approve', () => {
    const dir = makeRepo();
    commit(dir, { 'packages/engine/src/store.ts': 'y' }, [
      'touch engine',
      'Lane-Approved: integrator',
    ]);
    assert.equal(check(dir, ['--trailers']).code, 1);
  });

  test('--approved approves the owning lane', () => {
    const dir = makeRepo();
    commit(dir, { 'plans/DESIGN.md': 'y' });
    assert.equal(check(dir).code, 1);
    assert.equal(check(dir, ['--approved', 'integrator']).code, 0);
  });

  test('--pr reads lane-approved labels through gh', () => {
    const dir = makeRepo();
    commit(dir, { 'plans/DESIGN.md': 'y' });
    const bin = path.join(tmpRoot, `bin-${counter++}`);
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\necho '{"labels":[{"name":"bug"},{"name":"lane-approved:integrator"}]}'\n`,
    );
    chmodSync(path.join(bin, 'gh'), 0o755);
    const withLabel = check(dir, ['--pr', '7'], {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    });
    assert.equal(withLabel.code, 0, withLabel.out + withLabel.err);
    assert.match(withLabel.out, /integrator \(PR label\)/);
  });

  test('the most specific glob wins (tools/lint/design belongs to ui-foundation)', () => {
    const dir = makeRepo({ branch: 'rv/plat-ci/lint' });
    commit(dir, { 'tools/lint/rules.mjs': 'a', 'tools/lint/design/no-hex.mjs': 'b' });
    const res = check(dir, ['--json']);
    assert.equal(res.code, 1);
    assert.deepEqual(violationFiles(res), ['tools/lint/design/no-hex.mjs']);
    assert.equal(JSON.parse(res.out).violations[0].owner, 'ui-foundation');
    // and the reverse: ui-foundation may edit design/ but not the rest of tools/lint
    git(dir, 'checkout', '-q', '-B', 'rv/ui-foundation/lint');
    assert.deepEqual(violationFiles(check(dir, ['--json'])), ['tools/lint/rules.mjs']);
  });

  test('brace globs and <br> separated globs are honoured', () => {
    const dir = makeRepo({ branch: 'rv/ui-foundation/x' });
    commit(dir, {
      'apps/desktop/src/renderer/commands/a.ts': 'a',
      'apps/desktop/src/renderer/ui/b.ts': 'b',
    });
    assert.equal(check(dir).code, 0);
    const ci = makeRepo({ branch: 'rv/plat-ci/x' });
    commit(ci, { '.github/workflows/ci.yml': 'a', 'scripts/audit/x.mjs': 'b' });
    assert.equal(check(ci).code, 0);
  });

  test('a rename across lanes checks both the old and the new path', () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const dir = makeRepo({ files: { 'apps/web/moved.ts': body } });
    mkdirSync(path.join(dir, 'tools/lint/design'), { recursive: true });
    git(dir, 'mv', 'apps/web/moved.ts', 'tools/lint/design/moved.ts');
    git(dir, 'commit', '-q', '-m', 'move');
    // acting web: the new path (ui-foundation) is the violation
    assert.deepEqual(violationFiles(check(dir, ['--json'])), ['tools/lint/design/moved.ts']);
    // acting ui-foundation: the old path (web) is the violation
    const reverse = check(dir, ['--json', '--lane', 'ui-foundation']);
    assert.deepEqual(violationFiles(reverse), ['apps/web/moved.ts']);
    assert.equal(check(dir, ['--lane', 'web,ui-foundation']).code, 0);
  });

  test('shared paths may be edited by anyone', () => {
    const dir = makeRepo();
    commit(dir, { 'PROGRESS.md': 'a', 'DECISIONS.md': 'b', 'TODO.md': 'c' });
    assert.equal(check(dir).code, 0);
  });

  test('an unowned path fails and tells the author to ask the Integrator', () => {
    const dir = makeRepo();
    commit(dir, { 'brand-new-folder/file.ts': 'x' });
    const res = check(dir);
    assert.equal(res.code, 1);
    assert.match(res.out, /brand-new-folder\/file\.ts\s+\(unowned\)/);
    assert.match(res.out, /ask the Integrator to add them to plans\/OWNERS\.md/);
    // approval of some lane never covers an unowned file
    assert.equal(check(dir, ['--approved', 'integrator,web']).code, 1);
  });

  test('rv/thread/<name> acts as every lane of that thread', () => {
    const dir = makeRepo({ branch: 'rv/thread/platform' });
    commit(dir, { 'apps/web/a.ts': 'a', 'scripts/audit/b.mjs': 'b' });
    const res = check(dir);
    assert.equal(res.code, 0, res.out + res.err);
    assert.match(res.out, /acting lane\(s\) web, plat-ci/);
    commit(dir, { 'packages/engine/src/x.ts': 'c' });
    assert.equal(check(dir).code, 1);
    git(dir, 'checkout', '-q', '-B', 'rv/thread/UI-core');
    assert.match(check(dir).out, /acting lane\(s\) ui-foundation/);
  });

  test('an unknown branch needs --lane, and --lane overrides the branch', () => {
    const dir = makeRepo({ branch: 'feature/whatever' });
    commit(dir, { 'apps/web/a.ts': 'a' });
    const res = check(dir);
    assert.equal(res.code, 2);
    assert.match(res.err, /pass --lane/);
    assert.equal(check(dir, ['--lane', 'web']).code, 0);
    assert.equal(check(dir, ['--lane', 'nonsense']).code, 2);
  });

  test('base defaults to the merge-base with origin/revamp', () => {
    const dir = makeRepo();
    git(dir, 'update-ref', 'refs/remotes/origin/revamp', 'main');
    commit(dir, { 'packages/engine/src/x.ts': 'a' });
    const res = run(dir, []);
    assert.equal(res.code, 1, res.out + res.err);
    assert.match(res.out, /packages\/engine\/src\/x\.ts/);
  });

  test('missing OWNERS.md prints pending and exits 0', () => {
    const dir = makeRepo({ owners: null, branch: 'rv/web/x' });
    commit(dir, { 'anything/at/all.ts': 'a' });
    const res = check(dir);
    assert.equal(res.code, 0);
    assert.equal(res.out.trim(), 'pending: plans/OWNERS.md not on this branch yet');
  });
});

describe('--validate', () => {
  test('reports unowned tracked files and only fails with --strict', () => {
    const dir = makeRepo({ files: { 'stray/one.ts': 'a', 'stray/two.ts': 'b' } });
    const res = run(dir, ['--validate', '--json']);
    const report = JSON.parse(res.out);
    assert.equal(res.code, 0);
    assert.equal(report.unowned, 3); // README.md, stray/one.ts, stray/two.ts
    assert.deepEqual(report.unownedAreas, { 'README.md': 1, stray: 2 });
    assert.equal(run(dir, ['--validate', '--strict']).code, 1);
  });

  test('detects a glob given to two lanes and a file two lanes own equally', () => {
    const tied = `${OWNERS}
| Path | Lane |
|---|---|
| \`apps/web/**\` | eng-views |
| \`lib/?a*\` | alpha |
| \`lib/*a?\` | beta |
`;
    const dir = makeRepo({ owners: tied, files: { 'lib/xaq': 'a' } });
    const res = run(dir, ['--validate']);
    assert.equal(res.code, 1);
    assert.match(res.out, /tie: glob apps\/web\/\*\* is listed for web .* and eng-views/);
    assert.match(res.out, /tie between alpha vs beta on 1 file\(s\), e\.g\. lib\/xaq/);
    // a change check refuses to run on an invalid file rather than guess
    commit(dir, { 'apps/web/a.ts': 'x' });
    assert.equal(check(dir).code, 1);
  });

  test('reports malformed rows', () => {
    const bad = `| Path | Lane |\n|---|---|\n| \`a/{b\` | x |\n| \`c/**\` | |\n`;
    const dir = makeRepo({ owners: bad });
    const res = run(dir, ['--validate']);
    assert.equal(res.code, 1);
    assert.match(res.out, /unbalanced "\{"/);
    assert.match(res.out, /no lane/);
  });
});

describe('glob matching and parsing', () => {
  test('globs', () => {
    const m = (glob, file) => expandBraces(glob).some(g => globToRegExp(g).test(file));
    assert.ok(m('a/**', 'a/b/c.ts'));
    assert.ok(!m('a/**', 'a'));
    assert.ok(m('a/**/c.ts', 'a/c.ts'));
    assert.ok(m('a/**/c.ts', 'a/x/y/c.ts'));
    assert.ok(m('a/*.ts', 'a/b.ts'));
    assert.ok(!m('a/*.ts', 'a/b/c.ts'));
    assert.ok(m('a/?.ts', 'a/b.ts'));
    assert.ok(!m('a/?.ts', 'a/bc.ts'));
    assert.ok(m('a/{b,c/d}/**', 'a/c/d/e'));
    assert.ok(!m('a/{b,c/d}/**', 'a/c/e'));
    assert.ok(m('x.mjs', 'x.mjs'));
    assert.ok(!m('x.mjs', 'xamjs'));
    assert.deepEqual(expandBraces('m/{a,b}.{ts,js}').sort(), [
      'm/a.js',
      'm/a.ts',
      'm/b.js',
      'm/b.ts',
    ]);
  });

  test('unticked <br> separated cells parse; a glob ending in "/" is ignored with a warning', () => {
    const parsed = parseOwners(
      '| **Paths** | `Lane` | THREAD |\n|:--|:-:|--|\n| scripts/design/**, docs/a.md<br/>x/{y,z}/**, old/ | **UI-Core** | T |\n',
    );
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0], /"old\/" ends with "\/"/);
    const owner = file => resolveOwner(parsed.rules, file)?.rule.lane;
    assert.equal(owner('scripts/design/a/b.ts'), 'ui-core');
    assert.equal(owner('docs/a.md'), 'ui-core');
    assert.equal(owner('x/z/q'), 'ui-core');
    assert.equal(owner('x/w/q'), undefined);
    assert.equal(owner('old/file'), undefined);
  });
});

describe('rules come from the base, not from the change', () => {
  test('deleting or renaming OWNERS.md does not disable the check', () => {
    const dir = makeRepo({ files: { 'packages/engine/src/s.ts': 'a' } });
    commit(dir, { 'packages/engine/src/s.ts': 'hack' });
    git(dir, 'rm', '-q', 'plans/OWNERS.md');
    git(dir, 'commit', '-q', '-m', 'evil');
    const res = check(dir, ['--json']);
    assert.equal(res.code, 1, res.out);
    assert.deepEqual(violationFiles(res), ['packages/engine/src/s.ts', 'plans/OWNERS.md']);
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    git(dir, 'mv', 'plans/OWNERS.md', 'plans/OWNERS.old.md');
    git(dir, 'commit', '-q', '-m', 'rename');
    const renamed = check(dir, ['--json']);
    assert.equal(renamed.code, 1, renamed.out);
    assert.deepEqual(violationFiles(renamed), [
      'packages/engine/src/s.ts',
      'plans/OWNERS.md',
      'plans/OWNERS.old.md',
    ]);
  });

  test('a change cannot rewrite OWNERS.md to give itself ownership', () => {
    const dir = makeRepo({ files: { 'packages/engine/src/s.ts': 'a' } });
    commit(dir, {
      'packages/engine/src/s.ts': 'hack',
      'plans/OWNERS.md': `${OWNERS}\n| Path | Lane | Thread |\n|---|---|---|\n| \`plans/OWNERS.md\` | web | Platform and website |\n| \`packages/engine/src/s.ts\` | web | Platform and website |\n`,
    });
    const res = check(dir, ['--json']);
    assert.equal(res.code, 1, res.out);
    assert.deepEqual(violationFiles(res), ['packages/engine/src/s.ts', 'plans/OWNERS.md']);
  });

  test('an OWNERS.md that exists only on the head is pending (the bootstrap commit)', () => {
    const dir = makeRepo({ owners: null });
    commit(dir, { 'plans/OWNERS.md': OWNERS, 'packages/engine/src/s.ts': 'a' });
    assert.match(check(dir).out, /^pending:/);
  });
});

describe('approval trailers', () => {
  test('prose in a trailer approves nothing; a comma separated list approves several lanes', () => {
    const dir = makeRepo({
      files: { 'packages/engine/src/s.ts': 'a', 'tools/lint/design/d.mjs': 'a' },
    });
    commit(dir, { 'packages/engine/src/s.ts': 'b', 'tools/lint/design/d.mjs': 'b' }, [
      'touch',
      'Lane-Approved: eng-store per ui-foundation review pending',
    ]);
    const bad = check(dir, ['--trailers', '--json']);
    assert.equal(bad.code, 1);
    assert.deepEqual(JSON.parse(bad.out).approvals, []);
    assert.equal(JSON.parse(bad.out).ignoredTrailers.length, 1);
    assert.match(check(dir, ['--trailers']).out, /ignored Lane-Approved value/);
    const fresh = makeRepo({
      files: { 'packages/engine/src/s.ts': 'a', 'tools/lint/design/d.mjs': 'a' },
    });
    commit(fresh, { 'packages/engine/src/s.ts': 'b', 'tools/lint/design/d.mjs': 'b' }, [
      'touch',
      'Lane-Approved: eng-store, ui-foundation',
    ]);
    assert.equal(check(fresh, ['--trailers']).code, 0);
  });

  test('a trailer covers only the files of its own commit', () => {
    const dir = makeRepo({
      files: { 'packages/engine/src/one.ts': 'a', 'packages/engine/src/two.ts': 'a' },
    });
    commit(dir, { 'packages/engine/src/one.ts': 'b' }, ['fix one', 'Lane-Approved: eng-store']);
    commit(dir, { 'packages/engine/src/two.ts': 'rewrite' }, ['rewrite two']);
    const res = check(dir, ['--trailers', '--json']);
    assert.equal(res.code, 1);
    assert.deepEqual(violationFiles(res), ['packages/engine/src/two.ts']);
  });

  test('--no-trailers after --trailers turns trailers back off', () => {
    const dir = makeRepo({ files: { 'packages/engine/src/one.ts': 'a' } });
    commit(dir, { 'packages/engine/src/one.ts': 'b' }, ['fix one', 'Lane-Approved: eng-store']);
    assert.equal(check(dir, ['--trailers']).code, 0);
    assert.equal(check(dir, ['--trailers', '--no-trailers']).code, 1);
  });

  test('the help text and the failure hint name --trailers', () => {
    const dir = makeRepo();
    commit(dir, { 'packages/engine/src/store.ts': 'y' });
    assert.match(check(dir, ['--help']).out, /\[--trailers\]/);
    assert.match(check(dir).out, /counts only with --trailers/);
  });

  test('every commit touching a file must carry the approval', () => {
    const dir = makeRepo({ files: { 'packages/engine/src/one.ts': 'a' } });
    commit(dir, { 'packages/engine/src/one.ts': 'b' }, ['fix one', 'Lane-Approved: eng-store']);
    assert.equal(check(dir, ['--trailers']).code, 0);
    commit(dir, { 'packages/engine/src/one.ts': 'c' }, ['follow-up without approval']);
    assert.equal(check(dir, ['--trailers']).code, 1);
  });

  test('Owners-Exempt: phase-0 needs the integrator lane to approve it', () => {
    const dir = makeRepo({ files: { 'packages/engine/src/one.ts': 'a' } });
    commit(dir, { 'packages/engine/src/one.ts': 'b', 'new-root/file.ts': 'x' }, [
      'restructure',
      'Owners-Exempt: phase-0',
    ]);
    assert.equal(check(dir, ['--trailers']).code, 1);
    assert.equal(check(dir, ['--trailers', '--approved', 'integrator']).code, 0);
    git(dir, 'checkout', '-q', '-B', 'rv/thread/integrator');
    assert.equal(check(dir, ['--trailers']).code, 0);
  });
});

describe('acting lane resolution', () => {
  test('rv/thread/<prefix> that fits two threads is an error', () => {
    const dir = makeRepo({ branch: 'rv/thread/ui' });
    commit(dir, { 'apps/desktop/src/renderer/screens/settings/a.ts': 'a' });
    const res = check(dir);
    assert.equal(res.code, 2);
    assert.match(res.err, /ambiguous/);
    git(dir, 'checkout', '-q', '-B', 'rv/thread/ui-screens');
    assert.equal(check(dir).code, 0);
    git(dir, 'checkout', '-q', '-B', 'rv/thread/ui-core');
    assert.equal(check(dir).code, 1);
  });

  test('no changes pass on any branch; integration branches are skipped', () => {
    const dir = makeRepo({ branch: 'feature/anything' });
    assert.equal(check(dir).code, 0);
    assert.match(check(dir).out, /no changed files/);
    git(dir, 'checkout', '-q', '-B', 'revamp');
    commit(dir, { 'packages/engine/src/x.ts': 'a' });
    const res = check(dir);
    assert.equal(res.code, 0);
    assert.match(res.out, /^skipped:/);
    assert.equal(check(dir, ['--lane', 'web']).code, 1);
    assert.equal(check(dir, [], { GITHUB_BASE_REF: 'revamp' }).code, 2);
  });
});

describe('table parsing', () => {
  const owner = (parsed, file) => {
    const res = resolveOwner(parsed.rules, file);
    return res?.rule?.lane ?? null;
  };

  test('a row without a leading pipe is an error instead of being dropped', () => {
    const parsed = parseOwners(
      '| Path | Lane |\n|---|---|\n| `tools/lint/**` | plat-ci |\n`tools/lint/design/**` | ui-foundation |\n',
    );
    assert.match(parsed.errors.join('\n'), /line 4: table row must start with "\|"/);
  });

  test('a header without a leading pipe is an error', () => {
    const parsed = parseOwners('Path | Lane\n--- | ---\n| `a/**` | x |\n');
    assert.match(parsed.errors.join('\n'), /header must start with/);
  });

  test('a table with Lane but no Path column is an error', () => {
    const parsed = parseOwners(
      '| Path | Lane |\n|---|---|\n| `a/**` | x |\n\n| Lane | Owns |\n|---|---|\n| eng-store | the store |\n',
    );
    assert.match(parsed.errors.join('\n'), /line 5: table has a Lane column but no Path column/);
  });

  test('an escaped pipe is literal and shifts nothing', () => {
    const parsed = parseOwners(
      '| Path | Lane | Thread |\n|---|---|---|\n| `a/**` \\| eng-store | ui-home |\n',
    );
    assert.match(parsed.errors.join('\n'), /row has 2 cell\(s\) but the header has 3/);
    const two = parseOwners('| Path | Lane |\n|---|---|\n| `a/**` \\| eng-store | ui-home |\n');
    assert.deepEqual(two.errors, []);
    assert.equal(owner(two, 'a/x'), 'ui-home');
  });

  test('lane names must be slugs or *', () => {
    const parsed = parseOwners(
      '| Path | Lane |\n|---|---|\n| `a/**` | eng-store (assumed) |\n| `b/**` | ** |\n| `c/**` | Not A Lane |\n| `d/**` | ok-lane |\n',
    );
    assert.equal(parsed.errors.filter(e => /invalid lane/.test(e)).length, 3);
  });

  test('built-in shared files can be overridden by an explicit row', () => {
    const parsed = parseOwners(
      '| Path | Lane |\n|---|---|\n| `PROGRESS.md` | integrator |\n| `a/**` | web |\n',
    );
    assert.equal(owner(parsed, 'PROGRESS.md'), 'integrator');
    assert.equal(owner(parsed, 'DECISIONS.md'), '*');
  });

  test('the Integrator layout parses: lane-first tables, threads from headings, except notes, round 2', () => {
    const text = `# Path ownership

## Platform and website thread

| Lane | Paths |
|---|---|
| \`plat-ci\` | \`tools/lint/**\` (except \`design/\`), \`package.json\` (scripts), \`tsconfig*.json\` at the root and in \`apps/desktop/\`. In Phase 0 \`ui-foundation\` and \`renderer/data/**\` are mentioned. |
| \`web\` | \`apps/web/**\` |

## UI-core thread

| Lane | Paths |
|---|---|
| \`ui-foundation\` | \`tools/lint/design/**\` |

## Providers thread

| Lane | Paths |
|---|---|
| Round 2 (reserved, nobody edits this round) | \`prov-imap\`: \`apps/desktop/src/host/providers/imap/**\`; the CalDAV half: \`apps/desktop/src/host/providers/caldav/**\`. Today's \`apps/desktop/src/main/jmap.ts\` stays. |

## Integrator

| Owner | Paths |
|---|---|
| \`integrator\` | \`plans/**\` |

## Shared files

| File | Rule |
|---|---|
| \`mockups/**\` | Read-only. |
`;
    const parsed = parseOwners(text);
    assert.deepEqual(parsed.errors, []);
    assert.equal(owner(parsed, 'tools/lint/a.mjs'), 'plat-ci');
    assert.equal(owner(parsed, 'tools/lint/design/a.mjs'), 'ui-foundation');
    assert.equal(owner(parsed, 'design/x'), null);
    assert.equal(owner(parsed, 'renderer/data/x'), null);
    assert.equal(owner(parsed, 'apps/desktop/anything'), null);
    assert.equal(owner(parsed, 'apps/desktop/src/host/providers/imap/a.ts'), 'prov-imap');
    assert.equal(owner(parsed, 'apps/desktop/src/host/providers/caldav/a.ts'), 'reserved');
    assert.equal(owner(parsed, 'apps/desktop/src/main/jmap.ts'), null);
    assert.equal(owner(parsed, 'mockups/a.png'), null);
    assert.equal(owner(parsed, 'plans/STATUS.md'), '*');
    assert.equal(owner(parsed, 'plans/x.md'), 'integrator');
    assert.deepEqual(
      [...parsed.laneThread],
      [
        ['plat-ci', 'Platform and website'],
        ['web', 'Platform and website'],
        ['ui-foundation', 'UI-core'],
      ],
    );
    assert.ok(parsed.warnings.length >= 1);
  });

  test('rv/thread/integrator acts as the lane integrator without a Thread column', () => {
    const dir = makeRepo({
      branch: 'rv/thread/integrator',
      owners:
        '## Integrator\n\n| Owner | Paths |\n|---|---|\n| `integrator` | `plans/**` |\n| `web` | `apps/web/**` |\n',
    });
    commit(dir, { 'plans/a.md': 'a' });
    const res = check(dir);
    assert.equal(res.code, 0, res.out + res.err);
    assert.match(res.out, /acting lane\(s\) integrator;/);
  });
});
