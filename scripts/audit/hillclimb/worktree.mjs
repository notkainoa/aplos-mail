// Git worktree plumbing for the hill-climb harness. Each attempt gets a fresh worktree under
// os.tmpdir() branched from the current best commit, with a hybrid node_modules populated
// from the main checkout so attempts need no reinstall. The user's own checkout is never
// touched.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { evalEnv } from './agent.mjs';
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findModuleChanges, snapshotModuleTrees } from './modulescan.mjs';

export const AUTHOR = { name: 'Kainoa Newton', email: 'k@kainoa.me' };

export function runRoot(runId, base = tmpdir()) {
  return join(base, `hillclimb-${runId}`);
}

export function attemptDir(root, round, index) {
  return join(root, `r${round}a${index}`);
}

export function attemptBranch(name, runId, round, index) {
  return `hillclimb/${name}/${runId}/r${round}a${index}`;
}

export function bestBranch(name, runId) {
  return `hillclimb/${name}/${runId}/best`;
}

// Every harness git call runs with hooks, fsmonitor, external diff drivers and ext::
// transports disabled. An attempt agent could plant any of them in the shared .git
// config (or .git/hooks) to turn the harness's OWN git invocations into code execution;
// command-line -c settings outrank anything a worktree can write to shared config.
const GIT_SAFETY = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.external=',
  '-c',
  'protocol.ext.allow=never',
];

// Every harness git call also runs on a dedicated environment: the eval allow-list (never
// a credential), global and system config files pointed at nothing (an agent-writable
// ~/.gitconfig or XDG git config could inject a filter.*.clean, core.fsmonitor or
// diff.external into the harness's OWN git add/diff), no GIT_CONFIG_* pairs, no terminal
// prompts, and the harness committer identity pinned for the commits it makes.
const gitEnv = () => ({
  ...evalEnv(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
});

export function git(args, cwd, options = {}) {
  const { env, ...rest } = options;
  return execFileSync('git', [...GIT_SAFETY, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env ?? gitEnv(),
    ...rest,
  });
}

export const currentHead = cwd => git(['rev-parse', 'HEAD'], cwd).trim();

// The harness symlinks node_modules into every worktree it creates. A symlink is not a
// directory, so a ".gitignore" entry of "node_modules/" (directories only) does NOT hide it
// from `git add -A` — the attempt's commit would silently gain a symlink and the diff guard
// would reject every attempt. Belt and suspenders: the repo .gitignore must use the bare
// "node_modules" form AND the harness always excludes the name from add/status explicitly.
const MODULES_EXCLUDE = ':(exclude,glob)**/node_modules';

/** git worktree add -b <branch> <dir> <commit>, or --detach <dir> <commit> without a branch. */
export function addWorktree(repoRoot, { dir, branch, commit }) {
  mkdirSync(dirname(dir), { recursive: true });
  const args = branch
    ? ['worktree', 'add', '-b', branch, dir, commit]
    : ['worktree', 'add', '--detach', dir, commit];
  git(args, repoRoot);
  return dir;
}

/**
 * This checkout's npm workspaces: every dir matched by the root package.json "workspaces"
 * globs ("<dir>/*" patterns; only the literal parent is expanded), plus each dir's package
 * name read from its manifest. A dir without a manifest still counts as a possible
 * per-workspace node_modules root — it just has no name to link.
 */
function workspaceMap(repoRoot) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const dirs = [];
  const names = new Map();
  for (const pattern of pkg.workspaces ?? []) {
    const parent = pattern.replace(/\/\*$/, '');
    const abs = join(repoRoot, parent);
    if (parent === pattern || !existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      // statSync follows links: npm's glob matches a symlinked dir, so a workspace that
      // is a link must register here — the verify pass then refuses one pointing out.
      try {
        if (!statSync(join(abs, entry.name)).isDirectory()) continue;
      } catch {
        continue;
      }
      const rel = `${parent}/${entry.name}`;
      dirs.push(rel);
      try {
        const name = JSON.parse(readFileSync(join(abs, entry.name, 'package.json'), 'utf8')).name;
        if (typeof name === 'string' && name) names.set(name, rel);
      } catch {
        // No readable manifest — no name, but the dir can still hold node_modules.
      }
    }
  }
  return { dirs, names };
}

// lstat that tolerates absence: existsSync follows links and would miss dangling ones.
const lexists = path => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const realOrSelf = path => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// stat-based dir test (follows links): a package dir reached through a symlink still has
// to be rebuilt as a real dir, or npm flags the package at it as extraneous.
const isDir = path => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// Defence against pathological link cycles in nested node_modules (a container resolving
// to its own ancestor); real npm trees nest only a few levels.
const MODULES_DEPTH_LIMIT = 12;

/**
 * A workspace link as npm itself writes it — relative from the link's directory, so the
 * worktree resolves the package inside ITSELF (and matches what .package-lock.json
 * records). Fails closed when the worktree lacks the workspace dir: a dangling link is
 * exactly the hole the verify pass at the end of linkNodeModules exists to rule out.
 */
export const linkWorkspace = (linkPath, workdir, wsRel, ctx = null) => {
  const target = join(workdir, wsRel);
  if (!existsSync(target)) {
    throw new Error(`workspace dir ${wsRel} missing in the worktree — refusing a dangling link`);
  }
  symlinkSync(relative(dirname(linkPath), target), linkPath, 'junction');
  ctx?.wsLinks.push(linkPath);
};

