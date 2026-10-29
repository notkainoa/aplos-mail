import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkDiff, isShrinkOnly, isTestPath, matchGlob } from '../hillclimb/diffguard.mjs';
import { addedLines, diffBetween } from '../hillclimb/worktree.mjs';

const ALLOWED = ['src/**', 'eslint-suppressions.json'];
const base = { allowedPaths: ALLOWED, allowedTestPaths: [] };

const ok = changes => checkDiff({ ...base, changes });
const M = (path, extra = {}) => ({
  status: 'M',
  path,
  oldMode: '100644',
  newMode: '100644',
  ...extra,
});
const A = path => ({ status: 'A', path, oldMode: '000000', newMode: '100644' });
const D = path => ({ status: 'D', path, oldMode: '100644', newMode: '000000' });

describe('checkDiff: allowedPaths', () => {
  it('accepts changes inside allowed paths', () => {
    assert.deepEqual(ok([M('src/main/a.ts'), A('src/main/new.ts')]), { ok: true });
  });

  it('rejects paths outside allowedPaths, naming each', () => {
    const result = checkDiff({ ...base, changes: [M('src/a.ts'), M('lib/b.ts'), M('docs/c.md')] });
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(' '), /lib\/b\.ts/);
    assert.match(result.reasons.join(' '), /docs\/c\.md/);
  });
});

describe('checkDiff: always-forbidden paths', () => {
  // These lose even when allowedPaths would let them through.
  const loose = { allowedPaths: ['**'], allowedTestPaths: [] };
  const forbidden = [
    'scripts/audit/hillclimb/run.mjs',
    'tools/lint/eslint-plugin-aplos.mjs',
    'apps/desktop/tools/lint/x.mjs',
    'budgets.json',
    'apps/desktop/budgets.json',
    'baseline.txt',
    'src/x-baseline-y.ts',
    'snap/foo-snapshot.png',
    'deep/golden/file.ts',
    'x/__snapshots__/a.js',
    'eslint.config.mjs',
    'apps/desktop/eslint.config.js',
    'stylelint.config.mjs',
    'stylelint-suppressions-bak.json',
    'tsconfig.json',
    'tsconfig.base.json',
    'package.json',
    'apps/desktop/package.json',
    'packages/engine/package-lock.json',
    '.github/workflows/ci.yml',
    'mockups/home.png',
    'plans/OWNERS.md',
    '.husky/pre-commit',
    'scripts/hooks/install.mjs',
    '.gitignore',
    '.gitattributes',
    'sub/.gitmodules',
  ];
  for (const path of forbidden) {
    it(`rejects ${path}`, () => {
      const result = checkDiff({ ...loose, changes: [M(path)] });
      assert.equal(result.ok, false, `expected ${path} to be rejected`);
      assert.match(result.reasons.join(' '), new RegExp(path.replace(/[.*]/g, '\\$&')));
    });
  }

  it('rejects the target config file itself', () => {
    const result = checkDiff({
      ...loose,
      configPath: 'scripts/audit/hillclimb/targets/t.json',
      changes: [M('scripts/audit/hillclimb/targets/t.json')],
    });
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(' '), /config file itself/);
  });
});

describe('checkDiff: test files', () => {
  it('rejects modifying or deleting existing tests', () => {
    for (const path of [
      'src/a.test.ts',
      'src/deep/b.spec.tsx',
      'tests/e2e/x.ts',
      'src/__tests__/y.ts',
      'packages/engine/tests/z.ts',
    ]) {
      assert.equal(ok([M(path)]).ok, false, path);
      assert.equal(ok([D(path)]).ok, false, `delete ${path}`);
    }
  });

  it('allows existing tests listed in allowedTestPaths', () => {
    // allowedTestPaths lifts the test restriction; the file must still be inside allowedPaths.
    const result = checkDiff({
      allowedPaths: ['tests/**', 'src/**'],
      allowedTestPaths: ['tests/**', 'src/**'],
      changes: [M('tests/e2e/x.ts'), M('src/a.test.ts')],
    });
    assert.equal(result.ok, true);
    const outsideAllowed = checkDiff({
      ...base,
      allowedTestPaths: ['tests/**'],
      changes: [M('tests/e2e/x.ts')],
    });
    assert.equal(outsideAllowed.ok, false);
  });

  it('allows new test files only inside allowedPaths', () => {
    assert.equal(ok([A('src/b.test.ts')]).ok, true);
    assert.equal(ok([A('tests/e2e/new.ts')]).ok, false);
  });
});

