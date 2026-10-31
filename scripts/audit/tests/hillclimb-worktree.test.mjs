// Worktree-plumbing hardening: real temp git repos exercising the anti-tamper measures
// an attempt agent could otherwise exploit — hunk-accurate added-lines parsing, binary
// classification, case/unicode tree collisions, the shared-git-dir snapshot, the safety
// -c flags on every harness git call, and the node_modules write-through scan.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathCollisions } from '../hillclimb/diffguard.mjs';
import * as WT from '../hillclimb/worktree.mjs';
import {
  addedLines,
  addWorktree,
  assertDedicatedClone,
  binaryPaths,
  blobSize,
  commitAll,
  currentHead,
  diffBetween,
  findModuleChanges,
  gitDirChanges,
  indexFlagViolations,
  linkNodeModules,
  lsTreePaths,
  mainCheckoutIntact,
  removeWorktree,
  snapshotGitDir,
  snapshotModuleTrees,
  statusPorcelain,
} from '../hillclimb/worktree.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-wt-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function freshRepo() {
  const dir = join(tmp, `r${seq++}`);
  mkdirSync(dir, { recursive: true });
  const g = (args, options) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', ...options });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.name', 't']);
  g(['config', 'user.email', 't@t']);
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  const head = () => g(['rev-parse', 'HEAD']).trim();
  const commit = message => {
    g(['add', '-A']);
    g(['commit', '-qm', message]);
    return head();
  };
  return { dir, g, head, commit };
}

describe('addedLines hunk parsing', () => {
  it('captures added lines that themselves begin with ++', () => {
    const r = freshRepo();
    const base = r.head();
    // A line literally starting with "++" diffs as "+++x..." — a naive
    // !startsWith('+++') filter drops it and the directive it carries escapes review.
    writeFileSync(join(r.dir, 'a.ts'), '++x; // eslint-disable-line\n');
    const sha = r.commit('work');
    assert.deepEqual(addedLines(r.dir, base, sha), ['++x; // eslint-disable-line']);
  });

  it('keeps +++ headers out while still catching directive lines in later hunks', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, 'a.ts'), 'one\ntwo\nthree\n');
    const base = r.commit('seed');
    writeFileSync(join(r.dir, 'a.ts'), 'one\n// @ts-ignore\ntwo\nthree\nfour\n');
    const sha = r.commit('work');
    assert.deepEqual(addedLines(r.dir, base, sha), ['// @ts-ignore', 'four']);
  });

  it('reads added text inside files git would otherwise report as binary', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, 'data.bin'), Buffer.from([0x41, 0x00, 0x0a])); // 'A\0\n'
    const base = r.commit('seed');
    writeFileSync(
      join(r.dir, 'data.bin'),
      Buffer.from('A\0\n// eslint-disable-next-line\n', 'latin1'),
    );
    const sha = r.commit('work');
    const lines = addedLines(r.dir, base, sha);
    assert.ok(lines.some(line => line.includes('eslint-disable')));
  });
});

describe('explicit head pinning', () => {
  it('diffBetween and addedLines use the given sha, not a movable HEAD', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, 'a.ts'), 'one\n');
    const sha1 = r.commit('c1');
    writeFileSync(join(r.dir, 'a.ts'), 'two\n');
    const sha2 = r.commit('c2');
    // HEAD sits at sha2; asking for sha1 must yield the empty diff.
    assert.deepEqual(diffBetween(r.dir, sha1, sha1), []);
    assert.deepEqual(addedLines(r.dir, sha1, sha1), []);
    assert.deepEqual(
      diffBetween(r.dir, sha1, sha2).map(c => c.path),
      ['a.ts'],
    );
    assert.deepEqual(addedLines(r.dir, sha1, sha2), ['two']);
  });
});

describe('binaryPaths', () => {
  it('lists files git classifies as binary (numstat "-\t-")', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, 'a.txt'), 'text\n');
    writeFileSync(join(r.dir, 'b.bin'), Buffer.from([1, 0, 2]));
    const base = r.commit('seed');
    writeFileSync(join(r.dir, 'a.txt'), 'text\nmore\n');
    writeFileSync(join(r.dir, 'b.bin'), Buffer.from([1, 0, 2, 3]));
    const sha = r.commit('work');
    assert.deepEqual(binaryPaths(r.dir, base, sha), ['b.bin']);
  });
});

describe('tree listings and collisions', () => {
  it('lsTreePaths + pathCollisions catch a case-folding/unicode colliding commit', () => {
    const r = freshRepo();
    // A case-folding checkout can never hold both of these files, but a commit can —
    // build the tree in the object store without checking it out.
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: r.dir,
      encoding: 'utf8',
      input: 'x\n',
    }).trim();
    const entry = name => `100644 blob ${blob}\t${name}`;
    // mktree, not the index: core.precomposeunicode would fold the NFD name back to NFC.
    const srcTree = execFileSync('git', ['mktree'], {
      cwd: r.dir,
      encoding: 'utf8',
      input: `${[
        entry('Foo.test.ts'),
        entry('foo.test.ts'),
        entry('café.ts'), // NFC
        entry('café.ts'), // NFD e + combining acute
      ].join('\n')}\n`,
    }).trim();
    const tree = execFileSync('git', ['mktree'], {
      cwd: r.dir,
      encoding: 'utf8',
      input: `040000 tree ${srcTree}\tsrc\n`,
    }).trim();
    const sha = execFileSync('git', ['commit-tree', tree, '-m', 'collide'], {
      cwd: r.dir,
      encoding: 'utf8',
    }).trim();
    const collisions = pathCollisions(lsTreePaths(r.dir, sha));
    assert.ok(
      collisions.some(([a, b]) => a === 'src/Foo.test.ts' && b === 'src/foo.test.ts'),
      JSON.stringify(collisions),
    );
    assert.ok(
      collisions.some(([a, b]) => a !== b && a.normalize('NFC') === b.normalize('NFC')),
      JSON.stringify(collisions),
    );
  });
});