/**
 * The .bin shim dir: ALWAYS a real dir of per-shim links, like npm writes it — a
 * whole-dir symlink into the main checkout would let `rm node_modules/.bin/<x>` inside an
 * attempt delete the main copy's shim, and a deletion leaves no file mtime for the write
 * scan to compare. A shim resolving into a workspace dir is rebuilt against the
 * worktree's own workspace; one resolving inside the same container becomes the
 * npm-style relative link to the mirrored file; anything else (absolute links, dangling
 * shims) is copied verbatim. File-level links only — never a dir link into main.
 */
function linkBinDir(mainBin, linkBin, ctx) {
  let names;
  try {
    names = readdirSync(mainBin);
  } catch {
    return;
  }
  mkdirSync(linkBin, { recursive: true });
  const linkModules = dirname(linkBin);
  const containerReal = realOrSelf(dirname(mainBin));
  for (const name of names) {
    const sub = join(linkBin, name);
    if (lexists(sub)) continue;
    const mainPath = join(mainBin, name);
    let lst;
    try {
      lst = lstatSync(mainPath);
    } catch {
      continue; // vanished mid-populate
    }
    if (lst.isSymbolicLink()) {
      let real = null;
      try {
        real = realpathSync(mainPath);
      } catch {
        // Dangling shim — copied verbatim below, exactly as it dangles in main.
      }
      const hit =
        real && ctx.wsDirs.find(ws => real === ws.real || real.startsWith(`${ws.real}${sep}`));
      if (hit) {
        symlinkSync(
          relative(linkBin, join(ctx.workdir, hit.rel) + real.slice(hit.real.length)),
          sub,
          'junction',
        );
        ctx.wsLinks.push(sub);
      } else if (real && (real === containerReal || real.startsWith(`${containerReal}${sep}`))) {
        symlinkSync(
          relative(linkBin, join(linkModules, relative(containerReal, real))),
          sub,
          'junction',
        );
      } else {
        symlinkSync(readlinkSync(mainPath), sub);
      }
    } else if (lst.isDirectory()) {
      mirrorDir(mainPath, sub, ctx, 0);
    } else {
      linkFile(mainPath, sub, ctx);
    }
  }
}

/**
 * A file-level entry (code, manifests, license texts): first a copy-on-write clone —
 * the worktree gets its OWN inode, so an in-place append, truncate or patch inside the
 * attempt cannot reach the main checkout (APFS and other reflink filesystems give real
 * isolation; elsewhere FICLONE degrades to a full copy, which is still isolated). Only
 * when cloning is unsupported does the entry become a hardlink — one inode shared with
 * the main copy, which a write-through then mutates: that mode is tripwire-only (the
 * write scan reports content writes after the fact; chmod/chown/utimes it cannot see).
 * A failed hardlink THROWS — the harness refuses the worktree — because the previous
 * last resort, a plain symlink into the main checkout, resolved reads AND writes back
 * into the shared tree. A symlink SOURCE is exempt from all of this: it is mirrored
 * verbatim, never cloned or hardlinked.
 */
const CLONE_UNSUPPORTED = new Set(['ENOTSUP', 'EXDEV', 'EOPNOTSUPP', 'EINVAL', 'ENOSYS']);
// Strict clone first (Linux ioctl), then the best-effort form — macOS's copyfile(3)
// rejects CLONE_FORCE with ENOSYS but clones fine through the plain FICLONE flag.
const CLONE_FLAGS = [constants.COPYFILE_FICLONE_FORCE, constants.COPYFILE_FICLONE];
// A tree is ~36k files: a listed errno means "this filesystem cannot clone", and a run
// of any other failure must not be retried per file either — stop after a few.
const CLONE_RETRY_LIMIT = 8;

const linkFile = (mainPath, linkPath, ctx) => {
  ctx.stats.files++;
  if (lstatSync(mainPath).isSymbolicLink()) {
    // A package-internal symlink can be neither cloned (copyFile of a dangling link
    // fails ENOENT) nor safely hardlinked (link(2) dereferences on some filesystems,
    // silently sharing the TARGET's inode with main) — mirror it verbatim instead.
    // Then the same rule the verify sweep applies decides: a link whose literal
    // target points into the main checkout's source tree is refused — recreating it
    // would wire the worktree straight at main's sources. A dangling link resolves
    // nowhere, so the literal target text is what gets judged; a relative target is
    // interpreted from the link's own directory and stays inside the worktree.
    const target = readlinkSync(mainPath);
    const logical = isAbsolute(target) ? resolve(target) : resolve(dirname(linkPath), target);
    for (const candidate of [logical, realOrSelf(logical)]) {
      const rel = relative(ctx.repoReal, candidate);
      if (rel === '' || (!rel.startsWith('..') && !rel.split(sep).includes('node_modules'))) {
        throw new Error(
          `node_modules link ${mainPath} resolves into the main checkout source -> ${target} — refusing the worktree`,
        );
      }
    }
    symlinkSync(target, linkPath);
    ctx.stats.symlinked++;
    return;
  }
  if (!ctx.stats.cloneBroken) {
    const flags = ctx.cloneFlag === undefined ? CLONE_FLAGS : [ctx.cloneFlag];
    let exhausted = true;
    for (const flag of flags) {
      try {
        ctx.copyFile(mainPath, linkPath, flag);
        ctx.cloneFlag = flag;
        ctx.stats.cloned++;
        return;
      } catch (error) {
        if (CLONE_UNSUPPORTED.has(error?.code)) continue;
        // A real failure (space, perms, a vanished source): bounded retries, not 36k.
        exhausted = ++ctx.stats.cloneFailures >= CLONE_RETRY_LIMIT;
        break;
      }
    }
    if (exhausted) ctx.stats.cloneBroken = true;
  }
  try {
    ctx.link(mainPath, linkPath);
    ctx.stats.hardlinked++;
  } catch (error) {
    throw new Error(
      `cannot link ${mainPath} into the worktree (hardlink failed: ${error.message}) — refusing a symlink into the main checkout`,
    );
  }
};

