// CLI surface tests for run.mjs: --run-id lands in branch names and tmpdir names, so it is
// validated as a safe slug before anything is created.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs } from '../hillclimb/run.mjs';

describe('parseArgs --run-id', () => {
  it('accepts a valid slug', () => {
    const options = parseArgs(['config.json', '--run-id', 'r7-2026-02']);
    assert.equal(options.runId, 'r7-2026-02');
  });

  it('rejects ids that are not safe slugs', () => {
    const bad = ['-x', 'A', 'a_b', 'a/b', 'a b', 'a'.repeat(42), 'Ω', ''];
    for (const value of bad) {
      assert.throws(
        () => parseArgs(['config.json', '--run-id', value]),
        /--run-id/,
        JSON.stringify(value),
      );
    }
  });
});
