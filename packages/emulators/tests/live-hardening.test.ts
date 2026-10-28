import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { renderEvidence, type RunEvidence } from '../../../apps/desktop/scripts/live/evidence';
import { printableMessage, RunnerError } from '../../../apps/desktop/scripts/live/errors';
import { createGuardedFetch, GuardRefusal } from '../../../apps/desktop/scripts/live/guard';
import { parseAddressList } from '../../../apps/desktop/scripts/live/recipients';
import type { Tier } from '../../../apps/desktop/scripts/live/types';

/**
 * Extra checks for the guard's fail-closed behaviour that the attack suite does not name:
 * the snapshot of the request, per-draft ordering, header and query allowlists, duplicate JSON
 * keys, and what the runner is allowed to print. Everything is example.test.
 */

const SELF = 'self@example.test';
const OTHER = 'other@example.test';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const json = { 'content-type': 'application/json' };
const b64 = (text: string): string => Buffer.from(text, 'latin1').toString('base64url');
const raw = (to: string): string => b64(`To: ${to}\r\n\r\nhi`);

interface Seen {
  method: string;
  url: string;
  headers: [string, string][];
  body: unknown;
  frozenInit: boolean;
}

function guardOn(tier: Tier, answer: (seen: Seen) => unknown = () => ({})) {
  const seen: Seen[] = [];
  const guard = createGuardedFetch(
    async (input, init) => {
      const entry: Seen = {
        method: init?.method ?? 'GET',
        url: String(input),
        headers: [...new Headers(init?.headers)],
        body: init?.body,
        frozenInit: Object.isFrozen(init),
      };
      seen.push(entry);
      return new Response(JSON.stringify(answer(entry)), { status: 200, headers: json });
    },
    { tier, selfAddress: SELF, calendarRunId: 'run-test' },
  );
  return { guard, seen };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'sent';
  } catch (error) {
    return error instanceof GuardRefusal ? error.reason : `crash:${String(error)}`;
  }
}

test('snapshot: what reaches the network is the plain data the guard checked', async () => {
  const { guard, seen } = guardOn('M');
  await guard(`${GMAIL}/messages/m1/modify`, {
    method: 'post',
    headers: new Headers(json),
    body: new Blob(['{"addLabelIds":["STARRED"]}']),
  });
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(String(Buffer.from(seen[0]!.body as Uint8Array)), '{"addLabelIds":["STARRED"]}');
  // The layers below get frozen plain pairs, so nothing there can see a live object of the caller's.
  assert.ok(seen[0]!.frozenInit);
});

test('snapshot: accessors, unknown keys, proxies and odd bodies are refused, not read twice', async () => {
  const { guard, seen } = guardOn('R');
  let reads = 0;
  const getter = {
    get headers() {
      return reads++ === 0 ? {} : { 'x-http-method-override': 'DELETE' };
    },
  } as RequestInit;
  assert.equal(await reason(guard(`${GMAIL}/profile`, getter)), 'sent');
  assert.equal(reads, 1, 'init.headers is read exactly once');
  assert.ok(!seen[0]!.headers.some(([name]) => name.includes('override')));
  assert.equal(
    await reason(guard(`${GMAIL}/profile`, { cache: 'no-store' } as RequestInit)),
    'unsupported-request',
  );
  assert.equal(
    await reason(
      guard(
        `${GMAIL}/profile`,
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('trap');
            },
          },
        ),
      ),
    ),
    'unsupported-request',
  );
  assert.equal(
    await reason(guard(`${GMAIL}/profile`, { method: 5 } as unknown as RequestInit)),
    'unsupported-request',
  );
  assert.equal(
    await reason(guard(`${GMAIL}/profile`, null as unknown as RequestInit)),
    'unsupported-request',
  );
  assert.equal(seen.length, 1);
});

test('snapshot: a body object that fakes its type cannot choose what is checked', async () => {
  const { guard, seen } = guardOn('M');
  const fake = Object.setPrototypeOf(
    { toString: () => '{"addLabelIds":["TRASH"]}' },
    URLSearchParams.prototype,
  );
  assert.equal(
    await reason(
      guard(`${GMAIL}/messages/m1/modify`, { method: 'POST', headers: json, body: fake }),
    ),
    'body-unparseable',
  );
  const fakeBlob = Object.setPrototypeOf({ type: 'application/json' }, Blob.prototype);
  assert.equal(
    await reason(
      guard(`${GMAIL}/messages/m1/modify`, { method: 'POST', headers: json, body: fakeBlob }),
    ),
    'body-unparseable',
  );
  assert.equal(seen.length, 0);
});

