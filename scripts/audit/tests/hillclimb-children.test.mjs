import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
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

  it('names the self-exit timer in the error when a child exits 97', async () => {
    await assert.rejects(
      spawnNodeScript('process.exit(97);', 'slow'),
      /slow: hit its \d+ s self-exit timer \(exit 97\)/,
    );
  });

  it('kills tracked children when the runner itself gets SIGTERM or exits', async () => {
    const helper = fileURLToPath(new URL('./hillclimb-children.mjs', import.meta.url));
    for (const how of ['SIGTERM', 'exit']) {
      const script = `
        import { spawn } from 'node:child_process';
        import { trackChild } from ${JSON.stringify(helper)};
        const child = trackChild(spawn('node', ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' }));
        console.log(child.pid);
        ${how === 'exit' ? 'setTimeout(() => process.exit(0), 200);' : 'setInterval(() => {}, 1000);'}
      `;
      const runner = spawn('node', ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const pid = await new Promise(resolve =>
        runner.stdout.once('data', c => resolve(Number(String(c).trim()))),
      );
      if (how === 'SIGTERM') runner.kill('SIGTERM');
      await new Promise(resolve => runner.once('close', resolve));
      let alive = true;
      for (let i = 0; i < 100 && alive; i++) {
        try {
          process.kill(pid, 0);
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false, `the tracked child survived the runner's ${how}`);
    }
  });
});