/**
 * A node_modules entry that is itself a symlink into the checkout's TRACKED tree (its
 * realpath lands inside the repo but outside every node_modules) while NOT being a
 * workspace of this commit: a leftover from a revision with a different workspace set.
 * Mirroring it as a package would let a stale workspace keep resolving — skip it.
 */
const staleRepoLink = (mainPath, ctx) => {
  let lst;
  try {
    lst = lstatSync(mainPath);
  } catch {
    return false;
  }
  if (!lst.isSymbolicLink()) return false;
  const real = realOrSelf(mainPath);
  if (real === mainPath) return false; // dangling or unresolvable — kept verbatim below
  const rel = relative(ctx.repoReal, real);
  if (rel === '' || rel.startsWith('..')) return false;
  return !rel.split(sep).includes('node_modules');
};

// A directory entry either recurses or — past the depth cap, or when it is a symlink
// re-entering a directory already on the mirror stack (a link cycle) — stays a real but
// EMPTY dir. Never a whole-dir symlink into the main checkout. Real dirs cannot cycle,
// so only symlinked ones pay for the realpath.
const cutDir = (mainPath, ctx, depth) => {
  if (depth > MODULES_DEPTH_LIMIT) return true;
  return lstatSync(mainPath).isSymbolicLink() && ctx.activeDirs.has(realOrSelf(mainPath));
};

/**
 * One installed package dir or any other non-container dir inside the tree: a REAL dir in
 * the worktree whose entries are cloned/hardlinked copies of the main copy's — except a
 * nested node_modules, which recurses as a container of its own. npm only accepts a
 * package at a real directory (a symlink reads as "extraneous"), runtime imports need
 * contents reachable at their logical paths, and dirent-based readers need real files in
 * real subdirs.
 */
function mirrorDir(mainDir, linkDir, ctx, depth) {
  mkdirSync(linkDir, { recursive: true });
  const mainReal = realOrSelf(mainDir);
  const fresh = !ctx.activeDirs.has(mainReal);
  if (fresh) ctx.activeDirs.add(mainReal);
  try {
    for (const name of readdirSync(mainDir)) {
      const linkPath = join(linkDir, name);
      if (lexists(linkPath)) continue;
      const mainPath = join(mainDir, name);
      if (name === 'node_modules' && isDir(mainPath)) {
        populateModules(mainPath, linkPath, { ...ctx, allWorkspaces: false }, depth + 1);
      } else if (isDir(mainPath)) {
        if (cutDir(mainPath, ctx, depth + 1)) mkdirSync(linkPath, { recursive: true });
        else mirrorDir(mainPath, linkPath, ctx, depth + 1);
      } else {
        linkFile(mainPath, linkPath, ctx);
      }
    }
  } finally {
    if (fresh) ctx.activeDirs.delete(mainReal);
  }
}

/**
 * The collapsed form of a container (depth cap or a link cycle): still a REAL dir — a
 * whole-dir symlink into the main checkout would let an attempt write straight into it —
 * mirroring one level. Files are linked, workspace names link into the worktree, .bin is
 * rebuilt like anywhere else, and every subdirectory becomes a real but EMPTY dir:
 * recursing into it is exactly the cycle (or the pathological depth) the collapse cuts.
 */
function collapseModules(mainModules, linkModules, ctx) {
  const shallow = (mainDir, linkDir, prefix) => {
    mkdirSync(linkDir, { recursive: true });
    for (const name of readdirSync(mainDir)) {
      const linkPath = join(linkDir, name);
      if (lexists(linkPath)) continue;
      const mainPath = join(mainDir, name);
      const wsRel = ctx.workspaces.names.get(prefix + name);
      if (wsRel) {
        linkWorkspace(linkPath, ctx.workdir, wsRel, ctx);
      } else if (name === '.bin' && isDir(mainPath)) {
        linkBinDir(mainPath, linkPath, ctx);
      } else if (name.startsWith('@') && lstatSync(mainPath).isDirectory()) {
        shallow(mainPath, linkPath, `${name}/`);
      } else if (staleRepoLink(mainPath, ctx)) {
        // A leftover workspace link this commit does not have — it must not survive.
      } else if (isDir(mainPath)) {
        mkdirSync(linkPath, { recursive: true });
      } else {
        linkFile(mainPath, linkPath, ctx);
      }
    }
  };
  shallow(mainModules, linkModules, '');
}

