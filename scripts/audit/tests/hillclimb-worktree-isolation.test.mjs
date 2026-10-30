// Worktree node_modules isolation: real temp git repos for the review-hardening — the
// fail-closed link-set verification (committed node_modules, whole-dir symlinks, escaping
// or stale workspace links, the workdir-derived workspace map), the clone-first file
// strategy with its hardlink tripwire fallback, removeWorktree's run-root guard, the
// write scan's delete/add detection via directory mtimes, and the integrator's lock-in
// checks (cross-workspace module identity, npm ls on the mirrored tree).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import * as WT from '../hillclimb/worktree.mjs';
import {
  addWorktree,
  findModuleChanges,
  linkNodeModules,
  removeWorktree,
  snapshotModuleTrees,
} from '../hillclimb/worktree.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-iso-'));
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

// The write scan must see what file mtimes cannot say: a delete or add only bumps the
// OWNING directory, so each scanned directory's name-hash comparison reports it.
describe('module tree diff detects deletes and additions', () => {
  it('reports the directory a shim or package file vanished from (and one planted in)', () => {
    const dir = join(tmp, `scan-del${seq++}`);
    const mods = join(dir, 'node_modules');
    mkdirSync(join(mods, '.bin'), { recursive: true });
    mkdirSync(join(mods, 'third', 'lib'), { recursive: true });
    writeFileSync(join(mods, '.bin', 'tool'), 'x');
    writeFileSync(join(mods, 'third', 'lib', 'index.js'), 'x');
    const snap = snapshotModuleTrees([mods]);
    assert.deepEqual(findModuleChanges([mods], snap), []);

    rmSync(join(mods, '.bin', 'tool')); // a deleted .bin shim
    rmSync(join(mods, 'third', 'lib', 'index.js')); // a deleted package file
    writeFileSync(join(mods, 'third', 'planted.js'), 'x'); // an added file
    const hits = findModuleChanges([mods], snap, { relativeTo: dir });
    assert.ok(hits.includes(join('node_modules', '.bin')), JSON.stringify(hits));
    assert.ok(hits.includes(join('node_modules', 'third', 'lib')), JSON.stringify(hits));
    assert.ok(hits.includes(join('node_modules', 'third')), JSON.stringify(hits));
    // The vanished files cannot be named — the directories are the evidence.
    assert.ok(!hits.some(p => p.endsWith('tool') || p.endsWith('index.js')), JSON.stringify(hits));
  });
});

