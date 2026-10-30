// End-to-end sandbox breaches: a real repo where the attempt agent reaches back into
// the main checkout through the linked node_modules, or rewrites the shared git config
// the harness's own git calls would honour. A cloned file makes the first attack a
// no-op on main; in the hardlink fallback the same attack must still reject the attempt
// AND abort the run — the sandbox has failed. Shares its wiring via
// hillclimb-e2e-shared.mjs.
import assert from 'node:assert/strict';
import {
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runHillClimb } from '../hillclimb/loop.mjs';
import { setupE2E } from './hillclimb-e2e-shared.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-e2e-breach-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const { repo, seedRepo, makeDeps, config } = setupE2E(tmp);

const commandConfig = command => ({
  ...config,
  attempt: { agent: 'command', brief: 'x', timeoutSec: 60, command },
});

// Mirror linkFile's strategy check: can this filesystem give the worktree its own
// copy-on-write inode at all?
const canClone = (() => {
  const src = join(tmp, 'clone-probe-src');
  writeFileSync(src, 'x');
  try {
    copyFileSync(src, join(tmp, 'clone-probe-dst'), constants.COPYFILE_FICLONE);
    return true;
  } catch {
    return false;
  }
})();

describe('hill-climb sandbox breaches end to end', () => {
  it('a write through a cloned node_modules file stays in the worktree — main is untouched', async t => {
    if (!canClone) {
      t.skip('filesystem cannot clone — the hardlink tripwire test covers this instead');
      return;
    }
    seedRepo({ gitignore: 'node_modules\n' });
    mkdirSync(join(repo, 'node_modules', 'tool'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'tool', 'run.js'), 'clean\n');
    const logs = join(tmp, 'logs-nm-clone');
    mkdirSync(logs);
    // The agent appends through its node_modules — a COW clone keeps it inside the
    // worktree, so nothing reaches the user's checkout and the run completes clean.
    const breach = commandConfig(
      'echo hacked >> node_modules/tool/run.js && echo 5 > main/count.txt',
    );
    const { deps } = makeDeps({
      runConfig: breach,
      runId: `e2e-${process.pid.toString(36)}-nmc`,
      logs,
    });
    await assert.doesNotReject(runHillClimb(breach, deps));
    assert.equal(readFileSync(join(repo, 'node_modules', 'tool', 'run.js'), 'utf8'), 'clean\n');
  });

  it('rejects and aborts on the same write in the hardlink fallback', async () => {
    seedRepo({ gitignore: 'node_modules\n' });
    mkdirSync(join(repo, 'node_modules', 'tool'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'tool', 'run.js'), 'clean\n');
    const logs = join(tmp, 'logs-nm');
    mkdirSync(logs);
    // Simulate a filesystem without clone support: every file lands as a hardlink, the
    // append lands in the user's checkout, and the write-through scan must trip.
    const copyFile = () => {
      const error = new Error('no clone support');
      error.code = 'ENOTSUP';
      throw error;
    };
    const breach = commandConfig(
      'echo hacked >> node_modules/tool/run.js && echo 5 > main/count.txt',
    );
    const { deps } = makeDeps({
      runConfig: breach,
      runId: `e2e-${process.pid.toString(36)}-nm`,
      logs,
      linkOpts: { copyFile },
    });

    await assert.rejects(runHillClimb(breach, deps), /aborting run.*write-through.*tool\/run\.js/);
    // Both parallel attempts ran the same command before the abort propagated.
    assert.match(
      readFileSync(join(repo, 'node_modules', 'tool', 'run.js'), 'utf8'),
      /^clean\n(hacked\n)+$/,
      'write-through evidence stays in the main checkout',
    );
  });

  it('rejects and aborts when the agent rewrites shared git config', async () => {
    seedRepo();
    const logs = join(tmp, 'logs-git');
    mkdirSync(logs);
    // git config inside a linked worktree writes the SHARED .git/config; an external
    // diff driver planted there would run inside later harness git calls.
    const breach = commandConfig('git config diff.external /bin/echo && echo 5 > main/count.txt');
    const { deps } = makeDeps({
      runConfig: breach,
      runId: `e2e-${process.pid.toString(36)}-gd`,
      logs,
    });

    await assert.rejects(runHillClimb(breach, deps), /aborting run.*shared git dir/);
  });
});