/**
 * One node_modules container: a REAL dir in the worktree. Every directory inside it —
 * scope dirs, package dirs, nested node_modules deeper down — must also be real, because
 * npm's tree loader marks any package reached through a symlinked ancestor (and linked
 * packages themselves) extraneous; file-level contents are cloned or hardlinked so
 * dirent-based readers see real files. Workspace names become the relative links npm
 * itself writes; .bin is always a real dir of per-shim links; files and other
 * dot-entries are copied from the main checkout. A nested container re-entered through a
 * link cycle (or past the depth cap) collapses to the shallow real-dir mirror above —
 * never a whole-dir symlink into main. When `allWorkspaces` is set (the root
 * node_modules) every workspace name is linked even if the main tree lacks it, matching
 * what npm would have installed there.
 */
function populateModules(mainModules, linkModules, ctx, depth = 0) {
  const mainReal = realOrSelf(mainModules);
  mkdirSync(linkModules, { recursive: true });
  if (depth > MODULES_DEPTH_LIMIT || ctx.activeDirs.has(mainReal)) {
    collapseModules(mainModules, linkModules, ctx);
    return;
  }
  ctx.activeDirs.add(mainReal);
  try {
    for (const name of readdirSync(mainModules)) {
      const linkPath = join(linkModules, name);
      if (lexists(linkPath)) continue; // idempotent: never replace what is already there
      const mainPath = join(mainModules, name);
      const wsRel = ctx.workspaces.names.get(name);
      if (wsRel) {
        linkWorkspace(linkPath, ctx.workdir, wsRel, ctx);
        continue;
      }
      if (name === '.bin' && isDir(mainPath)) {
        linkBinDir(mainPath, linkPath, ctx);
        continue;
      }
      if (name.startsWith('@') && lstatSync(mainPath).isDirectory()) {
        mkdirSync(linkPath, { recursive: true });
        for (const sub of readdirSync(mainPath)) {
          const subLink = join(linkPath, sub);
          if (lexists(subLink)) continue;
          const subMain = join(mainPath, sub);
          const subWs = ctx.workspaces.names.get(`${name}/${sub}`);
          if (subWs) {
            linkWorkspace(subLink, ctx.workdir, subWs, ctx);
          } else if (staleRepoLink(subMain, ctx)) {
            // A leftover workspace link this commit does not have — it must not survive.
          } else if (isDir(subMain)) {
            if (cutDir(subMain, ctx, depth + 1)) mkdirSync(subLink, { recursive: true });
            else mirrorDir(subMain, subLink, ctx, depth + 1);
          } else {
            linkFile(subMain, subLink, ctx);
          }
        }
        continue;
      }
      if (staleRepoLink(mainPath, ctx)) continue;
      if (isDir(mainPath)) {
        if (cutDir(mainPath, ctx, depth + 1)) mkdirSync(linkPath, { recursive: true });
        else mirrorDir(mainPath, linkPath, ctx, depth + 1);
      } else {
        linkFile(mainPath, linkPath, ctx);
      }
    }
    if (ctx.allWorkspaces) {
      for (const [name, wsRel] of ctx.workspaces.names) {
        const linkPath = join(linkModules, name);
        if (lexists(linkPath)) continue;
        mkdirSync(dirname(linkPath), { recursive: true });
        linkWorkspace(linkPath, ctx.workdir, wsRel, ctx);
      }
    }
  } finally {
    ctx.activeDirs.delete(mainReal);
  }
}

const statsLine = stats => {
  const { files, cloned, hardlinked, symlinked } = stats;
  if (!hardlinked && !symlinked) return `node_modules: cloned ${cloned} files`;
  if (!cloned && !symlinked) return `node_modules: hardlinked ${hardlinked} files (tripwire only)`;
  return `node_modules: cloned ${cloned}, hardlinked ${hardlinked}, symlinked ${symlinked} of ${files} files (hardlinks are tripwire only)`;
};

// The most recent linkNodeModules result, for the harness's one-line strategy report.
let lastLink = { stats: { files: 0, cloned: 0, hardlinked: 0, symlinked: 0 }, line: '' };
export const lastLinkStats = () => lastLink;

/**
 * Fail-closed checks on the link set just built — any violation throws, so the harness
 * aborts the worktree instead of running gates against a layout that can escape:
 *  - no committed node_modules path may exist in the worktree (checkout would keep it
 *    silently — a symlink among them could resolve back into the main checkout);
 *  - no linked node_modules dir may be a symlink (a whole-dir link writes through);
 *  - every workspace link must resolve to a target inside the worktree itself;
 *  - every other symlink anywhere under a linked node_modules — .bin shims and nested
 *    package links included — must resolve inside the worktree or inside the real main
 *    node_modules trees this worktree linked from.
 */
