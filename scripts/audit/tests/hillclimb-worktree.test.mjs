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
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathCollisions } from '../hillclimb/diffguard.mjs';
import {
  addedLines,
  addWorktree,
  binaryPaths,
  blobSize,
  commitAll,
  currentHead,
  diffBetween,
  findWritesSince,
  indexFlagViolations,
  linkNodeModules,
  lsTreePaths,
  mainCheckoutIntact,
  removeWorktree,
  snapshotGitDir,
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
    assert.equal(snapshotGitDir(r.dir), s0, 'stable when untouched');

    r.g(['config', 'core.fsmonitor', 'true']);
    assert.notEqual(snapshotGitDir(r.dir), s0, 'config change');
    r.g(['config', '--unset', 'core.fsmonitor']);
    assert.equal(snapshotGitDir(r.dir), s0, 'restored config');

    writeFileSync(join(r.dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    assert.notEqual(snapshotGitDir(r.dir), s0, 'added hook');
    rmSync(join(r.dir, '.git', 'hooks', 'pre-commit'));

    writeFileSync(join(r.dir, '.git', 'info', 'attributes'), '* text=auto\n');
    assert.notEqual(snapshotGitDir(r.dir), s0, 'added info/attributes');
    rmSync(join(r.dir, '.git', 'info', 'attributes'));

    // Only main + revamp are hashed: a sibling thread committing to its own branch
    // mid-attempt is normal progress, not a breach — the snapshot must not move.
    r.g(['update-ref', 'refs/heads/evil', 'HEAD']);
    assert.equal(snapshotGitDir(r.dir), s0, 'unrelated refs are outside the snapshot');
    r.g(['update-ref', '-d', 'refs/heads/evil']);

    r.g(['update-ref', 'refs/heads/revamp', 'HEAD']);
    assert.notEqual(snapshotGitDir(r.dir), s0, 'revamp appeared');
    r.g(['update-ref', '-d', 'refs/heads/revamp']);
    assert.equal(snapshotGitDir(r.dir), s0, 'revamp restored');

    const mainTip = r.g(['rev-parse', 'refs/heads/main']).trim();
    r.g(['commit', '--allow-empty', '-qm', 'moved']);
    assert.notEqual(snapshotGitDir(r.dir), s0, 'main moved');
    r.g(['update-ref', 'refs/heads/main', mainTip]);
    assert.equal(snapshotGitDir(r.dir), s0, 'main restored');

    // The harness's own branches move constantly and must not trip the check.
    r.g(['update-ref', 'refs/heads/hillclimb/demo/r1/a1', 'HEAD']);
    assert.equal(snapshotGitDir(r.dir), s0, 'hillclimb refs are exempt');

    const branch = r.g(['symbolic-ref', 'HEAD']).trim();
    r.g(['symbolic-ref', 'HEAD', 'refs/heads/hillclimb/demo/r1/a1']);
    assert.notEqual(snapshotGitDir(r.dir), s0, 'HEAD repointed');
    r.g(['symbolic-ref', 'HEAD', branch]);
    assert.equal(snapshotGitDir(r.dir), s0, 'HEAD restored');
    r.g(['update-ref', '-d', 'refs/heads/hillclimb/demo/r1/a1']);
  });
});

describe('findWritesSince', () => {
  it('reports files newer than the stamp, prunes caches, follows symlinked dirs once', () => {
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
    const stamp = join(dir, 'stamp');
    writeFileSync(stamp, '');
    assert.deepEqual(findWritesSince([mods], stamp), []);

    writeFileSync(join(mods, 'tool', 'run.js'), 'hacked\n'); // direct write-through
    writeFileSync(join(mods, '.cache', 'eslint'), 'cache2\n'); // pruned, must not count
    writeFileSync(join(pkg, 'lib', 'x.js'), 'hacked\n'); // through the symlinked dir
    symlinkSync(join('tool', 'run.js'), join(mods, 'alias.js')); // a fresh link
    const hits = findWritesSince([mods], stamp, { relativeTo: dir });
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

  it('links the root node_modules and hides it from status', () => {
    const r = freshRepo();
    ignoreModules(r);
    const wt = join(tmp, 'wt-link');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    const linked = linkNodeModules(r.dir, wt);
    assert.deepEqual(linked, ['.']);
    assert.ok(lstatSync(join(wt, 'node_modules')).isSymbolicLink());
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