// Fail-closed checks at the end of linkNodeModules: a committed node_modules, a whole-dir
// symlink, a stale workspace link or an escaping workspace link all refuse the worktree.
describe('linkNodeModules fail-closed verification', () => {
  const linkExists = p => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };

  it('throws when node_modules paths are committed into the repo', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    mkdirSync(join(r.dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(r.dir, 'node_modules', 'pkg', 'index.js'), 'x\n');
    // node_modules is ignored but force-added — exactly what the verify check guards.
    r.g(['add', '-f', 'node_modules', 'package.json', '.gitignore']);
    r.g(['commit', '-qm', 'committed modules']);
    const wt = join(tmp, 'wt-committed-mods');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    assert.throws(() => linkNodeModules(r.dir, wt), /committed node_modules/);
    removeWorktree(r.dir, wt);
  });

  it('throws on a committed node_modules symlink (could resolve into main)', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('seed');
    mkdirSync(join(r.dir, 'real-mods'), { recursive: true });
    writeFileSync(join(r.dir, 'real-mods', 'x.txt'), 'x');
    symlinkSync('real-mods', join(r.dir, 'node_modules'), 'dir');
    r.g(['add', '-f', 'node_modules']);
    r.g(['commit', '-qm', 'committed modules link']);
    const wt = join(tmp, 'wt-committed-link');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    assert.throws(() => linkNodeModules(r.dir, wt), /committed node_modules|symlink/);
    removeWorktree(r.dir, wt);
  });

  it('throws when a linked node_modules root is a whole-dir symlink', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('seed');
    mkdirSync(join(r.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(r.dir, 'node_modules', 'dep.txt'), 'x');
    const wt = join(tmp, 'wt-root-link');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    // A planted whole-dir link — never committed, but the verify pass must refuse it.
    symlinkSync(join(r.dir, 'node_modules'), join(wt, 'node_modules'), 'dir');
    assert.throws(() => linkNodeModules(r.dir, wt), /is a symlink/);
    removeWorktree(r.dir, wt);
  });

  it('throws when a workspace link resolves outside the worktree', () => {
    const r = freshRepo();
    const outsidePkgs = join(tmp, 'outside-pkgs');
    mkdirSync(join(outsidePkgs, 'x'), { recursive: true });
    writeFileSync(join(outsidePkgs, 'x', 'package.json'), '{"name":"@aplos/x"}\n');
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(r.dir, 'package.json'),
      '{"name":"t","private":true,"workspaces":["packages/*"]}\n',
    );
    // "packages" itself is a committed symlink OUT of the repo: the worktree materializes
    // it, the workdir-derived map still picks x up through it, and the resulting
    // node_modules/@aplos/x link then resolves outside the worktree.
    symlinkSync(outsidePkgs, join(r.dir, 'packages'), 'dir');
    r.g(['add', '-f', 'packages', 'package.json', '.gitignore']);
    r.g(['commit', '-qm', 'escaping workspace']);
    const mods = join(r.dir, 'node_modules', '@aplos');
    mkdirSync(mods, { recursive: true });
    symlinkSync(join('..', '..', 'packages', 'x'), join(mods, 'x'), 'junction');
    const wt = join(tmp, 'wt-escape');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    assert.throws(() => linkNodeModules(r.dir, wt), /escapes the worktree/);
    removeWorktree(r.dir, wt);
  });

  it('throws on a workspace link planted after checkout that escapes', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(r.dir, 'package.json'),
      '{"name":"t","private":true,"workspaces":["packages/*"]}\n',
    );
    mkdirSync(join(r.dir, 'packages', 'x'), { recursive: true });
    writeFileSync(join(r.dir, 'packages', 'x', 'package.json'), '{"name":"@aplos/x"}\n');
    r.commit('ws');
    mkdirSync(join(r.dir, 'node_modules', '@aplos'), { recursive: true });
    const wt = join(tmp, 'wt-planted-ws');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    // Planted uncommitted, under a dir populate will not replace: the verify sweep must
    // still find it — a link here resolves packages for the whole worktree.
    const scope = join(wt, 'node_modules', '@aplos');
    mkdirSync(scope, { recursive: true });
    symlinkSync(tmp, join(scope, 'x'), 'junction'); // resolves outside the worktree
    assert.throws(() => linkNodeModules(r.dir, wt), /escapes the worktree/);
    removeWorktree(r.dir, wt);
  });

  it("throws on a .bin shim planted in the worktree resolving into main's source tree", () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(r.dir, 'package.json'),
      '{"name":"t","private":true,"workspaces":["packages/*"]}\n',
    );
    mkdirSync(join(r.dir, 'packages', 'engine', 'bin'), { recursive: true });
    writeFileSync(join(r.dir, 'packages', 'engine', 'package.json'), '{"name":"@aplos/engine"}\n');
    writeFileSync(join(r.dir, 'packages', 'engine', 'bin', 'cli.js'), '#!/usr/bin/env node\n');
    r.commit('ws');
    mkdirSync(join(r.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(r.dir, 'node_modules', 'dep.txt'), 'x\n');
    const wt = join(tmp, 'wt-bin-evil');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    // A shim planted where the old sweep never looked: inside .bin, aimed at the main
    // checkout's SOURCE tree — read-side espionage and a write-through path in one.
    const bin = join(wt, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(join(r.dir, 'packages', 'engine', 'bin', 'cli.js'), join(bin, 'evil-tool'));
    assert.throws(() => linkNodeModules(r.dir, wt), /escapes the worktree/);
    removeWorktree(r.dir, wt);
  });

  it("throws on a nested package link resolving into main's source tree", () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(r.dir, 'package.json'),
      '{"name":"t","private":true,"workspaces":["packages/*"]}\n',
    );
    mkdirSync(join(r.dir, 'packages', 'engine'), { recursive: true });
    writeFileSync(join(r.dir, 'packages', 'engine', 'package.json'), '{"name":"@aplos/engine"}\n');
    r.commit('ws');
    mkdirSync(join(r.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(r.dir, 'node_modules', 'dep.txt'), 'x\n');
    const wt = join(tmp, 'wt-nested-evil');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    // Buried under a package's own node_modules — below the old sweep's top level.
    const nested = join(wt, 'node_modules', 'deep', 'node_modules');
    mkdirSync(nested, { recursive: true });
    symlinkSync(join(r.dir, 'packages', 'engine'), join(nested, 'evil'), 'junction');
    assert.throws(() => linkNodeModules(r.dir, wt), /escapes the worktree/);
    removeWorktree(r.dir, wt);
  });

  it('allows a link resolving inside a linked main node_modules tree', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('seed');
    const mods = join(r.dir, 'node_modules');
    mkdirSync(mods, { recursive: true });
    writeFileSync(join(mods, 'real.js'), 'x\n');
    const wt = join(tmp, 'wt-abslink');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    // The allow-list in action: a link resolving into the REAL main node_modules tree
    // this worktree linked from is deliberate — the shape a verbatim-copied absolute
    // shim keeps — not an escape into main's source dirs.
    mkdirSync(join(wt, 'node_modules'), { recursive: true });
    symlinkSync(join(realpathSync(mods), 'real.js'), join(wt, 'node_modules', 'keep'));
    linkNodeModules(r.dir, wt);
    assert.equal(
      realpathSync(join(wt, 'node_modules', 'keep')),
      realpathSync(join(mods, 'real.js')),
      'resolves inside the linked main node_modules — allowed',
    );
    removeWorktree(r.dir, wt);
  });

  it('allows a dangling link whose logical target stays inside the worktree', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('seed');
    mkdirSync(join(r.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(r.dir, 'node_modules', 'dep.txt'), 'x\n');
    const wt = join(tmp, 'wt-dangle');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    // Mirrors a dangling shim copied verbatim from main: the logical target never
    // leaves the worktree, so the link is harmless — and must not fail the verify.
    const bin = join(wt, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(join('..', 'gone-pkg', 'bin', 'tool'), join(bin, 'gone'));
    linkNodeModules(r.dir, wt);
    assert.ok(lstatSync(join(bin, 'gone')).isSymbolicLink());
    removeWorktree(r.dir, wt);
  });

  it('linkWorkspace refuses a workspace dir the worktree lacks', () => {
    const r = freshRepo();
    const wt = join(tmp, 'wt-missing-ws');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    assert.equal(typeof WT.linkWorkspace, 'function');
    assert.throws(
      () => WT.linkWorkspace(join(wt, 'node_modules', '@x'), wt, 'packages/nope', { wsLinks: [] }),
      /missing in the worktree/,
    );
    removeWorktree(r.dir, wt);
  });

  it('reads the workspace map from the worktree: added ws linked, stale ws dropped', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(r.dir, 'package.json'),
      '{"name":"t","private":true,"workspaces":["packages/*"]}\n',
    );
    mkdirSync(join(r.dir, 'packages', 'x'), { recursive: true });
    writeFileSync(join(r.dir, 'packages', 'x', 'package.json'), '{"name":"@aplos/x"}\n');
    mkdirSync(join(r.dir, 'packages', 'y'), { recursive: true });
    writeFileSync(join(r.dir, 'packages', 'y', 'package.json'), '{"name":"@aplos/y"}\n');
    r.commit('two workspaces');
    const mods = join(r.dir, 'node_modules', '@aplos');
    mkdirSync(mods, { recursive: true });
    symlinkSync(join('..', '..', 'packages', 'x'), join(mods, 'x'), 'junction');
    symlinkSync(join('..', '..', 'packages', 'y'), join(mods, 'y'), 'junction');
    const wt = join(tmp, 'wt-map-src');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    // The attempt renames a workspace: packages/x goes away, packages/new arrives.
    mkdirSync(join(wt, 'packages', 'new'), { recursive: true });
    writeFileSync(join(wt, 'packages', 'new', 'package.json'), '{"name":"@aplos/new"}\n');
    rmSync(join(wt, 'packages', 'x'), { recursive: true, force: true });
    linkNodeModules(r.dir, wt);
    // The added workspace gets a correct link into the worktree…
    assert.equal(
      realpathSync(join(wt, 'node_modules', '@aplos', 'new')),
      realpathSync(join(wt, 'packages', 'new')),
    );
    // …and the stale one must not survive — not even as a dangling link into main's tree.
    assert.equal(linkExists(join(wt, 'node_modules', '@aplos', 'x')), false);
    assert.ok(linkExists(join(wt, 'node_modules', '@aplos', 'y')));
    removeWorktree(r.dir, wt);
  });
});

