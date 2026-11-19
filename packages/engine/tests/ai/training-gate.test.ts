import assert from 'node:assert/strict';
import test from 'node:test';
import { runJobs } from '../../src/ai/impl/runner';
import { PROVIDER_ROWS, trainsOnInputs } from '../../src/ai/providers';
import { seedMail, stubTransport, world } from './harness';
import type { World } from './harness';

// What the site says (apps/web claims.json `no-training-providers`): Gemini gets mail only when the owner marks its
// key as paid, because Google may use what a free key sends to improve its products. Every other provider is sent
// mail under its own terms. The gate is `trainsOnInputs` (ai/providers.ts), checked by ai/impl/gate.ts before any
// mail text reaches a provider.

const SUMMARY = '{"summary":"Ada asked about the invoice.","action":null}';

async function geminiSummaries(w: World) {
  const cur = (await w.call('Settings/get', {})).ai.features;
  await w.call('Settings/set', {
    opId: 'gemini',
    patch: {
      ai: {
        background: true,
        features: { ...cur, summaries: { provider: 'gemini', model: 'gemini-flash' } },
      },
    },
  });
  // Consent is granted against the live settings, so the gate's only remaining question is the provider.
  const got = await w.call('Consent/get', {});
  await w.call('Consent/grant', {
    scope: 'background',
    version: got.currentVersion ?? got.version,
    provider: 'gemini',
    model: 'gemini-flash',
  });
}

test('only free-tier Gemini is held back from mail; a paid mark lets it through', () => {
  const trains = PROVIDER_ROWS.filter(r => trainsOnInputs(r.id)).map(r => r.id);
  assert.deepEqual(trains, ['gemini']);
  assert.equal(trainsOnInputs('gemini', true), false);
  assert.equal(trainsOnInputs('gemini', false), true);
});

test('background summaries never send mail to a free Gemini key, and do once the key is marked paid', async () => {
  const transport = stubTransport({ answer: SUMMARY });
  const w = await world(transport);
  seedMail(w);
  await geminiSummaries(w);
  const req = await w.call('Ai/request', {
    opId: 'r1',
    kind: 'summary',
    threadId: 'acct-1:T-thread',
  });

  await runJobs(w.engine.services, w.clock.now());
  assert.equal(transport.calls.length, 0, 'no mail text went to a free Gemini key');
  const job = (await w.call('Ai/jobs', {})).list.find(j => j.id === req.job.id)!;
  assert.equal(job.state, 'queued', 'held, not failed');

  await w.call('Settings/set', {
    opId: 'paid',
    patch: { ai: { providers: { gemini: { paid: true } } } },
  });
  await runJobs(w.engine.services, w.clock.now() + 24 * 60 * 60_000);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].model.provider, 'gemini');
});