describe('indexFlagViolations -z parsing', () => {
  it('reports flagged paths containing quotes or spaces unmangled', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, 'we"ird name.txt'), 'x\n');
    r.g(['add', '-A']);
    r.g(['commit', '-qm', 'w']);
    r.g(['update-index', '--assume-unchanged', 'we"ird name.txt']);
    assert.deepEqual(indexFlagViolations(r.dir), ['we"ird name.txt']);
  });
});

describe('blobSize', () => {
  it('returns committed bytes or null', () => {
    const r = freshRepo();
    assert.equal(blobSize(r.dir, r.head(), 'f.txt'), 5); // 'base\n'
    assert.equal(blobSize(r.dir, r.head(), 'nope'), null);
  });
});

describe('harness git environment', () => {
  it('never runs a filter.*.clean trap defined in the user-global gitconfig', () => {
    const r = freshRepo();
    const home = mkdtempSync(join(tmpdir(), 'hillclimb-home-'));
    const marker = join(home, 'filter-fired');
    const trap = join(home, 'trap.sh');
    writeFileSync(trap, `#!/bin/sh\ncat\ntouch "${marker}"\n`, { mode: 0o755 });
    writeFileSync(join(home, '.gitconfig'), `[filter "x"]\n\tclean = ${trap}\n`);
    // Route .txt files through the trap; only the global config defines the filter.
    writeFileSync(join(r.dir, '.gitattributes'), '*.txt filter=x\n');
    writeFileSync(join(r.dir, 'routed.txt'), 'payload\n');
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      commitAll(r.dir, 'attempt'); // git add -A under the harness's dedicated env
    } finally {
      process.env.HOME = prev;
    }
    assert.equal(existsSync(marker), false, 'global filter.clean command ran');
    rmSync(home, { recursive: true, force: true });
  });
});

describe('harness git safety flags', () => {
  it('never runs repo-configured diff.external or core.fsmonitor commands', () => {
    const r = freshRepo();
    const marker = join(tmp, `fired-${seq}`);
    const evil = join(tmp, `evil-${seq}.sh`);
    writeFileSync(evil, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(r.dir, 'a.ts'), 'x\n');
    const sha = r.commit('work');
    // Set the traps only after the commit, so the marker can only have been created by
    // the harness git calls below.
    r.g(['config', 'diff.external', evil]);
    r.g(['config', 'core.fsmonitor', evil]);
    addedLines(r.dir, `${sha}~1`, sha);
    diffBetween(r.dir, `${sha}~1`, sha);
    binaryPaths(r.dir, `${sha}~1`, sha);
    statusPorcelain(r.dir);
    assert.equal(existsSync(marker), false, 'external command ran');
  });
});

