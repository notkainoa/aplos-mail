import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RunnerError } from './errors';

/**
 * The commit a live run is made from. The runner refuses unless HEAD is the commit the request
 * named (`--expect-sha`) and the working tree is clean, so the evidence names the exact code that ran.
 */
export interface Revision {
  head: string;
  clean: boolean;
}

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * The runner's environment without GIT_* variables: GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 * GIT_CONFIG_* and the rest could point git at another repository or index, or change its config,
 * so HEAD and the status would describe something other than the code that runs.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
  );
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    // An fsmonitor hook answers "what changed?" for git status; ask the files instead.
    const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: root,
      env: gitEnv(),
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    throw new RunnerError('git could not be read; run from a checkout of the repository');
  }
}

/**
 * True when some tracked file is flagged assume-unchanged or skip-worktree. `git status` does not
 * look at such a file, so an edit to it would not make the tree dirty. In `git ls-files -v` a
 * lowercase tag means assume-unchanged and "S" means skip-worktree.
 */
async function hasHiddenFiles(root: string): Promise<boolean> {
  const entries = (await git(root, ['ls-files', '-v', '-z'])).split('\0');
  return entries.some(entry => /^[a-zS]/.test(entry));
}

/**
 * HEAD, and whether `git status --porcelain` (untracked files included) is empty. Refuses when a
 * tracked file is hidden from `git status`, since then "clean" cannot be trusted.
 */
export async function gitRevision(root: string = REPO_ROOT): Promise<Revision> {
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  if (await hasHiddenFiles(root))
    throw new RunnerError(
      'a tracked file is flagged assume-unchanged or skip-worktree; clear the flag before a live run',
    );
  const status = await git(root, ['status', '--porcelain', '--untracked-files=normal']);
  return { head, clean: status.trim() === '' };
}