// removeWorktree: the rmSync fallback only ever runs inside a hillclimb-* run root.
describe('removeWorktree refuses paths outside a run root', () => {
  it('refuses an outside dir, a symlink and the main checkout itself', () => {
    const r = freshRepo();
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    assert.throws(() => removeWorktree(r.dir, outside), /refusing to remove/);
    assert.ok(existsSync(outside), 'refused dir survived');
    assert.throws(() => removeWorktree(r.dir, r.dir), /refusing to remove/);
    assert.ok(existsSync(join(r.dir, 'f.txt')), 'main checkout survived');
    const linkp = join(tmp, 'wt-symlink-refuse');
    symlinkSync(r.dir, linkp, 'dir');
    assert.throws(() => removeWorktree(r.dir, linkp), /symlink/);
    assert.ok(lstatSync(linkp).isSymbolicLink(), 'the link itself survived');
    rmSync(outside, { recursive: true, force: true });
  });

  it('removes a worktree inside a run root and leaves main node_modules byte-identical', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(r.dir, 'package.json'),
      '{"name":"t","private":true,"workspaces":["packages/*"]}\n',
    );
    mkdirSync(join(r.dir, 'packages', 'x'), { recursive: true });
    writeFileSync(join(r.dir, 'packages', 'x', 'package.json'), '{"name":"@aplos/x"}\n');
    r.commit('fixture');
    const mods = join(r.dir, 'node_modules');
    mkdirSync(join(mods, 'third', 'lib'), { recursive: true });
    writeFileSync(join(mods, 'third', 'package.json'), '{"name":"third"}\n');
    writeFileSync(join(mods, 'third', 'lib', 'index.js'), 'module.exports = 1;\n');
    mkdirSync(join(mods, '.bin'));
    symlinkSync(join('..', 'third', 'lib', 'index.js'), join(mods, '.bin', 'tool'));
    // Listing + mtime sample of the watched trees, before and after worktree teardown.
    const snap = dir =>
      readdirSync(dir)
        .sort()
        .map(n => `${n}:${statSync(join(dir, n)).mtimeMs}`)
        .join('|');
    const before = {
      root: snap(mods),
      bin: snap(join(mods, '.bin')),
      third: snap(join(mods, 'third')),
      lib: snap(join(mods, 'third', 'lib')),
    };
    const wt = join(tmp, 'wt-ok-remove');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    linkNodeModules(r.dir, wt);
    removeWorktree(r.dir, wt);
    assert.equal(existsSync(wt), false);
    assert.equal(snap(mods), before.root);
    assert.equal(snap(join(mods, '.bin')), before.bin);
    assert.equal(snap(join(mods, 'third')), before.third);
    assert.equal(snap(join(mods, 'third', 'lib')), before.lib);
  });
});