describe('snapshotGitDir', () => {
  it('detects config, hook, info, ref and HEAD tampering; ignores hillclimb refs', () => {
    const r = freshRepo();
    const s0 = snapshotGitDir(r.dir);
    const changed = () => gitDirChanges(s0, snapshotGitDir(r.dir));
    assert.deepEqual(snapshotGitDir(r.dir), s0, 'stable when untouched');
    assert.deepEqual(changed(), [], 'no component differs');

    r.g(['config', 'core.fsmonitor', 'true']);
    assert.deepEqual(changed(), ['config'], 'config change named');
    r.g(['config', '--unset', 'core.fsmonitor']);
    assert.deepEqual(snapshotGitDir(r.dir), s0, 'restored config');

    writeFileSync(join(r.dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    assert.deepEqual(changed(), ['hooks'], 'added hook named');
    rmSync(join(r.dir, '.git', 'hooks', 'pre-commit'));

    writeFileSync(join(r.dir, '.git', 'info', 'attributes'), '* text=auto\n');
    assert.deepEqual(changed(), ['info'], 'added info/attributes named');
    rmSync(join(r.dir, '.git', 'info', 'attributes'));

    // Only main + revamp are hashed: a sibling thread committing to its own branch
    // mid-attempt is normal progress, not a breach — the snapshot must not move.
    r.g(['update-ref', 'refs/heads/evil', 'HEAD']);
    assert.deepEqual(snapshotGitDir(r.dir), s0, 'unrelated refs are outside the snapshot');
    r.g(['update-ref', '-d', 'refs/heads/evil']);

    r.g(['update-ref', 'refs/heads/revamp', 'HEAD']);
    assert.deepEqual(changed(), ['refs'], 'revamp appearing named under refs');
    r.g(['update-ref', '-d', 'refs/heads/revamp']);
    assert.deepEqual(snapshotGitDir(r.dir), s0, 'revamp restored');

    const mainTip = r.g(['rev-parse', 'refs/heads/main']).trim();
    r.g(['commit', '--allow-empty', '-qm', 'moved']);
    assert.deepEqual(changed(), ['refs'], 'main moved named under refs');
    r.g(['update-ref', 'refs/heads/main', mainTip]);
    assert.deepEqual(snapshotGitDir(r.dir), s0, 'main restored');

    // The harness's own branches move constantly and must not trip the check.
    r.g(['update-ref', 'refs/heads/hillclimb/demo/r1/a1', 'HEAD']);
    assert.deepEqual(snapshotGitDir(r.dir), s0, 'hillclimb refs are exempt');

    const branch = r.g(['symbolic-ref', 'HEAD']).trim();
    r.g(['symbolic-ref', 'HEAD', 'refs/heads/hillclimb/demo/r1/a1']);
    assert.deepEqual(changed(), ['worktree-HEAD'], 'HEAD repoint named');
    r.g(['symbolic-ref', 'HEAD', branch]);
    assert.deepEqual(snapshotGitDir(r.dir), s0, 'HEAD restored');
    r.g(['update-ref', '-d', 'refs/heads/hillclimb/demo/r1/a1']);
  });
});

describe('module tree snapshot + diff', () => {
  // utimesSync takes float seconds — dividing the lstat ms values preserves the
  // nanosecond precision a millisecond-truncating Date would lose.
  const restoreTimes = (path, before) =>
    utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000);

  it('reports writes, prunes caches, follows symlinked dirs once', () => {
    const dir = join(tmp, `scan${seq++}`);
    const mods = join(dir, 'node_modules');
    mkdirSync(join(mods, 'tool'), { recursive: true });
    mkdirSync(join(mods, '.cache'), { recursive: true });
    const pkg = join(dir, 'packages', 'pkg');
    mkdirSync(join(pkg, 'lib'), { recursive: true });
    // A hoisted workspace link, like node_modules/@aplos/engine -> packages/engine.
    symlinkSync(join('..', 'packages', 'pkg'), join(mods, '@scope'), 'junction');
    writeFileSync(join(mods, 'tool', 'run.js'), 'old\n');
    writeFileSync(join(mods, '.cache', 'eslint'), 'cache\n');
    writeFileSync(join(pkg, 'lib', 'x.js'), 'x\n');
    const snap = snapshotModuleTrees([mods]);
    assert.deepEqual(findModuleChanges([mods], snap), []);

    writeFileSync(join(mods, 'tool', 'run.js'), 'hacked\n'); // direct write-through
    writeFileSync(join(mods, '.cache', 'eslint'), 'cache2\n'); // pruned, must not count
    writeFileSync(join(pkg, 'lib', 'x.js'), 'hacked\n'); // through the symlinked dir
    symlinkSync(join('tool', 'run.js'), join(mods, 'alias.js')); // a fresh link
    const hits = findModuleChanges([mods], snap, { relativeTo: dir });
    assert.ok(hits.includes(join('node_modules', 'tool', 'run.js')), JSON.stringify(hits));
    assert.ok(hits.includes(join('node_modules', 'alias.js')), JSON.stringify(hits));
    assert.ok(
      hits.some(p => p.endsWith(join('lib', 'x.js'))),
      JSON.stringify(hits),
    );
    assert.ok(!hits.some(p => p.includes('.cache')), JSON.stringify(hits));
    // Older files are never reported.
    assert.ok(!hits.some(p => p.includes('f.txt')), JSON.stringify(hits));
  });

  // The evasion a pure mtime scan misses: every mutation below restores the
  // timestamps it bumps, so only a content/name baseline still sees it.
  it('catches adds, removes, renames and resizes with all mtimes restored', () => {
    const dir = join(tmp, `scan-restore${seq++}`);
    const mods = join(dir, 'node_modules');
    mkdirSync(join(mods, 'pkg', 'lib'), { recursive: true });
    writeFileSync(join(mods, 'pkg', 'index.js'), 'old\n');
    writeFileSync(join(mods, 'pkg', 'lib', 'gone.js'), 'x\n');
    writeFileSync(join(mods, 'pkg', 'lib', 'victim.js'), 'v\n');
    const snap = snapshotModuleTrees([mods]);

    // Added file; backdate the new file itself AND restore the directory mtime.
    let stat = lstatSync(join(mods, 'pkg'));
    writeFileSync(join(mods, 'pkg', 'planted.js'), 'x\n');
    restoreTimes(join(mods, 'pkg', 'planted.js'), lstatSync(join(mods, 'pkg', 'index.js')));
    restoreTimes(join(mods, 'pkg'), stat);
    // Removed file; restore the directory mtime the delete bumped.
    stat = lstatSync(join(mods, 'pkg', 'lib'));
    rmSync(join(mods, 'pkg', 'lib', 'gone.js'));
    restoreTimes(join(mods, 'pkg', 'lib'), stat);
    // Renamed file; restore the directory mtime the rename bumped.
    stat = lstatSync(join(mods, 'pkg', 'lib'));
    renameSync(join(mods, 'pkg', 'lib', 'victim.js'), join(mods, 'pkg', 'lib', 'renamed.js'));
    restoreTimes(join(mods, 'pkg', 'lib'), stat);
    // Size change; restore the FILE mtime the write bumped.
    stat = lstatSync(join(mods, 'pkg', 'index.js'));
    writeFileSync(join(mods, 'pkg', 'index.js'), 'rewritten and much longer\n');
    restoreTimes(join(mods, 'pkg', 'index.js'), stat);

    const hits = findModuleChanges([mods], snap, { relativeTo: dir });
    assert.ok(hits.includes(join('node_modules', 'pkg')), JSON.stringify(hits));
    assert.ok(hits.includes(join('node_modules', 'pkg', 'lib')), JSON.stringify(hits));
    assert.ok(hits.includes(join('node_modules', 'pkg', 'index.js')), JSON.stringify(hits));
    assert.ok(
      hits.includes(join('node_modules', 'pkg', 'lib', 'renamed.js')),
      JSON.stringify(hits),
    );
    assert.ok(!hits.some(p => p.endsWith('gone.js')), JSON.stringify(hits));
  });

  it('stays quiet on reads and on writes that never leave the worktree', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('seed');
    const mods = join(r.dir, 'node_modules');
    mkdirSync(join(mods, 'pkg'), { recursive: true });
    writeFileSync(join(mods, 'pkg', 'index.js'), 'x\n');
    const wt = join(tmp, 'wt-snap-quiet');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    linkNodeModules(r.dir, wt);
    const snap = snapshotModuleTrees([mods]);

    // A pure read of the main tree…
    assert.equal(readFileSync(join(mods, 'pkg', 'index.js'), 'utf8'), 'x\n');
    // …and writes confined to the worktree's own node_modules: a new file there
    // shares nothing with the main copy, whatever the link mode is.
    mkdirSync(join(wt, 'node_modules', 'agent-made'), { recursive: true });
    writeFileSync(join(wt, 'node_modules', 'agent-made', 'out.js'), 'y\n');
    assert.deepEqual(findModuleChanges([mods], snap), []);
    removeWorktree(r.dir, wt);
  });

  it('rejects a watched root that cannot be walked (fail-closed)', () => {
    const dir = join(tmp, `scan-badroot${seq++}`);
    mkdirSync(dir, { recursive: true });
    const missing = join(dir, 'node_modules');
    assert.throws(() => snapshotModuleTrees([missing]), /cannot snapshot/);
    // A root that vanishes AFTER the baseline is itself a difference.
    mkdirSync(missing);
    writeFileSync(join(missing, 'f.js'), 'x\n');
    const snap = snapshotModuleTrees([missing]);
    rmSync(missing, { recursive: true, force: true });
    assert.deepEqual(findModuleChanges([missing], snap), [missing]);
  });

  it('follows a symlinked .cache into its target — it cannot hide writes like a real one', () => {
    const dir = join(tmp, `scan-linkcache${seq++}`);
    const mods = join(dir, 'node_modules');
    const shared = join(dir, 'shared-cache');
    mkdirSync(join(mods, 'tool'), { recursive: true });
    mkdirSync(join(mods, '.cache'), { recursive: true }); // a REAL cache dir: pruned
    mkdirSync(join(shared, 'eslint'), { recursive: true });
    symlinkSync(join('..', 'shared-cache'), join(mods, '.vite'), 'junction');
    writeFileSync(join(mods, 'tool', 'run.js'), 'x\n');
    writeFileSync(join(mods, '.cache', 'a'), 'a\n');
    writeFileSync(join(shared, 'eslint', 'b'), 'b\n');
    const snap = snapshotModuleTrees([mods]);
    assert.deepEqual(findModuleChanges([mods], snap), []);

    writeFileSync(join(shared, 'eslint', 'b'), 'hacked\n'); // through the linked .vite
    writeFileSync(join(mods, '.cache', 'a'), 'a2\n'); // real cache: stays invisible
    const hits = findModuleChanges([mods], snap, { relativeTo: dir });
    assert.ok(
      hits.some(p => p.startsWith(join('node_modules', '.vite'))),
      `a linked cache dir hid its write: ${JSON.stringify(hits)}`,
    );
    assert.ok(!hits.some(p => p.includes('.cache')), JSON.stringify(hits));
  });

  it('walks a realistic tree fast — report the measured snapshot+diff time', () => {
    const dir = join(tmp, `scan-perf${seq++}`);
    const mods = join(dir, 'node_modules');
    // ~4k entries: a small fraction of a real install, enough to extrapolate.
    for (let d = 0; d < 80; d++) {
      mkdirSync(join(mods, `pkg${d}`, 'lib'), { recursive: true });
      for (let f = 0; f < 50; f++) {
        writeFileSync(join(mods, `pkg${d}`, 'lib', `f${f}.js`), 'x\n');
      }
    }
    let t0 = performance.now();
    const snap = snapshotModuleTrees([mods]);
    const snapMs = performance.now() - t0;
    t0 = performance.now();
    assert.deepEqual(findModuleChanges([mods], snap), []);
    const diffMs = performance.now() - t0;
    console.log(
      `  module snapshot: ${snapMs.toFixed(0)}ms baseline + ${diffMs.toFixed(0)}ms diff for ~4k entries`,
    );
    assert.ok(snapMs < 5_000 && diffMs < 5_000, `walk too slow: ${snapMs}ms/${diffMs}ms`);

    // The real fixture: this checkout's own node_modules (~36k entries) when present.
    const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
    const realMods = join(repoRoot, 'node_modules');
    if (existsSync(realMods)) {
      t0 = performance.now();
      const real = snapshotModuleTrees([realMods]);
      const realMs = performance.now() - t0;
      t0 = performance.now();
      assert.deepEqual(findModuleChanges([realMods], real), []);
      const realDiffMs = performance.now() - t0;
      console.log(
        `  module snapshot: ${realMs.toFixed(0)}ms baseline + ${realDiffMs.toFixed(0)}ms diff for the real node_modules`,
      );
    }
  });
});