test('headers: only an allowlist gets through, and a repeated header is refused', async () => {
  const { guard, seen } = guardOn('R');
  for (const headers of [
    { Host: 'evil.example.test' },
    { Authorization: 'Bearer x' },
    { 'Content-Length': '0' },
    { 'Transfer-Encoding': 'chunked' },
    { 'X-Anything': '1' },
  ] as Record<string, string>[]) {
    assert.equal(
      await reason(guard(`${GMAIL}/profile`, { headers })),
      'unsupported-request',
      JSON.stringify(headers),
    );
  }
  assert.equal(
    await reason(
      guard(`${GMAIL}/profile`, {
        headers: [
          ['accept', 'a'],
          ['Accept', 'b'],
        ],
      }),
    ),
    'unsupported-request',
  );
  assert.equal(
    await reason(guard(`${GMAIL}/profile`, { headers: { Accept: 'application/json' } })),
    'sent',
  );
  assert.equal(seen.length, 1);
});

test('query: repeats and other spellings of the keys the guard reads are refused on writes', async () => {
  for (const query of [
    'sendUpdates=none&sendUpdates=none',
    'sendUpdates=none&SENDUPDATES=all',
    'SendUpdates=none',
    'sendUpdates=none&sendNotifications=false&sendnotifications=true',
    'sendUpdates=none&x=1&x=2',
  ]) {
    const { guard, seen } = guardOn('M');
    assert.equal(
      await reason(
        guard(`${CAL}/calendars/primary/events?${query}`, {
          method: 'POST',
          headers: json,
          body: '{}',
        }),
      ),
      'unsupported-request',
      query,
    );
    assert.equal(seen.length, 0);
  }
  const { guard, seen } = guardOn('M');
  assert.equal(
    await reason(
      guard(`${CAL}/calendars/primary/events?sendUpdates=none&sendNotifications=false`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ extendedProperties: { private: { aplosLiveRun: 'run-test' } } }),
      }),
    ),
    'sent',
  );
  // Reads may repeat keys that carry lists, but not the keys the guard prices or reads.
  assert.equal(
    await reason(guard(`${GMAIL}/messages/m1?metadataHeaders=From&metadataHeaders=Subject`)),
    'sent',
  );
  assert.equal(
    await reason(guard(`${GMAIL}/messages/m1?format=metadata&format=full`)),
    'unsupported-request',
  );
  assert.equal(await reason(guard(`${GMAIL}/messages/m1?Format=metadata`)), 'unsupported-request');
  assert.equal(seen.length, 2);
});

test('json: duplicate keys at any depth, including escaped spellings, are refused', async () => {
  const bodies = [
    `{"raw":"${raw(OTHER)}","raw":"${raw(SELF)}"}`,
    `{"raw":"${raw(SELF)}","\\u0072aw":"${raw(OTHER)}"}`,
    `{"id":"d1","message":{"raw":"${raw(SELF)}","raw":"${raw(OTHER)}"}}`,
  ];
  for (const body of bodies) {
    const { guard, seen } = guardOn('S-self');
    assert.equal(
      await reason(guard(`${GMAIL}/messages/send`, { method: 'POST', headers: json, body })),
      'body-unparseable',
      body.slice(0, 30),
    );
    assert.equal(
      await reason(guard(`${GMAIL}/drafts`, { method: 'POST', headers: json, body })),
      'body-unparseable',
    );
    assert.equal(seen.length, 0);
  }
  // Same key in different objects, and keys inside strings, are fine.
  const { guard } = guardOn('S-self');
  assert.equal(
    await reason(
      guard(`${GMAIL}/drafts`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ message: { raw: raw(SELF), threadId: '"raw":1,"raw":2' } }),
      }),
    ),
    'sent',
  );
  const calendar = guardOn('M');
  assert.equal(
    await reason(
      calendar.guard(`${CAL}/calendars/primary/events?sendUpdates=none`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          summary: 'x',
          start: { dateTime: '2026-10-28T10:00:00Z' },
          end: { dateTime: '2026-10-28T11:00:00Z' },
          extendedProperties: { private: { aplosLiveRun: 'run-test' } },
        }),
      }),
    ),
    'sent',
  );
  // Invalid UTF-8 is refused rather than repaired.
  assert.equal(
    await reason(
      guard(`${GMAIL}/messages/send`, {
        method: 'POST',
        headers: json,
        body: new Uint8Array([0x7b, 0xff, 0x7d]),
      }),
    ),
    'body-unparseable',
  );
});

