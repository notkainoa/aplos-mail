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

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: REPO_ROOT });
    return stdout;
  } catch {
    throw new RunnerError('git could not be read; run from a checkout of the repository');
  }
}

/** HEAD, and whether `git status --porcelain` (untracked files included) is empty. */
export async function gitRevision(): Promise<Revision> {
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const status = await git(['status', '--porcelain', '--untracked-files=normal']);
  return { head, clean: status.trim() === '' };
}
