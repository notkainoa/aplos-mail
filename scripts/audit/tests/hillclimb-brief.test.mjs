import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeBrief } from '../hillclimb/brief.mjs';

const config = {
  name: 'eslint-suppressions-main',
  allowedPaths: ['apps/desktop/src/main/**', 'eslint-suppressions.json'],
  allowedTestPaths: [],
  gates: [
    { name: 'lint', command: 'npm run lint', timeoutSec: 900 },
    { name: 'test', command: 'npm test', timeoutSec: 1500 },
  ],
  attempt: { agent: 'swe-2', model: 'swe-2-high', brief: 'Remove suppressions by fixing code.' },
};

describe('composeBrief', () => {
  const brief = composeBrief({
    config,
    combined: -129,
    scores: [
      {
        name: 'suppressions',
        score: -129,
        details: ['aplos/boundaries: 129 in 40 files', 'complexity: 20 in 5 files'],
      },
    ],
    round: 2,
  });

  it('carries the target name, brief text and allowed paths', () => {
    assert.match(brief, /eslint-suppressions-main/);
    assert.match(brief, /Remove suppressions by fixing code\./);
    assert.match(brief, /apps\/desktop\/src\/main\/\*\*/);
    assert.match(brief, /eslint-suppressions\.json/);
  });

  it('carries the current scores and worst findings', () => {
    assert.match(brief, /combined: -129/);
    assert.match(brief, /suppressions: -129/);
    assert.match(brief, /aplos\/boundaries: 129 in 40 files/);
  });

  it('lists the forbidden paths in plain words', () => {
    assert.match(brief, /scripts\/audit\//);
    assert.match(brief, /package\.json/);
    assert.match(brief, /__snapshots__/);
    assert.match(brief, /allowedTestPaths/);
    assert.match(brief, /shrink/);
  });

  it('lists gates and working rules', () => {
    assert.match(brief, /npm run lint/);
    assert.match(brief, /npm test/);
    assert.match(brief, /Commit nothing/);
    assert.match(brief, /Round 2 of/);
  });

  it('tells the agent not to run the full gate suites itself', () => {
    // The harness runs gates under the check lock; an agent running them in parallel
    // would fight for the slot and could not be trusted anyway.
    assert.match(brief, /Do NOT run the full gate suites yourself/);
    assert.match(brief, /check lock/);
    assert.match(brief, /targeted checks/);
  });

  it("warns the agent it runs with the harness user's privileges", () => {
    // No sandbox: the agent must be told to stay inside its own worktree.
    assert.match(brief, /harness user's privileges/);
    assert.match(brief, /no sandbox/);
    assert.match(brief, /never touch other checkouts/);
  });

  it('contains no environment values', () => {
    // The brief only ever sees structured input; env must never leak into a prompt.
    process.env.HILLCLIMB_TEST_SECRET = 'hunter2-marker';
    const again = composeBrief({ config, combined: 0, scores: [] });
    assert.ok(!again.includes('hunter2-marker'));
    assert.ok(!again.includes('API_KEY'));
    delete process.env.HILLCLIMB_TEST_SECRET;
  });

  it('serializes object details as JSON', () => {
    const withObjects = composeBrief({
      config,
      combined: 1,
      scores: [{ name: 's', score: 1, details: [{ rule: 'x', count: 3 }] }],
    });
    assert.match(withObjects, /\{"rule":"x","count":3\}/);
  });
});
