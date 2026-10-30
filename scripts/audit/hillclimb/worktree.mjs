// Git worktree plumbing for the hill-climb harness. Each attempt gets a fresh worktree under
// os.tmpdir() branched from the current best commit, with node_modules symlinked back to the
// main checkout so attempts need no reinstall. The user's own checkout is never touched.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { evalEnv } from './agent.mjs';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

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
 * Points a worktree's node_modules at the main checkout's so attempts skip npm install.
 * Covers the root and every workspace dir that actually has one — only existing dirs get a
 * link. node_modules is git-ignored, so the links never enter the diff the guard analyses.
 */
export function linkNodeModules(repoRoot, workdir) {
  const roots = ['.'];
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const pattern of pkg.workspaces ?? []) {
    // Workspace patterns here are "<dir>/*"; expand the literal parent only.
    const parent = pattern.replace(/\/\*$/, '');
    const abs = join(repoRoot, parent);
    if (parent === pattern || !existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(`${parent}/${entry.name}`);
    }
  }
  const linked = [];
  for (const root of roots) {
    const target = join(repoRoot, root, 'node_modules');
    const link = join(workdir, root, 'node_modules');
    if (!existsSync(target) || existsSync(link)) continue;
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, 'dir');
    linked.push(root);
  }
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

export function removeWorktree(repoRoot, dir) {
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
 * A hash of everything an attempt could poison to make LATER harness git calls misbehave:
 * the shared git dir's config, hooks/ entry names + contents, info/ contents, the HEADs
 * (the checkout's and this worktree's), the worktree's own config.worktree and every ref
 * except the harness's own hillclimb/* branches (which legitimately move as attempts are
 * committed and removed). Recomputing after the attempt must reproduce the same digest.
 */
export function snapshotGitDir(cwd) {
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
  const gitDir = resolve(cwd, git(['rev-parse', '--git-dir'], cwd).trim());
  const commonDir = resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd).trim());
  feedFile('config', join(commonDir, 'config'));
  feedTree(join(commonDir, 'hooks'));
  feedTree(join(commonDir, 'info'));
  feedFile('HEAD', join(commonDir, 'HEAD'));
  feedFile('worktree-HEAD', join(gitDir, 'HEAD'));
  feedFile('config.worktree', join(gitDir, 'config.worktree'));
  const refs = git(['for-each-ref', '--format=%(refname) %(objectname)'], cwd)
    .split('\n')
    .filter(line => line && !line.startsWith('refs/heads/hillclimb/'))
    .join('\n');
  feed('refs', refs);
  return hash.digest('hex');
}

// Linter and bundler caches inside node_modules may be legitimately rewritten by the
// suite commands the worktrees run; they are the only directories the scan skips.
const WRITE_SCAN_PRUNE = new Set(['.cache', '.vite']);
const WRITE_SCAN_LIMIT = 50;

/**
 * Paths under `roots` (the node_modules dirs the harness symlinks into worktrees)
 * modified since the stamp file was written — evidence of write-through into the main
 * checkout's real node_modules, which is git-ignored and therefore invisible to
 * statusPorcelain. A bounded opendir walk: directories named .cache/.vite are pruned,
 * symlinked directories are followed once (inode dedup) so hoisted workspace links like
 * node_modules/@scope/pkg are covered, and collection stops at WRITE_SCAN_LIMIT hits —
 * the first few are all a rejection reason needs. Both a link's own mtime and its
 * target's are checked, so rewriting a file through an untouched symlink still counts.
 * A full walk of this repo's node_modules (~24k files) takes ~2 s, far under the ~8 s
 * budget, so no tool-directory restriction is applied.
 */
export function findWritesSince(roots, stampPath, { relativeTo = null } = {}) {
  const stamp = statSync(stampPath).mtimeMs;
  const seen = new Set();
  const hits = [];
  const push = path => {
    hits.push(relativeTo ? relative(relativeTo, path) : path);
  };
  const walk = dir => {
    if (hits.length >= WRITE_SCAN_LIMIT) return;
    let dirStat;
    try {
      dirStat = statSync(dir); // follows links: dedup key is the real directory
    } catch {
      return;
    }
    const key = `${dirStat.dev}:${dirStat.ino}`;
    if (seen.has(key)) return;
    seen.add(key);
    let handle;
    try {
      handle = opendirSync(dir);
    } catch {
      return;
    }
    try {
      for (let ent = handle.readSync(); ent && hits.length < WRITE_SCAN_LIMIT;) {
        const name = ent.name;
        const path = join(dir, name);
        ent = handle.readSync();
        let lst;
        try {
          lst = lstatSync(path);
        } catch {
          continue; // vanished mid-scan
        }
        if (lst.isSymbolicLink()) {
          let target;
          try {
            target = statSync(path);
          } catch {
            // Dangling link: the link itself still carries an mtime worth checking.
          }
          if (Math.max(lst.mtimeMs, target?.mtimeMs ?? 0) > stamp) {
            push(path);
          } else if (target?.isDirectory() && !WRITE_SCAN_PRUNE.has(name)) {
            walk(path);
          }
        } else if (lst.isDirectory()) {
          if (!WRITE_SCAN_PRUNE.has(name)) walk(path);
        } else if (lst.mtimeMs > stamp) {
          push(path);
        }
      }
    } finally {
      handle.closeSync();
    }
  };
  for (const root of roots) walk(root);
  return hits;
}

/**
 * The post-attempt sandbox audit behind deps.verifyMainIntact. A breach anywhere throws:
 * the attempt is rejected AND the run aborts. Checks, cheapest first — the main
 * checkout's HEAD and status, then (when ctx carries them) the shared-git-dir snapshot
 * taken before the agent started and the linked node_modules roots against the
 * attempt's stamp file.
 */
export function mainCheckoutIntact(repoRoot, startCommit) {
  // statusPorcelain deliberately excludes node_modules, so tampering there is invisible
  // to it: a top-level write bumps the directory's own mtime, and the per-attempt stamp
  // scan below catches writes inside nested packages.
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
      if (snapshotGitDir(ctx.dir) !== ctx.gitSnapshot) {
        throw new Error('shared git dir changed during the attempt (sandbox breach)');
      }
    }
    if (ctx?.stampPath && ctx?.moduleRoots?.length) {
      const hits = findWritesSince(ctx.moduleRoots, ctx.stampPath, { relativeTo: repoRoot });
      if (hits.length) {
        throw new Error(
          `node_modules write-through: ${hits.slice(0, 5).join(', ')} (sandbox breach)`,
        );
      }
    }
  };
}