function verifyLinkSet(workdir, linked, ctx) {
  const committed = git(['ls-files', '-z'], workdir)
    .split('\0')
    .filter(path => path.split('/').includes('node_modules'));
  if (committed.length) {
    throw new Error(
      `committed node_modules paths materialized in the worktree: ${committed.slice(0, 5).join(', ')}`,
    );
  }
  for (const root of linked) {
    const modules = join(workdir, root, 'node_modules');
    if (lstatSync(modules).isSymbolicLink()) {
      throw new Error(
        `worktree ${join(root, 'node_modules')} is a symlink — refusing a dependency dir outside the worktree`,
      );
    }
  }
  const workReal = realpathSync(workdir);
  const inside = (linkPath, real) => {
    if (real !== workReal && !real.startsWith(`${workReal}${sep}`)) {
      throw new Error(`workspace link ${linkPath} escapes the worktree -> ${real}`);
    }
  };
  for (const linkPath of ctx.wsLinks) {
    let real;
    try {
      real = realpathSync(linkPath);
    } catch {
      throw new Error(`workspace link ${linkPath} does not resolve`);
    }
    inside(linkPath, real);
  }
  // The deliberate exceptions to "inside the worktree": links the mirror copies from
  // the main tree verbatim — an absolute .bin shim, an absolute link a hardlink kept —
  // still resolve into the REAL main node_modules trees this worktree linked from, and
  // that is where they pointed all along. The allow-list is exactly those trees: a
  // link into the main checkout's SOURCE dirs (packages/, apps/, anything outside
  // node_modules) or anywhere else outside the worktree refuses the worktree.
  const moduleRoots = [];
  for (const root of linked) {
    try {
      moduleRoots.push(realpathSync(join(ctx.repoReal, root, 'node_modules')));
    } catch {
      // The linked tree vanished mid-verify — nothing may resolve inside it anyway.
    }
  }
  const literalRoots = [
    resolve(workdir),
    ...linked.map(root => resolve(join(ctx.repoReal, root, 'node_modules'))),
  ];
  const under = (path, roots) => roots.some(r => path === r || path.startsWith(`${r}${sep}`));
  const contained = (linkPath, real) => {
    if (under(real, [workReal]) || under(real, moduleRoots)) return;
    // The logical target of a dangling link is a literal path: judge it against the
    // literal spellings too — an unresolved path can carry an un-realpath'ed prefix.
    if (under(real, literalRoots)) return;
    throw new Error(
      `node_modules link ${linkPath} escapes the worktree and the linked module roots -> ${real}`,
    );
  };
  // Where a link points when its target exists; for a dangling one, where it WOULD
  // point — a copied dangling shim still gets the containment check on its logical
  // target rather than a free pass.
  const linkTarget = linkPath => {
    try {
      return realpathSync(linkPath);
    } catch {
      let base;
      try {
        base = realpathSync(dirname(linkPath));
      } catch {
        base = resolve(dirname(linkPath));
      }
      return resolve(base, readlinkSync(linkPath));
    }
  };
  // Every symlink anywhere under a linked node_modules gets the containment check —
  // container top level, @scope dirs, .bin shims, package contents and nested
  // node_modules alike — so a link the populate pass never made (planted after
  // checkout or left under a pre-existing dir) cannot resolve outside the worktree
  // or the allowed main module trees. Real dirs only: following a dir link would
  // sweep its target's subtree, which is not a package-resolution position.
  const seen = new Set();
  const sweep = dir => {
    for (const name of readdirSync(dir)) {
      const linkPath = join(dir, name);
      const lst = lstatSync(linkPath);
      if (lst.isSymbolicLink()) {
        contained(linkPath, linkTarget(linkPath));
      } else if (lst.isDirectory()) {
        const st = statSync(linkPath);
        const key = `${st.dev}:${st.ino}`;
        if (!seen.has(key)) {
          seen.add(key);
          sweep(linkPath);
        }
      }
    }
  };
  for (const root of linked) {
    sweep(join(workdir, root, 'node_modules'));
  }
}

/**
 * Gives a worktree its dependencies without an install: at the root and at every workspace
 * dir that actually has node_modules in the main checkout, builds a REAL node_modules
 * container of real package dirs whose CONTENTS are cloned or hardlinked from the main
 * checkout's copies, while node_modules/<workspace-name> links INSIDE the worktree,
 * exactly like npm's own "node_modules/@aplos/engine -> ../../packages/engine" links.
 *
 * A whole-dir node_modules symlink fails twice: it redirects even the workspace links at
 * the main checkout (attempt changes under packages/* are invisible to gates, and tests
 * crossing a package boundary load each workspace twice — instanceof breaks), and npm
 * itself reports every linked package extraneous. Per-package symlinks still fail the
 * second half of that — only real dirs all the way down to each package satisfy npm ls.
 * The workspace map is read from the WORKTREE's own manifest, so a worktree whose commit
 * adds or renames a workspace gets the links that commit implies.
 *
 * Returns the linked roots ('.' plus workspace dirs); callers map them to the main
 * checkout's real node_modules trees for the post-attempt write-through scan. The verify
 * pass at the end throws on a committed node_modules, a whole-dir symlink or an escaping
 * workspace link. Stats of the last call (clone vs hardlink counts and the summary line)
 * come from lastLinkStats(). Idempotent: existing entries are left alone, only missing
 * ones are added.
 */