test('drafts: a send queues behind an update in flight and then sees the draft as changed', async () => {
  const gates: (() => void)[] = [];
  let counter = 0;
  const seen: string[] = [];
  const guard = createGuardedFetch(
    async (_input, init) => {
      seen.push(init?.method ?? 'GET');
      // Updates (PUT) wait for the test to release them; everything else answers at once.
      if (init?.method === 'PUT') await new Promise<void>(resolve => gates.push(resolve));
      return new Response(JSON.stringify({ id: `d${++counter}` }), { status: 200, headers: json });
    },
    { tier: 'S-self', selfAddress: SELF },
  );
  await guard(`${GMAIL}/drafts`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ message: { raw: raw(SELF) } }),
  });
  const update = guard(`${GMAIL}/drafts/d1`, {
    method: 'PUT',
    headers: json,
    body: JSON.stringify({ message: { raw: raw(OTHER) } }),
  });
  const send = reason(
    guard(`${GMAIL}/drafts/send`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ id: 'd1' }),
    }),
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(
    seen,
    ['POST', 'PUT'],
    'the send has not gone out while the update is in flight',
  );
  gates.forEach(open => open());
  await update;
  assert.equal(await send, 'draft-not-verified-self');
  assert.deepEqual(seen, ['POST', 'PUT']);
});

test('drafts: an encoded spelling of the id is refused, so the draft it names is unchanged', async () => {
  const { guard, seen } = guardOn('S-self', request =>
    request.method === 'POST' && request.url.endsWith('/drafts') ? { id: 'd+1' } : {},
  );
  await guard(`${GMAIL}/drafts`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ message: { raw: raw(SELF) } }),
  });
  assert.equal(
    await reason(
      guard(`${GMAIL}/drafts/d%2B1`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ message: { raw: raw(OTHER) } }),
      }),
    ),
    'draft-not-created-by-run',
  );
  assert.equal(seen.length, 1);
  // The stored draft is still the self-only one the guard checked, so it may be sent.
  await guard(`${GMAIL}/drafts/send`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ id: 'd+1' }),
  });
  assert.deepEqual(
    seen.map(entry => entry.method),
    ['POST', 'POST'],
  );
});

test('recipients: an address in a display name (bare or quoted) and any group are refused', () => {
  assert.throws(() => parseAddressList(`${OTHER} <${SELF}>`), /display name/);
  assert.throws(() => parseAddressList(`${OTHER}: ${SELF};`), /unsupported character/);
  assert.throws(() => parseAddressList(`"${OTHER}" <${SELF}>`), /quoted display name/);
  assert.deepEqual(parseAddressList(`Me Myself <${SELF}>`), [SELF]);
  assert.deepEqual(parseAddressList(`"Me Myself" <${SELF}>, ${SELF}`), [SELF, SELF]);
});

test("printing: only the runner's own messages are shown; parser and system errors show a class name", () => {
  assert.equal(printableMessage(new RunnerError('Sign in first'), 'Run failed'), 'Sign in first');
  assert.equal(
    printableMessage(new GuardRefusal('batch-unsupported'), 'Run failed'),
    'Guard refused a request (batch-unsupported)',
  );
  let parse: unknown;
  try {
    JSON.parse('{"agent": ya29FAKEPASTEDTOKEN}');
  } catch (error) {
    parse = error;
  }
  const shown = printableMessage(parse, 'Run failed');
  assert.equal(shown, 'Run failed (SyntaxError)');
  assert.equal(printableMessage('a string', 'Run failed'), 'Run failed');
});

test('evidence: numbers are capped so they stay counts and times', () => {
  const run: RunEvidence = {
    provider: 'gmail',
    tier: 'R',
    date: '2026-10-27',
    startedAt: '2026-10-27T16:00:00.000Z',
    node: '24.1.0',
    daysToExpiry: 3,
    results: [
      {
        id: 'p',
        status: 'pass',
        counts: { labels: 12 },
        timingsMs: { total: 40.5 },
        errorClasses: {},
        requests: [],
        unitsPerMinute: [5],
      },
    ],
    unitsPerMinute: [5],
    peakUnitsPerWindow: 5,
  };
  assert.match(renderEvidence(run, ['p']), /labels=12/);
  for (const change of [
    (r: RunEvidence) => {
      r.results[0]!.counts.labels = 4_000_000_000;
    },
    (r: RunEvidence) => {
      r.results[0]!.timingsMs.total = 1e12;
    },
    (r: RunEvidence) => {
      r.peakUnitsPerWindow = 2 ** 40;
    },
  ]) {
    const copy = structuredClone(run);
    change(copy);
    assert.throws(() => renderEvidence(copy, ['p']), /not on the allowlist/);
  }
});
