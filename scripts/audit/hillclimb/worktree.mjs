// Git worktree plumbing for the hill-climb harness. Each attempt gets a fresh worktree under
// os.tmpdir() branched from the current best commit, with node_modules symlinked back to the
// main checkout so attempts need no reinstall. The user's own checkout is never touched.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

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

export function git(args, cwd, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
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

/** The committed diff base..HEAD of a worktree, modes included. */
export function diffBetween(workdir, base) {
  return parseRawDiff(
    git(['diff', '--raw', '-M', '--find-copies-harder', '-z', `${base}`, 'HEAD'], workdir),
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
  const output = git(['ls-files', '-v'], workdir);
  const flagged = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) flagged.push(line.slice(2));
  }
  return flagged;
}

/**
 * Lines added by base..HEAD as raw text (no '+' prefix), for the suppression-directive scan.
 * `-U0` keeps context out of the diff; '+++' file headers are not content.
 */
export function addedLines(workdir, base) {
  const output = git(['diff', '--no-color', '-U0', `${base}`, 'HEAD'], workdir);
  const added = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
  }
  return added;
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
  const sha = git(['commit-tree', tree, '-p', fromSha, '-m', message], repoRoot, {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
    },
  }).trim();
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