export function linkNodeModules(
  repoRoot,
  workdir,
  { copyFile = copyFileSync, link = linkSync } = {},
) {
  const workspaces = workspaceMap(workdir);
  // The shim-binding check compares against a .bin shim's realpath — a MAIN-side path —
  // so workspace dirs are resolved under repoRoot. A workspace that exists only in the
  // worktree has no main-side entry to match; its shims still resolve through the
  // worktree's own relative links.
  const wsDirs = workspaces.dirs
    .map(rel => {
      try {
        return { rel, real: realpathSync(join(repoRoot, rel)) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const ctx = {
    workspaces,
    wsDirs,
    workdir,
    repoReal: realOrSelf(repoRoot),
    copyFile,
    link,
    wsLinks: [],
    activeDirs: new Set(),
    stats: { files: 0, cloned: 0, hardlinked: 0, symlinked: 0, cloneFailures: 0 },
  };
  const linked = [];
  for (const root of ['.', ...workspaces.dirs]) {
    const mainModules = join(repoRoot, root, 'node_modules');
    const linkModules = join(workdir, root, 'node_modules');
    if (!existsSync(mainModules)) continue;
    // A whole-dir link placed some other way already resolves into the main tree — never
    // merge into it (its entries would write through). It is kept so the scan roots stay
    // honest, and the verify pass below refuses the worktree over it.
    if (lexists(linkModules) && lstatSync(linkModules).isSymbolicLink()) {
      linked.push(root);
      continue;
    }
    populateModules(mainModules, linkModules, { ...ctx, allWorkspaces: root === '.' });
    linked.push(root);
  }
  verifyLinkSet(workdir, linked, ctx);
  lastLink = { stats: ctx.stats, line: statsLine(ctx.stats) };
  return linked;
}

/**
 * Parses `git diff --raw -M --find-copies-harder -z` output into
 * [{ status, path, oldPath?, oldMode, newMode }]. Records start with ":", paths are
 * NUL-terminated; renames and copies give the OLD path first, then the new one (the
 * reverse of porcelain -z).
 */
export function parseRawDiff(output) {
  const tokens = output.split('\0');
  const changes = [];
  let i = 0;
  while (i < tokens.length && tokens[i]) {
    const header = tokens[i++];
    const fields = header.split(' ');
    const [oldMode, newMode] = fields;
    const letter = fields[4][0];
    const first = tokens[i++];
    const change = { status: letter, path: first, oldMode, newMode };
    if (letter === 'R' || letter === 'C') {
      change.oldPath = first;
      change.path = tokens[i++];
    }
    changes.push(change);
  }
  return changes;
}

/**
 * The committed diff base..head of a worktree, modes included. `head` is the attempt's
 * explicit sha — never an implicit HEAD, so the guarded commit is provably the commit
 * the eval worktree is checked out at. `-a --no-ext-diff --no-textconv` (here and in
 * every diff the harness parses) pins output to git's own text diff: an external diff
 * driver or "Binary files differ" can no longer hide what the guard reads.
 */
export function diffBetween(workdir, base, head) {
  return parseRawDiff(
    git(
      [
        'diff',
        '--raw',
        '-M',
        '--find-copies-harder',
        '-z',
        '-a',
        '--no-ext-diff',
        '--no-textconv',
        base,
        head,
      ],
      workdir,
    ),
  );
}

/** Porcelain entries as [{x, y, path, oldPath?}]. With -z each record is "XY <path>" in one
 * token; a rename or copy appends the old path as the next token. node_modules is excluded
 * explicitly so a linked symlink never counts as a leftover even when .gitignore uses the
 * directories-only "node_modules/" form. */
export function statusPorcelain(workdir) {
  const output = git(['status', '--porcelain', '-z', '--', '.', MODULES_EXCLUDE], workdir);
  const tokens = output.split('\0');
  const entries = [];
  let i = 0;
  while (i < tokens.length && tokens[i]) {
    const record = tokens[i++];
    const item = { x: record[0], y: record[1], path: record.slice(3) };
    if ('RC'.includes(item.x) || 'RC'.includes(item.y)) item.oldPath = tokens[i++];
    entries.push(item);
  }
  return entries;
}

/** File contents at a ref, or null when absent there. */
export function gitShow(workdir, ref, path) {
  try {
    return git(['show', `${ref}:${path}`], workdir);
  } catch {
    return null;
  }
}

/**
 * Tracked paths carrying assume-unchanged or skip-worktree bits. `git ls-files -v` tags each
 * entry: uppercase means normal, a lowercase tag marks assume-unchanged and 'S' marks
 * skip-worktree. An agent could set one to hide tampering from the committed diff, so any
 * flagged path rejects the attempt.
 */
export function indexFlagViolations(workdir) {
  // -z so a path containing whitespace or quotes isn't mangled by C-style quoting.
  const output = git(['ls-files', '-v', '-z'], workdir);
  const flagged = [];
  for (const token of output.split('\0')) {
    if (!token) continue;
    const tag = token[0];
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) flagged.push(token.slice(2));
  }
  return flagged;
}

/**
 * Lines added by base..head as raw text (no '+' prefix), for the suppression-directive
 * scan. `-U0` keeps context out of the diff and hunks are tracked per file: everything
 * before a file's first "@@" is metadata (so "+++ b/f" headers are skipped) while every
 * '+' line inside a hunk is added content — including lines literally starting with "++"
 * that a naive startsWith('+++') filter would silently drop.
 */
export function addedLines(workdir, base, head) {
  const output = git(
    ['diff', '--no-color', '-U0', '-a', '--no-ext-diff', '--no-textconv', base, head],
    workdir,
  );
  const added = [];
  let inHunk = false;
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git')) {
      inHunk = false;
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      added.push(line.slice(1));
    }
  }
  return added;
}

/**
 * Paths base..head classifies as binary (numstat shows "-\t-"), where a text diff — and
 * therefore the directive scan — would show nothing reviewable. Record form with -z is
 * "<added>\t<deleted>\t<path>"; only the third field may itself contain tabs.
 */
export function binaryPaths(workdir, base, head) {
  const output = git(['diff', '--numstat', '-z', '--no-ext-diff', base, head], workdir);
  const paths = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first === -1 || second === -1) continue;
    if (record.slice(0, first) === '-' && record.slice(first + 1, second) === '-') {
      paths.push(record.slice(second + 1));
    }
  }
  return paths;
}