describe('checkDiff: renames touch both paths', () => {
  it('rejects a rename out of allowed paths into them', () => {
    const result = ok([
      {
        status: 'R',
        path: 'src/in.ts',
        oldPath: 'outside.ts',
        oldMode: '100644',
        newMode: '100644',
      },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(' '), /outside\.ts/);
  });

  it('rejects a rename out to a forbidden path', () => {
    const result = checkDiff({
      allowedPaths: ['**'],
      changes: [
        {
          status: 'R',
          path: 'package.json',
          oldPath: 'src/in.ts',
          oldMode: '100644',
          newMode: '100644',
        },
      ],
    });
    assert.equal(result.ok, false);
  });

  it('rejects renaming a test file away', () => {
    const result = ok([
      {
        status: 'R',
        path: 'src/renamed.ts',
        oldPath: 'src/old.test.ts',
        oldMode: '100644',
        newMode: '100644',
      },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(' '), /old\.test\.ts/);
  });
});

describe('checkDiff: modes and symlinks', () => {
  it('rejects new symlinks and gitlinks', () => {
    for (const newMode of ['120000', '160000']) {
      const result = ok([{ status: 'A', path: 'src/link', oldMode: '000000', newMode }]);
      assert.equal(result.ok, false, newMode);
    }
  });

  it('rejects executable-bit changes', () => {
    assert.equal(
      ok([{ status: 'M', path: 'src/a.sh', oldMode: '100644', newMode: '100755' }]).ok,
      false,
    );
    assert.equal(
      ok([{ status: 'M', path: 'src/a.sh', oldMode: '100755', newMode: '100644' }]).ok,
      false,
    );
    assert.equal(
      ok([{ status: 'A', path: 'src/a.sh', oldMode: '000000', newMode: '100755' }]).ok,
      false,
    );
  });
});

describe('isShrinkOnly', () => {
  const oldFile = JSON.stringify({
    'a.ts': { 'rule-x': { count: 5 }, 'rule-y': { count: 2 } },
    'b.ts': { 'rule-x': { count: 1 } },
  });
  const shrink = value => isShrinkOnly(oldFile, JSON.stringify(value));

  it('accepts pure shrinking', () => {
    assert.equal(
      shrink({
        'a.ts': { 'rule-x': { count: 3 }, 'rule-y': { count: 2 } },
        'b.ts': { 'rule-x': { count: 1 } },
      }).ok,
      true,
    );
    assert.equal(shrink({ 'a.ts': { 'rule-x': { count: 5 } } }).ok, true); // keys may vanish
    assert.equal(shrink({}).ok, true);
    assert.equal(isShrinkOnly(oldFile, oldFile).ok, true); // equal counts are still shrink-only
  });

  it('rejects added files, rules and raised counts', () => {
    assert.match(
      shrink({ 'a.ts': { 'rule-x': { count: 5 } }, 'c.ts': { 'rule-x': { count: 1 } } }).reason,
      /adds suppressions for c\.ts/,
    );
    assert.match(
      shrink({ 'a.ts': { 'rule-x': { count: 5 }, 'rule-z': { count: 1 } } }).reason,
      /adds suppressed rule rule-z/,
    );
    assert.match(
      shrink({ 'a.ts': { 'rule-x': { count: 6 }, 'rule-y': { count: 2 } } }).reason,
      /raises suppressed count/,
    );
  });

  it('rejects malformed JSON and non-integer or negative counts on both sides', () => {
    assert.match(isShrinkOnly(oldFile, '{nope').reason, /does not parse/);
    assert.match(isShrinkOnly('{nope', '{}').reason, /does not parse/);
    assert.match(isShrinkOnly('[]', '{}').reason, /not a JSON object/);
    assert.match(shrink({ 'a.ts': 'nope' }).reason, /not an object/);
    for (const bad of ['many', -1, 1.5, null, {}]) {
      assert.match(
        shrink({ 'a.ts': { 'rule-x': { count: bad } } }).reason,
        /not a non-negative integer/,
        `new count ${JSON.stringify(bad)}`,
      );
    }
    // The old side is held to the same rule, even for rules the new file keeps.
    const badOld = JSON.stringify({ 'a.ts': { 'rule-x': { count: -3 } } });
    assert.match(
      isShrinkOnly(badOld, JSON.stringify({ 'a.ts': { 'rule-x': { count: 1 } } })).reason,
      /old count.*not a non-negative integer/,
    );
  });

  it('treats a missing old file as empty, so any content is an addition', () => {
    assert.equal(isShrinkOnly(null, '{}').ok, true);
    assert.match(
      isShrinkOnly(null, JSON.stringify({ 'a.ts': { r: { count: 1 } } })).reason,
      /adds suppressions/,
    );
  });
});

describe('checkDiff: suppressions files', () => {
  const readOldFile = () => JSON.stringify({ 'a.ts': { 'rule-x': { count: 5 } } });
  it('accepts a real shrink inside allowedPaths', () => {
    const result = checkDiff({
      ...base,
      changes: [M('eslint-suppressions.json')],
      readOldFile,
      readNewFile: () => JSON.stringify({ 'a.ts': { 'rule-x': { count: 2 } } }),
    });
    assert.equal(result.ok, true);
  });

  it('rejects a raised count, a deletion and an added file', () => {
    assert.equal(
      checkDiff({
        ...base,
        changes: [M('eslint-suppressions.json')],
        readOldFile,
        readNewFile: () => JSON.stringify({ 'a.ts': { 'rule-x': { count: 9 } } }),
      }).ok,
      false,
    );
    assert.equal(
      checkDiff({ ...base, changes: [D('eslint-suppressions.json')], readOldFile }).ok,
      false,
    );
    assert.match(
      checkDiff({
        allowedPaths: ['**'],
        changes: [M('apps/desktop/stylelint-suppressions.json')],
        readOldFile,
        readNewFile: () =>
          JSON.stringify({
            'a.ts': { 'rule-x': { count: 5 } },
            'new.ts': { 'rule-x': { count: 1 } },
          }),
      }).reasons.join(' '),
      /adds suppressions for new\.ts/,
    );
  });
});

describe('matchGlob', () => {
  it('matches leading dots that node:path.matchesGlob misses', () => {
    for (const [path, glob] of [
      ['.env', '*'],
      ['a/.env', 'a/*'],
      ['src/.x', 'src/**'],
      ['.baseline', '*baseline*'],
      ['.gitignore', '.git*'],
    ]) {
      assert.equal(matchGlob(path, glob), true, `${glob} vs ${path}`);
    }
  });

  it('is case-insensitive and supports ?, classes and braces', () => {
    assert.equal(matchGlob('Makefile', 'makefile'), true);
    assert.equal(matchGlob('src/Ab.TS', 'src/*.ts'), true);
    assert.equal(matchGlob('b', '[!a]'), true);
    assert.equal(matchGlob('x/y.ts', '{x,z}/**'), true);
    assert.equal(matchGlob('deep/x', '**/x'), true);
    assert.equal(matchGlob('x', '**/x'), true);
  });
});

describe('checkDiff: normalised matching', () => {
  const loose = { allowedPaths: ['**'], allowedTestPaths: [] };

  it('rejects forbidden paths in any case', () => {
    for (const path of ['Scripts/Audit/x.mjs', 'PACKAGE.JSON', 'Tools/Lint/y.mjs', 'PLANS/z.md']) {
      const result = checkDiff({ ...loose, changes: [M(path)] });
      assert.equal(result.ok, false, path);
    }
  });

  it('rejects dotfiles that a POSIX matcher would miss — by name rule, not just scope', () => {
    for (const path of ['.baseline', 'src/.goldenx.ts', 'x/.npmrc']) {
      const result = checkDiff({ ...loose, changes: [A(path)] });
      assert.equal(result.ok, false, path);
      assert.match(result.reasons.join(' '), /forbidden/, path);
    }
  });

  it('matches dotfiles inside allowedPaths', () => {
    const result = checkDiff({ ...base, changes: [A('src/.hidden/x.ts')] });
    assert.equal(result.ok, true);
  });

  it('normalises backslashes, unicode and case before matching', () => {
    assert.equal(checkDiff({ ...loose, changes: [A('scripts\\audit\\evil.mjs')] }).ok, false);
    // NFD é must equal the NFC glob literal
    const nfc = checkDiff({ allowedPaths: ['src/café/**'], changes: [A('src/cafe\u0301/x.ts')] });
    assert.equal(nfc.ok, true);
  });

  it('rejects absolute paths and ".." segments', () => {
    for (const path of ['/etc/passwd', 'C:/windows/x', 'src/../package.json', '..\\evil']) {
      const result = checkDiff({ ...loose, changes: [A(path)] });
      assert.equal(result.ok, false, path);
      assert.match(result.reasons.join(' '), /unsafe path/);
    }
  });

  it('rejects the extended forbidden config/dotfile names', () => {
    for (const path of [
      'x/.npmrc',
      '.prettierrc.json',
      '.eslintrc.js',
      '.stylelintrc',
      '.editorconfig',
      'tsconfig.app.jsonc',
      'vitest.config.ts',
      'jest.config.js',
      'Makefile',
      'packages/eng/yarn.lock',
      '.node-version',
      '.nvmrc',
      'src/app.config.ts',
    ]) {
      const result = checkDiff({ ...loose, changes: [M(path)] });
      assert.equal(result.ok, false, path);
    }
  });
});

describe('checkDiff: suppression directives in added lines', () => {
  const changes = [M('src/a.ts')];
  const scan = (added, extra = {}) =>
    checkDiff({ ...base, changes, addedLines: added, ...extra });

  it('rejects each known directive, case-insensitively', () => {
    for (const line of [
      '  // eslint-disable-next-line no-console',
      'const x = foo(); // @TS-IGNORE',
      '// @ts-nocheck',
      '// @ts-expect-error: hmm',
      '/* istanbul ignore next */',
      '// c8 ignore start',
      '/* stylelint-disable-line */',
      '<!-- prettier-ignore -->',
    ]) {
      const result = scan([line]);
      assert.equal(result.ok, false, line);
      assert.match(result.reasons.join(' '), /suppression directive/);
    }
  });

  it('ignores context and clean added lines', () => {
    assert.equal(scan(['const a = 1;', 'suppress warnings elsewhere']).ok, true);
    assert.equal(scan([], {}).ok, true);
  });

  it('honours allowDirectives for the named directive only', () => {
    assert.equal(
      scan(['// @ts-ignore'], { allowDirectives: ['ts-ignore'] }).ok,
      true,
    );
    const result = scan(['// @ts-ignore', '// eslint-disable-next-line'], {
      allowDirectives: ['ts-ignore'],
    });
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(' '), /eslint-disable/);
  });
});

describe('isTestPath', () => {
  it('matches the spec shapes', () => {
    for (const [path, expected] of [
      ['a.test.ts', true],
      ['deep/x.spec.js', true],
      ['tests/e2e/x.ts', true],
      ['pkg/__tests__/y.ts', true],
      ['src/attest.ts', false],
      ['src/testing/foo.ts', false],
    ]) {
      assert.equal(isTestPath(path), expected, path);
    }
  });
});

describe('checkDiff: real git integration', () => {
  const repo = mkdtempSync(join(tmpdir(), 'hillclimb-diff-'));
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it('sees renames, mode bits and both sides of the diff', () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'keep.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'old.ts'), 'x\n');
    git(['init', '-q']);
    git(['add', '-A']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
    const startSha = git(['rev-parse', 'HEAD']).trim();
    git(['mv', 'old.ts', 'src/renamed.ts']);
    execFileSync('chmod', ['+x', join(repo, 'src', 'keep.ts')]);
    writeFileSync(join(repo, 'eslint.config.mjs'), 'export default [];\n');
    git(['add', '-A']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'work']);
    const changes = diffBetween(repo, startSha);
    const renamed = changes.find(change => change.status === 'R');
    assert.equal(renamed.oldPath, 'old.ts');
    assert.equal(renamed.path, 'src/renamed.ts');
    const keep = changes.find(change => change.path === 'src/keep.ts');
    assert.equal(keep.newMode, '100755');
    const result = checkDiff({ ...base, changes });
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(' '), /eslint\.config\.mjs/);
    assert.match(result.reasons.join(' '), /executable bit/);
  });

  it('feeds real added diff lines into the directive scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hillclimb-dir-'));
    const git2 = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    git2(['init', '-q']);
    git2(['add', '-A']);
    git2(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
    const baseSha = git2(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(dir, 'src', 'a.ts'), '// eslint-disable-next-line\nexport const a = 1;\n');
    git2(['add', '-A']);
    git2(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'work']);
    const result = checkDiff({
      ...base,
      changes: diffBetween(dir, baseSha),
      addedLines: addedLines(dir, baseSha),
    });
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(' '), /eslint-disable/);
    rmSync(dir, { recursive: true, force: true });
  });
});
