// End-to-end anti-gaming: a real repo where attempt a1 hides its edit behind a Git index
// flag (assume-unchanged) and a2 plants an ignored .env that would inflate its score if the
// scorer ran in the dirty worktree. The harness must gate/score a CLEAN checkout of the
// attempt's commit, so a1 is rejected on the flag and a2 scores the honest -5, not 999.
// Shares its wiring with hillclimb-e2e.test.mjs via hillclimb-e2e-shared.mjs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runHillClimb } from '../hillclimb/loop.mjs';
import { setupE2E } from './hillclimb-e2e-shared.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-e2e-tamper-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const { seedRepo, makeDeps, tamperConfig } = setupE2E(tmp);

describe('hill-climb anti-gaming end to end', () => {
  it('rejects index-flag tampering and scores from the commit, not the dirty tree', async () => {
    seedRepo({ gitignore: '.env\n' });
    const logs = join(tmp, 'logs');
    mkdirSync(logs);
    const { deps } = makeDeps({
      runConfig: tamperConfig,
      runId: `e2e-${process.pid.toString(36)}-b`,
      logs,
    });

    const result = await runHillClimb(tamperConfig, deps);

    const [a1, a2] = result.rounds[0].attempts;
    // a1 hid its edit behind assume-unchanged: nothing was committed, the flag gives it away.
    assert.match(a1.verdict, /rejected: index flags/, JSON.stringify(a1));
    // a2's .env never made it into the commit, so the eval worktree cannot see it: the score
    // is the honest -5, not the 999 a scorer in the dirty tree would have reported.
    assert.equal(a2.verdict, 'kept', JSON.stringify(a2));
    assert.equal(a2.combined, -5);
  });
});