/** Every path in a commit's tree, NUL-safe. Used for the case/normalisation collision check. */
export function lsTreePaths(workdir, sha) {
  const output = git(['ls-tree', '-r', '-z', '--name-only', sha], workdir);
  return output.split('\0').filter(Boolean);
}

/** Byte size of a blob at ref:path, or null when absent. */
export function blobSize(workdir, ref, path) {
  try {
    const size = Number(git(['cat-file', '-s', `${ref}:${path}`], workdir).trim());
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

/**
 * Commits whatever the agent left (staged, modified, untracked) as one harness commit.
 * Returns the new HEAD sha, or null when the worktree was already clean.
 */
export function commitAll(workdir, message) {
  git(['add', '-A', '--', '.', MODULES_EXCLUDE], workdir);
  if (statusPorcelain(workdir).length === 0) return null;
  git(
    [
      '-c',
      `user.name=${AUTHOR.name}`,
      '-c',
      `user.email=${AUTHOR.email}`,
      // The repo's own hooks (core.hooksPath=scripts/hooks) and any signing config belong to
      // the user, not to a throwaway attempt commit: never run hooks, never sign.
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '--no-gpg-sign',
      '-qm',
      message,
    ],
    workdir,
  );
  return currentHead(workdir);
}

/**
 * Removes a worktree. Before ANY removal — git's or the rmSync fallback — the path must
 * be a real directory strictly inside a hillclimb-* run root under the OS temp dir:
 * never the main checkout, never a symlink, never anywhere else. `rm -rf` is one bad
 * argument away from wiping the user's checkout, so the path check refuses (throws)
 * rather than falling back to silence.
 */
export function removeWorktree(repoRoot, dir) {
  const refuse = why => {
    throw new Error(`refusing to remove worktree dir ${dir}: ${why}`);
  };
  let lst = null;
  try {
    lst = lstatSync(dir);
  } catch {
    // Already gone — nothing to remove, nothing to refuse.
  }
  if (lst) {
    if (lst.isSymbolicLink()) refuse('path is a symlink');
    const realDir = realpathSync(dir);
    const rel = relative(realpathSync(tmpdir()), realDir);
    const first = rel.split(sep)[0];
    if (!first || rel.startsWith('..') || rel === first || !first.startsWith('hillclimb-')) {
      refuse('not strictly inside a hillclimb-* run root');
    }
    let repoReal = null;
    try {
      repoReal = realpathSync(repoRoot);
    } catch {
      // repoRoot itself is missing — the equality check cannot apply.
    }
    if (repoReal && realDir === repoReal) refuse('path is the main checkout');
  }
  try {
    git(['worktree', 'remove', '--force', dir], repoRoot);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    git(['worktree', 'prune'], repoRoot);
  }
}

export function deleteBranch(repoRoot, branch) {
  try {
    git(['branch', '-D', branch], repoRoot);
  } catch {
    // Already gone — cleanup is best-effort by design.
  }
}

/**
 * Collapses an attempt chain into ONE commit on top of `fromSha`, on the best branch, without
 * touching any checkout: commit-tree the kept head's tree with the start commit as parent.
 */
export function squashToBest(repoRoot, { name, runId, fromSha, toSha, message }) {
  const tree = git(['rev-parse', `${toSha}^{tree}`], repoRoot).trim();
  // commit-tree needs an identity: gitEnv already pins GIT_AUTHOR_*/GIT_COMMITTER_*.
  const sha = git(['commit-tree', tree, '-p', fromSha, '-m', message], repoRoot).trim();
  const branch = bestBranch(name, runId);
  git(['branch', '-f', branch, sha], repoRoot);
  return { branch, sha };
}

/** Removes every attempt worktree and branch of a run except the best branch. */
export function cleanupRun(
  repoRoot,
  { runId, name, dirs, branches, keep = bestBranch(name, runId) },
) {
  for (const dir of dirs) removeWorktree(repoRoot, dir);
  for (const branch of branches) {
    if (branch !== keep) deleteBranch(repoRoot, branch);
  }
  const root = runRoot(runId);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

/** Repo-relative path of the attempt worktree's temp dir — useful in logs only. */
export function relativeDir(repoRoot, dir) {
  return relative(repoRoot, dir);
}

/**
 * Per-component hashes of the small slice of shared git state an attempt could poison
 * to make LATER harness git calls misbehave: the common dir's config, hooks/ and info/
 * contents, this worktree's own HEAD and config.worktree, and exactly the long-lived
 * refs refs/heads/main + refs/heads/revamp. Every other ref is deliberately excluded:
 * sibling worktrees (other harness threads) legitimately commit during a run, and
 * hashing their refs would read ordinary progress as a breach. The main checkout's own
 * HEAD is already covered by the explicit currentHead check in mainCheckoutIntact.
 * Components hash separately so the breach message can NAME what moved — a sibling
 * worktree's push or pull is indistinguishable from tampering until you see which part
 * changed, which is exactly why the run requires a dedicated clone (assertDedicatedClone).
 */
export function snapshotGitDir(cwd) {
  const parts = {};
  const into = (name, fill) => {
    const hash = createHash('sha256');
    const feed = (label, data) => {
      hash.update(label);
      hash.update('\0');
      hash.update(data);
      hash.update('\0');
    };
    const feedFile = (label, path) => {
      try {
        feed(label, readFileSync(path));
      } catch {
        // Absent files hash as nothing at all — their absence is part of the snapshot.
      }
    };
    const feedTree = dir => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        feed('entry', entry.name);
        if (entry.isFile()) feedFile('file', path);
        else if (entry.isDirectory()) feedTree(path);
      }
    };
    fill({ feed, feedFile, feedTree });
    parts[name] = hash.digest('hex');
  };
  const gitDir = resolve(cwd, git(['rev-parse', '--git-dir'], cwd).trim());
  const commonDir = resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd).trim());
  into('config', h => h.feedFile('config', join(commonDir, 'config')));
  into('hooks', h => h.feedTree(join(commonDir, 'hooks')));
  into('info', h => h.feedTree(join(commonDir, 'info')));
  into('worktree-HEAD', h => h.feedFile('worktree-HEAD', join(gitDir, 'HEAD')));
  into('config.worktree', h => h.feedFile('config.worktree', join(gitDir, 'config.worktree')));
  const refs = git(
    ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/main', 'refs/heads/revamp'],
    cwd,
  ).trim();
  into('refs', h => h.feed('refs', refs));
  return parts;
}

