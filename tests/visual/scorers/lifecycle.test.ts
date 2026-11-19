import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { killGroup, SIGNAL_EXIT } from './lifecycle';

const dir = mkdtempSync(join(tmpdir(), 'scorer-lifecycle-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(done: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return done();
}

async function signalFixture(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  const marker = join(dir, `${signal}.marker`);
  const fixture = join(import.meta.dirname, 'lifecycle.fixture.ts');
  const parent = spawn(process.execPath, ['--import', 'tsx', fixture, marker], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const pid = await new Promise<number>((resolve, reject) => {
    parent.once('error', reject);
    parent.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
  });
  assert.ok(alive(pid), 'detached child is running');
  const exited = new Promise<number | null>(resolve => parent.once('exit', code => resolve(code)));
  parent.kill(signal);
  assert.equal(await exited, SIGNAL_EXIT[signal]);
  assert.equal(existsSync(marker) && readFileSync(marker, 'utf8'), 'cleaned');
  assert.ok(await until(() => !alive(pid)), 'detached child was killed with the scorer');
}

test('SIGTERM runs the cleanups, kills the detached child group and exits 143', async () => {
  await signalFixture('SIGTERM');
});

test('SIGINT runs the cleanups, kills the detached child group and exits 130', async () => {
  await signalFixture('SIGINT');
});

test('killGroup is quiet about a group that is already gone', () => {
  assert.equal(killGroup(undefined), false);
  assert.equal(killGroup(2 ** 22 + 12345), false);
});
