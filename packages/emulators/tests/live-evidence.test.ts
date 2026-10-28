import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderEvidence,
  writeEvidence,
  type RunEvidence,
  type SkipReason,
} from '../../../apps/desktop/scripts/live/evidence';
import type { LiveProvider, ProbeStatus, Tier } from '../../../apps/desktop/scripts/live/types';

const IDS = ['gmail.profile-and-labels', 'gmail.inbox-window-metadata'];
const PLANTS = [
  'Quarterly numbers for Alice',
  'alice@example.test',
  'ya29.a0AfH6SMB-not-a-real-token',
  '1//0gNotARealRefreshToken',
  'https://example.test/u?id=1',
  'Label_1234',
];

const good = (): RunEvidence => ({
  provider: 'gmail',
  tier: 'R',
  date: '2026-10-27',
  startedAt: '2026-10-27T16:00:00.000Z',
  node: '24.1.0',
  daysToExpiry: 5,
  results: [
    {
      id: 'gmail.profile-and-labels',
      status: 'pass',
      counts: { labels: 14, userLabels: 3 },
      timingsMs: { profile: 41.5, labels: 38 },
      errorClasses: {},
      requests: [{ method: 'gmail.users.getProfile', httpMethod: 'GET', count: 1 }],
      unitsPerMinute: [2],
    },
    {
      id: 'gmail.inbox-window-metadata',
      status: 'fail',
      counts: { threadsListed: 50, threadsFetched: 49 },
      timingsMs: { total: 1200 },
      errorClasses: { 'rate-limit': 1 },
      requests: [{ method: 'gmail.users.threads.get', httpMethod: 'GET', count: 49 }],
      unitsPerMinute: [1960, 10],
    },
  ],
  unitsPerMinute: [1962, 10],
  peakUnitsPerWindow: 1971,
});

test('a good run renders with the units-per-minute series and the peak', () => {
  const text = renderEvidence(good(), IDS);
  assert.match(text, /Units per minute \(minute 0 first\): 1962, 10/);
  assert.match(text, /Peak units in any 60 s window: 1971/);
  assert.match(text, /Peak units in one clock minute: 1962/);
  assert.match(text, /Days left before the test account must be reconnected: 5/);
  assert.match(text, /gmail\.users\.threads\.get GET x49/);
  assert.match(text, /### gmail\.inbox-window-metadata: fail/);
});

type Mutation = [string, (run: RunEvidence, value: string) => void];
const mutations: Mutation[] = [
  ['provider', (r, v) => (r.provider = v as unknown as LiveProvider)],
  ['tier', (r, v) => (r.tier = v as unknown as Tier)],
  ['date', (r, v) => (r.date = v)],
  ['startedAt', (r, v) => (r.startedAt = v)],
  ['node version', (r, v) => (r.node = v)],
  ['daysToExpiry', (r, v) => (r.daysToExpiry = v as unknown as number)],
  ['skipReason', (r, v) => (r.skipReason = v as unknown as SkipReason)],
  ['top-level unitsPerMinute', (r, v) => (r.unitsPerMinute = [v as unknown as number])],
  ['peak', (r, v) => (r.peakUnitsPerWindow = v as unknown as number)],
  ['unknown top-level field', (r, v) => ((r as unknown as Record<string, unknown>)[v] = 1)],
  ['result id', (r, v) => (r.results[0].id = v)],
  ['result status', (r, v) => (r.results[0].status = v as unknown as ProbeStatus)],
  ['count name', (r, v) => (r.results[0].counts[v] = 1)],
  ['count value', (r, v) => (r.results[0].counts.labels = v as unknown as number)],
  ['timing name', (r, v) => (r.results[0].timingsMs[v] = 1)],
  ['timing value', (r, v) => (r.results[0].timingsMs.profile = v as unknown as number)],
  ['error class name', (r, v) => (r.results[0].errorClasses[v] = 1)],
  [
    'error class value',
    (r, v) => (r.results[0].errorClasses['rate-limit'] = v as unknown as number),
  ],
  ['request method', (r, v) => (r.results[0].requests[0].method = v)],
  ['request http method', (r, v) => (r.results[0].requests[0].httpMethod = v)],
  ['request count', (r, v) => (r.results[0].requests[0].count = v as unknown as number)],
  [
    'request extra field',
    (r, v) => ((r.results[0].requests[0] as unknown as Record<string, unknown>)[v] = 'x'),
  ],
  ['probe units per minute', (r, v) => (r.results[0].unitsPerMinute = [v as unknown as number])],
  ['unknown result field', (r, v) => ((r.results[0] as unknown as Record<string, unknown>)[v] = 1)],
];

test('every field rejects a planted subject, address, token, URL or id, and the error does not repeat it', () => {
  for (const [field, mutate] of mutations) {
    for (const plant of PLANTS) {
      const run = good();
      mutate(run, plant);
      assert.throws(
        () => renderEvidence(run, IDS),
        (error: unknown) => {
          assert.ok(
            error instanceof Error && error.name === 'EvidenceRejected',
            `${field}: ${String(error)}`,
          );
          assert.ok(
            !error.message.includes(plant),
            `${field}: the error repeated the planted value`,
          );
          return true;
        },
        `${field} accepted ${plant}`,
      );
    }
  }
});

test('free text cannot get in through values that look like allowed types either', () => {
  const run = good();
  (run.results[0]!.counts as Record<string, unknown>).labels = 2.5;
  assert.throws(() => renderEvidence(run, IDS));
  const negative = good();
  negative.unitsPerMinute = [-1];
  assert.throws(() => renderEvidence(negative, IDS));
  const wrongMethod = good();
  wrongMethod.results[0]!.requests[0]!.method = 'gmail.users.messages.delete';
  assert.throws(
    () => renderEvidence(wrongMethod, IDS),
    'a method the guard can never send is not in the list',
  );
  const unregistered = good();
  assert.throws(() => renderEvidence(unregistered, ['gmail.something-else']));
});

test('a skipped run records the reason and the days left', () => {
  const run = good();
  run.skipReason = 'token-expiry';
  run.daysToExpiry = -2;
  run.results = run.results.map(r => ({
    id: r.id,
    status: 'skip',
    counts: {},
    timingsMs: {},
    errorClasses: {},
    requests: [],
    unitsPerMinute: [],
  }));
  run.unitsPerMinute = [];
  run.peakUnitsPerWindow = 0;
  const text = renderEvidence(run, IDS);
  assert.match(text, /Skipped: token-expiry/);
  assert.match(text, /reconnected: -2/);
});

test('writeEvidence names the file by date and provider and appends later runs of the same day', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-evidence-'));
  const file = await writeEvidence(dir, good(), IDS);
  assert.ok(file.endsWith('2026-10-27-gmail.md'));
  const second = good();
  second.tier = 'M';
  await writeEvidence(dir, second, IDS);
  const text = await readFile(file, 'utf8');
  assert.equal(text.match(/^# Live check evidence/gm)?.length, 1);
  assert.equal(text.match(/^## /gm)?.length, 2);

  const bad = good();
  bad.results[0]!.id = 'Quarterly numbers for Alice';
  await assert.rejects(writeEvidence(dir, bad, IDS));
  assert.equal(await readFile(file, 'utf8'), text, 'a rejected run writes nothing');
});