/** The differing component names between two snapshotGitDir snapshots, sorted. */
export function gitDirChanges(before, after) {
  return Object.keys(before)
    .filter(name => before[name] !== after[name])
    .sort();
}

/**
 * The shared-git-dir snapshot is only meaningful when that dir is PRIVATE to the
 * checkout the run watches: run from a linked worktree and a sibling worktree's
 * ordinary push, pull or worktree-add writes the shared common dir mid-run (config,
 * refs/heads/main, info/) — indistinguishable from an attempt's tampering, and a real
 * run has already aborted on it. The harness therefore requires a dedicated clone:
 * `rev-parse --git-dir` equals `--git-common-dir` and both live at <root>/.git.
 * Anything else — a linked worktree, a submodule, a bare layout — is refused.
 */
export function assertDedicatedClone(cwd) {
  const gitDir = resolve(cwd, git(['rev-parse', '--git-dir'], cwd).trim());
  const commonDir = resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd).trim());
  if (gitDir !== resolve(cwd, '.git') || commonDir !== gitDir) {
    throw new Error(
      'run this from a dedicated clone with its own .git ' +
        '(git clone --reference <your checkout> <url> /tmp/hc-clone), not a linked worktree: ' +
        'other worktrees change the shared git dir and would read as a sandbox breach',
    );
  }
}

// The node_modules baseline/diff pair lives in modulescan.mjs; re-exported here so the
// harness's worktree-facing API stays in one place.
export { findModuleChanges, snapshotModuleTrees };

/**
 * The post-attempt sandbox audit behind deps.verifyMainIntact. A breach anywhere throws:
 * the attempt is rejected AND the run aborts. Checks, cheapest first — the main
 * checkout's HEAD and status, then (when ctx carries them) the shared-git-dir snapshot
 * taken before the agent started and the linked node_modules roots diffed against the
 * pre-agent baseline snapshot.
 */
export function mainCheckoutIntact(repoRoot, startCommit) {
  // statusPorcelain deliberately excludes node_modules, so tampering there is invisible
  // to it: a top-level write bumps the directory's own mtime, and the per-attempt
  // baseline diff below catches writes inside nested packages.
  let modulesMtime = null;
  try {
    modulesMtime = statSync(join(repoRoot, 'node_modules')).mtimeMs;
  } catch {
    // No node_modules yet — nothing to watch.
  }
  return async ctx => {
    if (currentHead(repoRoot) !== startCommit) {
      throw new Error('main checkout HEAD moved during the run (sandbox breach)');
    }
    const dirty = statusPorcelain(repoRoot);
    if (dirty.length) {
      throw new Error(`main checkout dirtied during the run (${dirty[0].path}): sandbox breach`);
    }
    if (modulesMtime !== null) {
      let now = null;
      try {
        now = statSync(join(repoRoot, 'node_modules')).mtimeMs;
      } catch {
        // Removed mid-run — the porcelain check or a later scan reports what matters.
      }
      if (now !== null && now !== modulesMtime) {
        throw new Error('main checkout node_modules touched during the run (sandbox breach)');
      }
    }
    if (ctx?.gitSnapshot && ctx?.dir && existsSync(ctx.dir)) {
      const changed = gitDirChanges(ctx.gitSnapshot, snapshotGitDir(ctx.dir));
      if (changed.length) {
        throw new Error(
          `shared git dir changed during the attempt: ${changed.join(', ')} (sandbox breach)`,
        );
      }
    }
    if (ctx?.moduleSnapshot && ctx?.moduleRoots?.length) {
      // The baseline is fixed BEFORE the agent ran — roots linked later (the eval
      // worktree's) join it at link time, in prepareEval. Re-baselining here would
      // adopt a root swapped under its own path (mv + recreate) as if original;
      // instead a root whose dev:ino is missing or changed is itself a hit.
      const hits = findModuleChanges(ctx.moduleRoots, ctx.moduleSnapshot, {
        relativeTo: repoRoot,
      });
      if (hits.length) {
        throw new Error(
          `node_modules write-through: ${hits.slice(0, 5).join(', ')} (sandbox breach)`,
        );
      }
    }
  };
}