describe('mainCheckoutIntact (main-checkout drift)', () => {
  it('passes an untouched checkout and detects a dirtied one', async () => {
    const r = freshRepo();
    const intact = mainCheckoutIntact(r.dir, r.head());
    await intact();
    writeFileSync(join(r.dir, 'extra.txt'), 'x');
    await assert.rejects(intact(), /dirtied during the run/);
  });

  it('detects a HEAD move', async () => {
    const r = freshRepo();
    const intact = mainCheckoutIntact(r.dir, r.head());
    writeFileSync(join(r.dir, 'extra.txt'), 'x');
    r.commit('move');
    await assert.rejects(intact(), /HEAD moved/);
  });

  it('detects a node_modules dir touch that status cannot see', async () => {
    const r = freshRepo();
    mkdirSync(join(r.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    r.commit('ignore modules');
    const intact = mainCheckoutIntact(r.dir, r.head());
    // statusPorcelain excludes node_modules, so only the dir mtime notices this touch.
    assert.equal(statusPorcelain(r.dir).length, 0);
    utimesSync(join(r.dir, 'node_modules'), new Date(), new Date(Date.now() + 10_000));
    await assert.rejects(intact(), /node_modules touched/);
  });

  it('flags a watched root swapped under its own path — root and workspace level', async () => {
    const r = freshRepo();
    // node_modules* also covers the .old spelling the swap below parks the tree under.
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules*\n');
    writeFileSync(
      join(r.dir, 'package.json'),
      '{"name":"t","private":true,"workspaces":["packages/*"]}\n',
    );
    mkdirSync(join(r.dir, 'packages', 'foo'), { recursive: true });
    writeFileSync(join(r.dir, 'packages', 'foo', 'package.json'), '{"name":"foo"}\n');
    r.commit('workspace fixture');
    const mods = join(r.dir, 'node_modules');
    const xmods = join(r.dir, 'packages', 'foo', 'node_modules');
    mkdirSync(join(mods, 'dep'), { recursive: true });
    writeFileSync(join(mods, 'dep', 'x.js'), 'x\n');
    mkdirSync(join(xmods, 'dep2'), { recursive: true });
    writeFileSync(join(xmods, 'dep2', 'y.js'), 'y\n');
    const intact = mainCheckoutIntact(r.dir, r.head());
    const ctx = {
      dir: r.dir,
      moduleRoots: [mods, xmods],
      moduleSnapshot: snapshotModuleTrees([mods, xmods]),
    };
    await intact(ctx); // clean passes

    // mv + recreate: same path, same kind, a planted file inside — but a new inode.
    // Re-baselining here would adopt the swap; the audit must treat it as a hit.
    // The recreated dir's mtime is restored too, so only the inode says anything.
    const modsTimes = lstatSync(mods);
    renameSync(mods, `${mods}.old`);
    mkdirSync(mods);
    writeFileSync(join(mods, 'planted.js'), 'p\n');
    utimesSync(mods, modsTimes.atimeMs / 1000, modsTimes.mtimeMs / 1000);
    await assert.rejects(intact(ctx), /node_modules write-through/);
    rmSync(mods, { recursive: true, force: true });
    renameSync(`${mods}.old`, mods);

    // rm -rf + mkdir on the workspace-level root: the same swap one level down.
    rmSync(xmods, { recursive: true, force: true });
    mkdirSync(xmods);
    writeFileSync(join(xmods, 'planted2.js'), 'p\n');
    await assert.rejects(intact(ctx), /node_modules write-through/);
    rmSync(xmods, { recursive: true, force: true });
    mkdirSync(join(xmods, 'dep2'), { recursive: true });
    writeFileSync(join(xmods, 'dep2', 'y.js'), 'y\n');

    // And a root simply removed mid-run is a hit, not a fresh baseline either.
    rmSync(xmods, { recursive: true, force: true });
    await assert.rejects(intact(ctx), /node_modules write-through/);
  });
});

describe('root swap by symlink to another baselined root', () => {
  const twoRoots = () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules*\n');
    writeFileSync(
      join(r.dir, 'package.json'),
      '{"name":"t","private":true,"workspaces":["packages/*"]}\n',
    );
    mkdirSync(join(r.dir, 'packages', 'foo'), { recursive: true });
    writeFileSync(join(r.dir, 'packages', 'foo', 'package.json'), '{"name":"foo"}\n');
    r.commit('workspace fixture');
    const mods = join(r.dir, 'node_modules');
    const xmods = join(r.dir, 'packages', 'foo', 'node_modules');
    mkdirSync(join(mods, 'dep'), { recursive: true });
    writeFileSync(join(mods, 'dep', 'x.js'), 'x\n');
    mkdirSync(join(xmods, 'dep2'), { recursive: true });
    writeFileSync(join(xmods, 'dep2', 'y.js'), 'y\n');
    return { r, mods, xmods, snap: snapshotModuleTrees([mods, xmods]) };
  };

  it('a root replaced by a symlink to the OTHER root is a hit, in both orders', () => {
    // The symlinked path now resolves to an inode that IS baselined — under another path.
    {
      const { mods, xmods, snap } = twoRoots();
      renameSync(xmods, `${xmods}.old`);
      symlinkSync(mods, xmods);
      assert.ok(findModuleChanges([mods, xmods], snap).includes(xmods), 'workspace root -> root');
    }
    {
      const { mods, xmods, snap } = twoRoots();
      renameSync(mods, `${mods}.old`);
      symlinkSync(xmods, mods);
      assert.ok(findModuleChanges([mods, xmods], snap).includes(mods), 'root -> workspace root');
    }
  });

  it('the same inode under a second path is baselined once and checked per path', () => {
    const { r, mods, snap } = twoRoots();
    const alias = join(r.dir, 'alias-modules');
    symlinkSync(mods, alias);
    snapshotModuleTrees([alias], snap); // an alias deliberately watched as well
    assert.deepEqual(findModuleChanges([mods, alias], snap), []);
    // An alias that was never baselined is a hit even though its inode is known.
    const stranger = join(r.dir, 'stranger-modules');
    symlinkSync(mods, stranger);
    assert.deepEqual(findModuleChanges([stranger], snap), [stranger]);
  });
});

describe('dedicated-clone preflight (assertDedicatedClone)', () => {
  it('accepts a normal clone and refuses a linked worktree', () => {
    const r = freshRepo();
    assert.doesNotThrow(() => assertDedicatedClone(r.dir));
    const linked = join(tmp, `linked${seq++}`);
    r.g(['worktree', 'add', '--detach', linked, r.head()]);
    try {
      assert.throws(
        () => assertDedicatedClone(linked),
        /dedicated clone with its own \.git.*not a linked worktree.*sandbox breach/,
      );
    } finally {
      r.g(['worktree', 'remove', '--force', linked]);
    }
  });

  it('names which shared-git-dir component changed in the breach message', async () => {
    const r = freshRepo();
    const intact = mainCheckoutIntact(r.dir, r.head());
    const ctx = { dir: r.dir, gitSnapshot: snapshotGitDir(r.dir) };
    await intact(ctx); // clean passes
    r.g(['config', 'core.fsmonitor', 'true']);
    await assert.rejects(intact(ctx), /shared git dir changed during the attempt: config/);
  });
});

describe('linkNodeModules + worktrees', () => {
  const ignoreModules = r => {
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    // linkNodeModules reads package.json for the workspace list — an empty one means
    // the root is the only link root.
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('ignore modules');
    mkdirSync(join(r.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(r.dir, 'node_modules', 'dep.txt'), 'x');
  };

  it('builds a real node_modules dir of links and hides it from status', () => {
    const r = freshRepo();
    ignoreModules(r);
    const wt = join(tmp, 'wt-link');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    const linked = linkNodeModules(r.dir, wt);
    assert.deepEqual(linked, ['.']);
    const modules = lstatSync(join(wt, 'node_modules'));
    assert.ok(modules.isDirectory() && !modules.isSymbolicLink());
    // The main checkout's file entry is a hardlink inside the real dir.
    const dep = lstatSync(join(wt, 'node_modules', 'dep.txt'));
    assert.ok(dep.isFile() && !dep.isSymbolicLink());
    assert.equal(statusPorcelain(wt).length, 0);
    removeWorktree(r.dir, wt);
  });

  it('creates a detached eval worktree at the given commit', () => {
    const r = freshRepo();
    const head = r.head();
    writeFileSync(join(r.dir, 'extra.txt'), 'x');
    r.commit('later');
    const wt = join(tmp, 'wt-eval');
    addWorktree(r.dir, { dir: wt, commit: head });
    assert.equal(currentHead(wt), head);
    assert.match(
      execFileSync('git', ['status', '--porcelain', '-b'], { cwd: wt, encoding: 'utf8' }),
      /HEAD \(no branch\)|detached/,
    );
    removeWorktree(r.dir, wt);
  });

  it('commitAll stages work but never a linked node_modules symlink', () => {
    const r = freshRepo();
    ignoreModules(r);
    const wt = join(tmp, 'wt-commit');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    linkNodeModules(r.dir, wt);
    writeFileSync(join(wt, 'count.txt'), '7\n');
    const sha = commitAll(wt, 'attempt');
    assert.ok(sha);
    const names = execFileSync('git', ['show', '--name-only', '--format=', sha], {
      cwd: wt,
      encoding: 'utf8',
    });
    assert.match(names, /count\.txt/);
    assert.doesNotMatch(names, /node_modules/);
    removeWorktree(r.dir, wt);
  });

  it('commitAll returns null on a clean worktree', () => {
    const r = freshRepo();
    const wt = join(tmp, 'wt-clean');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    assert.equal(commitAll(wt, 'nothing'), null);
    removeWorktree(r.dir, wt);
  });
});

// The hybrid layout: a real node_modules container of real package dirs whose contents
// link back to the main checkout, while every workspace name links INSIDE the worktree —
// the shape npm itself installs, and the only one npm ls accepts without "extraneous".
describe('linkNodeModules hybrid layout', () => {
  const realDir = path => lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink();

  // A fixture monorepo: workspaces @aplos/{x,y,tool,ghost}, a third-party package with a
  // bin shim and a nested node_modules dep, a workspace bin shim, and the hidden lockfile.
  function seedMonorepo(r) {
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(r.dir, 'package.json'),
      '{"name":"t","private":true,"workspaces":["packages/*"],"dependencies":{"third":"2.0.0"}}\n',
    );
    const ws = (dir, manifest, files = {}) => {
      mkdirSync(join(r.dir, 'packages', dir), { recursive: true });
      writeFileSync(join(r.dir, 'packages', dir, 'package.json'), manifest);
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(r.dir, 'packages', dir, dirname(name)), { recursive: true });
        writeFileSync(join(r.dir, 'packages', dir, name), text);
      }
    };
    ws(
      'x',
      '{"name":"@aplos/x","version":"1.0.0","main":"index.cjs","dependencies":{"dep2":"1.0.0"}}\n',
      {
        'index.cjs': 'module.exports = "v1";\n',
      },
    );
    ws('y', '{"name":"@aplos/y","version":"1.0.0","dependencies":{"@aplos/x":"1.0.0"}}\n');
    ws('tool', '{"name":"@aplos/tool","version":"1.0.0","bin":{"aplos-tool":"bin/cli.js"}}\n', {
      'bin/cli.js': '#!/usr/bin/env node\n',
    });
    // ghost is a workspace npm would link but the main tree deliberately lacks.
    ws('ghost', '{"name":"@aplos/ghost","version":"1.0.0"}\n');
    r.commit('monorepo fixture');

    const mods = join(r.dir, 'node_modules');
    mkdirSync(join(mods, 'third', 'bin'), { recursive: true });
    writeFileSync(
      join(mods, 'third', 'package.json'),
      '{"name":"third","version":"2.0.0","dependencies":{"nesteddep":"3.0.0"}}\n',
    );
    writeFileSync(join(mods, 'third', 'LICENSE'), 'fixture license\n');
    mkdirSync(join(mods, 'third', 'lib'));
    writeFileSync(join(mods, 'third', 'lib', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(mods, 'third', 'bin', 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    mkdirSync(join(mods, 'third', 'node_modules', 'nesteddep'), { recursive: true });
    writeFileSync(
      join(mods, 'third', 'node_modules', 'nesteddep', 'package.json'),
      '{"name":"nesteddep","version":"3.0.0"}\n',
    );
    mkdirSync(join(mods, '@aplos'));
    for (const name of ['x', 'y', 'tool']) {
      symlinkSync(join('..', '..', 'packages', name), join(mods, '@aplos', name), 'junction');
    }
    writeFileSync(join(mods, '.package-lock.json'), '{"lockfileVersion":3}\n');
    mkdirSync(join(mods, '.bin'));
    symlinkSync(join('..', 'third', 'bin', 'tool'), join(mods, '.bin', 'tool'));
    symlinkSync(join('..', '@aplos', 'tool', 'bin', 'cli.js'), join(mods, '.bin', 'aplos-tool'));
    // A per-workspace node_modules in main — the worktree must get the same hybrid.
    const xmods = join(r.dir, 'packages', 'x', 'node_modules');
    mkdirSync(join(xmods, '@aplos'), { recursive: true });
    symlinkSync(join('..', '..', '..', 'y'), join(xmods, '@aplos', 'y'), 'junction');
    mkdirSync(join(xmods, 'dep2'));
    writeFileSync(join(xmods, 'dep2', 'package.json'), '{"name":"dep2","version":"1.0.0"}\n');
  }

  it('builds real dirs down to each package with worktree-local workspace links', () => {
    const r = freshRepo();
    seedMonorepo(r);
    const wt = join(tmp, 'wt-hybrid');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    const linked = linkNodeModules(r.dir, wt).sort();
    assert.deepEqual(linked, ['.', 'packages/x']);

    const mods = join(wt, 'node_modules');
    // The container and every package ancestry are real dirs; contents are hardlinks, so
    // dirent-based readers (isFile/isDirectory filters) see the same tree npm installed.
    assert.ok(realDir(mods));
    assert.ok(realDir(join(mods, 'third')));
    const thirdPj = lstatSync(join(mods, 'third', 'package.json'));
    assert.ok(thirdPj.isFile() && !thirdPj.isSymbolicLink());
    // A clone has its own inode; only the hardlink fallback shares main's.
    const cloned = WT.lastLinkStats().stats.cloned > 0;
    assert.equal(
      statSync(join(mods, 'third', 'package.json')).ino ===
        statSync(join(r.dir, 'node_modules', 'third', 'package.json')).ino,
      !cloned,
      `clone=${cloned}: inode ${cloned ? 'must differ' : 'must be shared'}`,
    );
    assert.ok(realDir(join(mods, 'third', 'lib')));
    const dirents = readdirSync(join(mods, 'third'), { withFileTypes: true });
    assert.ok(dirents.find(e => e.name === 'LICENSE').isFile());
    assert.ok(dirents.find(e => e.name === 'lib').isDirectory());
    assert.equal(readFileSync(join(mods, 'third', 'LICENSE'), 'utf8'), 'fixture license\n');
    assert.ok(realDir(join(mods, 'third', 'node_modules')));
    assert.ok(realDir(join(mods, 'third', 'node_modules', 'nesteddep')));
    // Scope dirs are real too; a workspace link inside them points INTO the worktree.
    assert.ok(realDir(join(mods, '@aplos')));
    assert.equal(readlinkSync(join(mods, '@aplos', 'x')), join('..', '..', 'packages', 'x'));
    assert.equal(realpathSync(join(mods, '@aplos', 'x')), realpathSync(join(wt, 'packages', 'x')));
    // A workspace missing from the main tree is still linked, like npm would do.
    assert.equal(
      realpathSync(join(mods, '@aplos', 'ghost')),
      realpathSync(join(wt, 'packages', 'ghost')),
    );
    // The hidden lockfile comes along as a hardlinked file.
    const hiddenLock = lstatSync(join(mods, '.package-lock.json'));
    assert.ok(hiddenLock.isFile() && !hiddenLock.isSymbolicLink());
    assert.equal(JSON.parse(readFileSync(join(mods, '.package-lock.json'))).lockfileVersion, 3);
    // .bin is a real dir of per-shim links: the workspace-bound shim resolves into the
    // worktree's own workspace, the third-party one into the worktree's mirrored file.
    assert.ok(realDir(join(mods, '.bin')));
    assert.equal(
      realpathSync(join(mods, '.bin', 'aplos-tool')),
      realpathSync(join(wt, 'packages', 'tool', 'bin', 'cli.js')),
    );
    assert.equal(
      realpathSync(join(mods, '.bin', 'tool')),
      realpathSync(join(wt, 'node_modules', 'third', 'bin', 'tool')),
    );
    // The per-workspace node_modules is the same hybrid, links re-pointed inside.
    const xmods = join(wt, 'packages', 'x', 'node_modules');
    assert.ok(realDir(xmods));
    assert.ok(realDir(join(xmods, 'dep2')));
    assert.equal(realpathSync(join(xmods, '@aplos', 'y')), realpathSync(join(wt, 'packages', 'y')));
    assert.deepEqual(statusPorcelain(wt), []);
    removeWorktree(r.dir, wt);
  });

  it('is idempotent — a second pass adds nothing and changes nothing', () => {
    const r = freshRepo();
    seedMonorepo(r);
    const wt = join(tmp, 'wt-hybrid-2');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    linkNodeModules(r.dir, wt);
    const before = readlinkSync(join(wt, 'node_modules', '@aplos', 'x'));
    assert.deepEqual(linkNodeModules(r.dir, wt).sort(), ['.', 'packages/x']);
    assert.equal(readlinkSync(join(wt, 'node_modules', '@aplos', 'x')), before);
    removeWorktree(r.dir, wt);
  });

  it('always builds .bin as a real dir of per-shim links — deleting one cannot reach main', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('no workspaces');
    const mods = join(r.dir, 'node_modules');
    mkdirSync(join(mods, 'third', 'bin'), { recursive: true });
    writeFileSync(join(mods, 'third', 'bin', 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    mkdirSync(join(mods, '.bin'));
    symlinkSync(join('..', 'third', 'bin', 'tool'), join(mods, '.bin', 'tool'));
    const wt = join(tmp, 'wt-binlink');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    linkNodeModules(r.dir, wt);
    // No workspace-bound shim — .bin is STILL a real dir: a whole-dir link into main
    // would let `rm node_modules/.bin/tool` inside the attempt delete the main shim.
    assert.ok(realDir(join(wt, 'node_modules', '.bin')));
    // The shim is npm's relative form and resolves to the worktree's mirrored file.
    assert.equal(
      readlinkSync(join(wt, 'node_modules', '.bin', 'tool')),
      join('..', 'third', 'bin', 'tool'),
    );
    assert.equal(
      realpathSync(join(wt, 'node_modules', '.bin', 'tool')),
      realpathSync(join(wt, 'node_modules', 'third', 'bin', 'tool')),
    );
    rmSync(join(wt, 'node_modules', '.bin', 'tool'));
    assert.ok(existsSync(join(mods, '.bin', 'tool')), "main's .bin shim survived");
    removeWorktree(r.dir, wt);
  });

  // The defect this layout fixes: with the old whole-dir node_modules symlink, the
  // worktree's @aplos links pointed back into the MAIN checkout, so a change to a
  // workspace package was invisible to gates running in the worktree.
  it('sees a worktree-side workspace change through require.resolve', () => {
    const r = freshRepo();
    seedMonorepo(r);
    const wt = join(tmp, 'wt-isolation');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    linkNodeModules(r.dir, wt);
    writeFileSync(join(wt, 'packages', 'x', 'index.cjs'), 'module.exports = "v2";\n');
    const requireFromY = createRequire(join(wt, 'packages', 'y', 'index.cjs'));
    const resolved = requireFromY.resolve('@aplos/x');
    assert.equal(resolved, realpathSync(join(wt, 'packages', 'x', 'index.cjs')));
    assert.equal(requireFromY('@aplos/x'), 'v2');
    // The main checkout's copy is untouched and would have shadowed v2 under the old link.
    assert.equal(
      readFileSync(join(r.dir, 'packages', 'x', 'index.cjs'), 'utf8'),
      'module.exports = "v1";\n',
    );
    removeWorktree(r.dir, wt);
  });
});

// A symlink placed by hand (not via linkNodeModules) must also stay unstaged under the
// bare "node_modules" ignore form.
describe('commitAll under bare node_modules ignore', () => {
  it('never stages a node_modules symlink', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    r.commit('ignore modules');
    mkdirSync(join(r.dir, 'real-modules'), { recursive: true });
    writeFileSync(join(r.dir, 'real-modules', 'dep.txt'), 'x');
    const wt = join(tmp, 'wt-bare');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    symlinkSync(join(r.dir, 'real-modules'), join(wt, 'node_modules'), 'dir');
    writeFileSync(join(wt, 'count.txt'), '7\n');
    const sha = commitAll(wt, 'attempt');
    const names = execFileSync('git', ['show', '--name-only', '--format=', sha], {
      cwd: wt,
      encoding: 'utf8',
    });
    assert.match(names, /count\.txt/);
    assert.doesNotMatch(names, /node_modules/);
    removeWorktree(r.dir, wt);
  });
});
