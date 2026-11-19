import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { link, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recipientAddresses,
  UnparseableMessage,
} from '../../../apps/desktop/scripts/live/recipients';
import { gitRevision } from '../../../apps/desktop/scripts/live/revision';
import { acquireRunLock, LOCK_FILE } from '../../../apps/desktop/scripts/live/run-lock';

/**
 * Follow-ups from the Integrator's review of the merged PR #38. Each test failed before its fix.
 * Everything is example.test and temporary folders; no network.
 */

const SELF = 'self@example.test';
const OTHER = 'other@example.test';
const message = (text: string): Buffer => Buffer.from(text, 'latin1');

// ---------- FU-1: a header block that mixes CRLF and bare LF ----------

test('FU-1: a header block mixing CRLF and bare LF is refused', () => {
  const mixed = [
    // A CRLF-only parser reads "\nCc: ..." as a header line after the LF-only blank line.
    `To: ${SELF}\r\n\nCc: ${OTHER}\r\n\r\nhi`,
    // ... or reads "Cc" as part of the To line.
    `To: ${SELF}\nCc: ${OTHER}\r\n\r\nhi`,
    `To: ${SELF}\r\nSubject: x\nBcc: ${OTHER}\r\n\r\nhi`,
    // CRLF headers ended by a bare-LF blank line.
    `To: ${SELF}\r\nSubject: x\r\n\nhi`,
    // A trailing CR with no LF after it, at the end of an unterminated header block.
    `To: ${SELF}\r`,
  ];
  for (const text of mixed)
    assert.throws(
      () => recipientAddresses(message(text)),
      UnparseableMessage,
      JSON.stringify(text),
    );
});

test('FU-1: consistent CRLF or bare-LF header blocks still parse; the body may mix', () => {
  assert.deepEqual(recipientAddresses(message(`To: ${SELF}\r\nSubject: x\r\n\r\na\nb\r\n`)), [
    SELF,
  ]);
  assert.deepEqual(recipientAddresses(message(`To: ${SELF}\nSubject: x\n\na\r\nb`)), [SELF]);
  assert.deepEqual(recipientAddresses(message(`To: ${SELF}\r\nSubject: x`)), [SELF]);
});

// ---------- FU-2: git subprocess environment and hidden changes ----------

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.test', ...args], {
    cwd: dir,
    env: CLEAN_ENV,
    encoding: 'utf8',
  });
}

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-fu-git-'));
  gitIn(dir, 'init', '-q');
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('FU-2: GIT_* in the runner environment does not redirect the revision check', async () => {
  const repo = await repoWith({ 'a.txt': 'a\n' });
  const elsewhere = await repoWith({ 'b.txt': 'b\n' });
  const head = gitIn(repo, 'rev-parse', 'HEAD').trim();
  const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = join(elsewhere, '.git');
  process.env.GIT_INDEX_FILE = join(elsewhere, '.git', 'index');
  try {
    assert.deepEqual(await gitRevision(repo), { head, clean: true });
  } finally {
    restoreEnv('GIT_DIR', saved.dir);
    restoreEnv('GIT_INDEX_FILE', saved.index);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('FU-2: a file flagged assume-unchanged or skip-worktree refuses the run', async () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const repo = await repoWith({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    gitIn(repo, 'update-index', flag, 'a.txt');
    // The edit is hidden from `git status`; the revision check must not call this tree clean.
    await writeFile(join(repo, 'a.txt'), 'changed\n');
    await assert.rejects(gitRevision(repo), /assume-unchanged or skip-worktree/, flag);
  }
});

// ---------- FU-3: a failed re-link keeps the moved-aside lock ----------

test('FU-3: if putting a taken-over lock back fails, the moved file is left in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-fu-lock-'));
  const path = join(dir, LOCK_FILE);
  await writeFile(path, '4001\n');
  const isAlive = (pid: number): boolean => {
    // Between the read and the move, runner 5002 takes the dead lock over...
    if (pid === 4001) writeFileSync(path, '5002\n');
    return pid !== 4001;
  };
  // ... and runner 6003 makes a new lock before this run can put 5002's back.
  const relink = async (from: string, to: string): Promise<void> => {
    await writeFile(to, '6003\n');
    await link(from, to);
  };
  await assert.rejects(
    acquireRunLock(dir, { pid: 7004, isAlive: pid => isAlive(pid), link: relink }),
    /Another live run is going/,
  );
  assert.equal(await readFile(path, 'utf8'), '6003\n', 'the newest lock is untouched');
  const aside = (await readdir(dir)).filter(name => name.startsWith(`${LOCK_FILE}.stale-`));
  assert.equal(aside.length, 1, 'the moved lock was not deleted');
  assert.equal(await readFile(join(dir, aside[0]!), 'utf8'), '5002\n');
});