// The clone-first file strategy: a FICLONE copy gives the worktree its own inode
// (real isolation); the hardlink is the tripwire-only fallback when cloning is refused.
describe('file linking strategy (clone-first)', () => {
  it('a write through a worktree file does NOT change the main copy (skips when the fs cannot clone)', t => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('seed');
    mkdirSync(join(r.dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(r.dir, 'node_modules', 'pkg', 'data.txt'), 'main\n');
    const wt = join(tmp, 'wt-clone-iso');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    linkNodeModules(r.dir, wt);
    const { stats, line } = WT.lastLinkStats();
    if (!stats.cloned) {
      t.skip(`filesystem cannot clone (${line || 'no files cloned'}) — hardlink is tripwire-only`);
      return;
    }
    const wtFile = join(wt, 'node_modules', 'pkg', 'data.txt');
    const mainFile = join(r.dir, 'node_modules', 'pkg', 'data.txt');
    // A real copy: separate inode, so an in-place rewrite stays inside the worktree.
    assert.notEqual(statSync(wtFile).ino, statSync(mainFile).ino);
    writeFileSync(wtFile, 'hacked\n');
    assert.equal(readFileSync(mainFile, 'utf8'), 'main\n');
    removeWorktree(r.dir, wt);
  });

  it('falls back to hardlinks when the clone is unsupported (injected failure)', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('seed');
    const mods = join(r.dir, 'node_modules');
    mkdirSync(mods, { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(mods, `f${i}.txt`), 'x');
    const wt = join(tmp, 'wt-noclone');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    let calls = 0;
    const copyFile = () => {
      calls++;
      const error = new Error('no clone support');
      error.code = 'ENOTSUP';
      throw error;
    };
    linkNodeModules(r.dir, wt, { copyFile });
    // One probe per candidate flag on the first file; the rest of the tree hardlinks.
    assert.equal(calls, 2, 'the unsupported clone is not retried per file');
    const dep = lstatSync(join(wt, 'node_modules', 'f0.txt'));
    assert.ok(dep.isFile() && !dep.isSymbolicLink());
    assert.equal(
      statSync(join(wt, 'node_modules', 'f0.txt')).ino,
      statSync(join(mods, 'f0.txt')).ino,
      'hardlink shares the inode',
    );
    const { stats, line } = WT.lastLinkStats();
    assert.equal(stats.cloned, 0);
    assert.equal(stats.hardlinked, 12);
    assert.match(line, /hardlinked 12 files \(tripwire only\)/);
    removeWorktree(r.dir, wt);
  });

  it('mirrors a package symlink verbatim — a dangling one must not refuse the worktree', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('seed');
    const mods = join(r.dir, 'node_modules');
    mkdirSync(join(mods, 'dep'), { recursive: true });
    writeFileSync(join(mods, 'dep', 'real.js'), 'x\n');
    // A dangling symlink inside a package dir: clone AND hardlink both fail ENOENT
    // on it — under the refuse-on-failure rule this one link would kill the whole
    // worktree. It is recreated verbatim instead.
    symlinkSync('nonexistent-target.js', join(mods, 'dep', 'dangling.js'));
    // And a resolvable relative link stays a link too, not a copied file.
    symlinkSync('real.js', join(mods, 'dep', 'alias.js'));
    const wt = join(tmp, 'wt-dangling');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    linkNodeModules(r.dir, wt);
    const dangling = join(wt, 'node_modules', 'dep', 'dangling.js');
    assert.ok(lstatSync(dangling).isSymbolicLink(), 'dangling link not mirrored verbatim');
    assert.equal(readlinkSync(dangling), 'nonexistent-target.js');
    const alias = join(wt, 'node_modules', 'dep', 'alias.js');
    assert.ok(lstatSync(alias).isSymbolicLink(), 'package link became a file copy');
    assert.equal(readlinkSync(alias), 'real.js');
    removeWorktree(r.dir, wt);
  });

  it('refuses a package link whose literal target lands in the main checkout source', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    mkdirSync(join(r.dir, 'packages', 'engine'), { recursive: true });
    writeFileSync(join(r.dir, 'packages', 'engine', 'x.js'), 'x\n');
    r.commit('seed');
    const mods = join(r.dir, 'node_modules');
    mkdirSync(join(mods, 'dep'), { recursive: true });
    writeFileSync(join(mods, 'dep', 'real.js'), 'x\n');
    // An absolute link straight at the main checkout's source tree — recreating it
    // verbatim would wire the worktree at main's sources.
    symlinkSync(join(r.dir, 'packages', 'engine', 'x.js'), join(mods, 'dep', 'evil.js'));
    const wt = join(tmp, 'wt-srclink');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    assert.throws(() => linkNodeModules(r.dir, wt), /main checkout source|escapes/);
    removeWorktree(r.dir, wt);
  });

  it('throws instead of symlinking into main when the clone AND hardlink both fail', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('seed');
    const mods = join(r.dir, 'node_modules');
    mkdirSync(mods, { recursive: true });
    writeFileSync(join(mods, 'dep.txt'), 'x\n');
    const wt = join(tmp, 'wt-nolink');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    const copyFile = () => {
      const error = new Error('no clone support');
      error.code = 'ENOTSUP';
      throw error;
    };
    // The injected hardlink failure (EXDEV across filesystems, EPERM on protected
    // sources): the old code quietly dropped a symlink into the main checkout here —
    // a write path straight back into the shared tree. Now the worktree is refused.
    const link = () => {
      const error = new Error('simulated link failure');
      error.code = 'EXDEV';
      throw error;
    };
    assert.throws(
      () => linkNodeModules(r.dir, wt, { copyFile, link }),
      /hardlink failed.*refusing a symlink/,
    );
    assert.throws(() => lstatSync(join(wt, 'node_modules', 'dep.txt')), /ENOENT/);
    removeWorktree(r.dir, wt);
  });

  it('stops retrying the clone after a run of non-"unsupported" failures', () => {
    const r = freshRepo();
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"t","private":true}\n');
    r.commit('seed');
    const mods = join(r.dir, 'node_modules');
    mkdirSync(mods, { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(mods, `f${i}.txt`), 'x');
    const wt = join(tmp, 'wt-noclone2');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    let calls = 0;
    const copyFile = () => {
      calls++;
      throw new Error('plain failure, no errno');
    };
    linkNodeModules(r.dir, wt, { copyFile });
    assert.ok(calls > 0, 'copyFile was never invoked');
    assert.ok(calls <= 8, `clone retried ${calls} times — bound it`);
    assert.ok(
      lstatSync(join(wt, 'node_modules', 'f0.txt')).isFile(),
      'files still landed via the fallback',
    );
    removeWorktree(r.dir, wt);
  });
});

