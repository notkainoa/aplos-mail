import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  HARD_EXIT_PRELUDE,
  hardExitMs,
  killTrackedChildren,
  spawnNodeScript,
  trackChild,
  trackedCount,
} from './hillclimb-children.mjs';

describe('hillclimb test children', () => {
  it('kills a tracked child that would otherwise run for minutes', async () => {
    const child = trackChild(spawn('node', ['-e', 'setTimeout(() => {}, 600000)']));
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve(signal)));
    assert.equal(trackedCount() >= 1, true);
    killTrackedChildren();
    assert.equal(await closed, 'SIGKILL');
    assert.equal(trackedCount(), 0);
  });

  it('leaves no tracked child behind after a script finishes or fails', async () => {
    await spawnNodeScript('process.exit(0);', 'ok');
    await assert.rejects(spawnNodeScript('process.exit(3);', 'bad'), /bad/);
    assert.equal(trackedCount(), 0);
  });

  it('prepends a self-exit timer that does not keep a healthy child alive', async () => {
    assert.match(HARD_EXIT_PRELUDE, new RegExp(`${hardExitMs}\\)\\.unref\\(\\)`));
    const started = Date.now();
    await spawnNodeScript('await new Promise(r => setTimeout(r, 20));', 'quick');
    assert.ok(Date.now() - started < 5000, 'the unref’d timer must not delay exit');
  });
});
