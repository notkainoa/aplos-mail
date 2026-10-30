// End-to-end sandbox breaches: a real repo where the attempt agent reaches back into
// the main checkout through the linked node_modules, or rewrites the shared git config
// the harness's own git calls would honour. Both must reject the attempt AND abort the
// run — the sandbox has failed. Shares its wiring via hillclimb-e2e-shared.mjs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('hill-climb sandbox breaches end to end', () => {
  it('rejects and aborts when the agent writes through the linked node_modules', async () => {
    seedRepo({ gitignore: 'node_modules\n' });
    mkdirSync(join(repo, 'node_modules', 'tool'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'tool', 'run.js'), 'clean\n');
    const logs = join(tmp, 'logs-nm');
    mkdirSync(logs);
    // The agent's worktree node_modules is a symlink into the repo's real one: this
    // append lands in the user's checkout, invisible to git status.
    const breach = commandConfig(
      'echo hacked >> node_modules/tool/run.js && echo 5 > main/count.txt',
    );
    const { deps } = makeDeps({
      runConfig: breach,
      runId: `e2e-${process.pid.toString(36)}-nm`,
      logs,
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