// The Integrator's lock-in checks: two workspaces loaded through the worktree share one
// module identity (the instanceof motivation for the hybrid layout), and npm itself
// accepts the mirrored tree without "extraneous" reports.
describe('worktree module identity + npm ls (integration)', () => {
  function seedTwoWorkspaces(r) {
    writeFileSync(join(r.dir, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(r.dir, 'package.json'),
      '{"name":"t","private":true,"workspaces":["packages/*"]}\n',
    );
    mkdirSync(join(r.dir, 'packages', 'a'), { recursive: true });
    writeFileSync(
      join(r.dir, 'packages', 'a', 'package.json'),
      '{"name":"@t/a","version":"1.0.0","main":"index.cjs"}\n',
    );
    writeFileSync(join(r.dir, 'packages', 'a', 'index.cjs'), 'module.exports = class A {};\n');
    mkdirSync(join(r.dir, 'packages', 'b'), { recursive: true });
    writeFileSync(
      join(r.dir, 'packages', 'b', 'package.json'),
      '{"name":"@t/b","version":"1.0.0","dependencies":{"@t/a":"1.0.0"}}\n',
    );
    r.commit('two workspaces');
    const mods = join(r.dir, 'node_modules', '@t');
    mkdirSync(mods, { recursive: true });
    symlinkSync(join('..', '..', 'packages', 'a'), join(mods, 'a'), 'junction');
    symlinkSync(join('..', '..', 'packages', 'b'), join(mods, 'b'), 'junction');
  }

  it('loads the same module object from both sides of a workspace boundary', () => {
    const r = freshRepo();
    seedTwoWorkspaces(r);
    const wt = join(tmp, 'wt-identity');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    linkNodeModules(r.dir, wt);
    writeFileSync(
      join(wt, 'packages', 'b', 'check.cjs'),
      'const A = require("@t/a"); const B = require("../a/index.cjs");\n' +
        'module.exports = A === B && new A() instanceof A;\n',
    );
    const requireFromB = createRequire(join(wt, 'packages', 'b', 'check.cjs'));
    assert.equal(
      requireFromB(join(wt, 'packages', 'b', 'check.cjs')),
      true,
      '@t/a resolved to a different module object through the link than through the package path',
    );
    removeWorktree(r.dir, wt);
  });

  it('npm ls inside the worktree exits clean (no extraneous linked packages)', () => {
    const r = freshRepo();
    seedTwoWorkspaces(r);
    const wt = join(tmp, 'wt-npmls');
    addWorktree(r.dir, { dir: wt, commit: r.head() });
    linkNodeModules(r.dir, wt);
    const out = spawnSync('npm', ['ls'], { cwd: wt, encoding: 'utf8' });
    assert.equal(out.status, 0, `npm ls reported problems:\n${out.stdout}\n${out.stderr}`);
    assert.doesNotMatch(out.stdout + out.stderr, /extraneous/);
    removeWorktree(r.dir, wt);
  });
});
