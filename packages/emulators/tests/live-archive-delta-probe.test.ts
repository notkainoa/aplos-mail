/**
 * Tier R probe `gmail.archive-delta-cost` (apps/desktop/scripts/live/probes/gmail-archive-delta.ts), run through the
 * real runner and guard against the emulator: `--phase mark` stores the history cursor, an archive made "elsewhere"
 * (the emulator's archiveThreads, as Gmail web would make it) changes the mailbox, and `--phase measure` walks
 * history.list from the cursor and counts pages, records and distinct messages — the budgets.json row
 * `sync.archive-2000-units` ("a 2,000-thread archive costs under 100 sync units") records those pages at 2 units a call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGmailEmulator, FakeClock, type GmailEmulator } from '../src/index';
import { runLive, type RunDeps } from '../../../apps/desktop/scripts/live/run';
import { signIn } from '../../../apps/desktop/scripts/live/signin';
import { PROBES } from '../../../apps/desktop/scripts/live/probes';
import { createProbeState } from '../../../apps/desktop/scripts/live/state';
import { unitCost } from '../../../apps/desktop/scripts/live/pacer';
import {
  ARCHIVE_MIN_THREADS,
  ARCHIVE_ROW_LIMIT_UNITS,
  HISTORY_PAGE_UNITS,
  MAX_PAGES,
  PROFILE_UNITS,
} from '../../../apps/desktop/scripts/live/probes/gmail-archive-delta';
import type { FaultHook, RequestLogEntry } from '../src/kit/types';
import type { RequestCount } from '../../../apps/desktop/scripts/live/types';

const CLIENT = { clientId: 'live-client', clientSecret: 'live-secret' };
const PROBE_ID = 'gmail.archive-delta-cost';

interface Rig {
  emu: GmailEmulator;
  stateDir: string;
  urls: string[];
  run(phase?: string): Promise<{
    counts: Record<string, number>;
    requests: RequestCount[];
    status: string;
    text: string;
  }>;
}

async function rig(threads = 10, faults?: FaultHook): Promise<Rig> {
  const clock = new FakeClock();
  const emu = createGmailEmulator({ clock, latencyMs: 0, faults });
  emu.oauth.addClient(CLIENT.clientId, CLIENT.clientSecret);
  emu.seedMailbox({ threads, seed: 3 });
  const vault = await mkdtemp(join(tmpdir(), 'aplos-live-vault-'));
  const evidence = await mkdtemp(join(tmpdir(), 'aplos-live-evidence-'));
  const stateDir = join(await mkdtemp(join(tmpdir(), 'aplos-live-state-')), 'state');
  const secrets = new Map<string, string>();
  const readSecret = async (service: string) => secrets.get(service)!;
  await signIn(
    { label: 'agent', client: CLIENT },
    {
      fetch: emu.fetch,
      opener: async url => {
        await fetch(new URL(emu.oauth.authorize(url)));
      },
      readSecret,
      writeSecret: async (service, value) => void secrets.set(service, value),
      now: () => clock.now(),
      vaultDir: vault,
      timeoutMs: 5000,
    },
  );
  const urls: string[] = [];
  const deps: RunDeps = {
    env: {
      APLOS_LIVE_VAULT: vault,
      APLOS_GOOGLE_CLIENT_ID: CLIENT.clientId,
      APLOS_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
    },
    fetch: (input, init) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return emu.fetch(input, init);
    },
    readSecret,
    now: () => clock.now(),
    sleep: ms => clock.advance(ms),
    log: () => undefined,
    evidenceDir: evidence,
    stateDir,
    probes: PROBES.filter(p => p.id === PROBE_ID),
  };
  return {
    emu,
    stateDir,
    urls,
    async run(phase) {
      const outcome = await runLive(
        {
          provider: 'gmail',
          tier: 'R',
          account: 'agent',
          dryRun: false,
          confirmMutating: false,
          ...(phase ? { phase } : {}),
        },
        deps,
      );
      return {
        counts: outcome.results[0]!.counts,
        requests: outcome.results[0]!.requests,
        status: outcome.results[0]!.status,
        text: await readFile(outcome.evidencePath!, 'utf8'),
      };
    },
  };
}

const calls = (requests: RequestCount[], api: string) =>
  requests.filter(r => r.method === api).reduce((sum, r) => sum + r.count, 0);

const gmailCalls = (log: RequestLogEntry[], from: number) =>
  log.slice(from).filter(e => e.apiMethod.startsWith('gmail.'));

/**
 * A delta every message joins: archive every inbox thread and add a user label to all threads, so
 * messagesTouched is the whole messageCount whatever the seeded inbox share is.
 */
const bigDelta = (emu: GmailEmulator): void => {
  emu.mailbox.archiveThreads(emu.mailbox.threadCount);
  const label = emu.mailbox.listLabels().find(l => l.type === 'user')!.id;
  const all = emu.mailbox.selectThreads({}).map(t => t.id);
  emu.mailbox.relabel({ threadIds: all }, [label], []);
};

test('mark stores the cursor; measure on a quiet mailbox is unmeasured, never a pass', async () => {
  const r = await rig();
  const marked = await r.run('mark');
  assert.equal(marked.status, 'pass');
  assert.equal(marked.counts.marked, 1);
  assert.ok(marked.counts.threadsTotal > 0, 'the seeded mailbox has threads');
  assert.equal(calls(marked.requests, 'gmail.users.getProfile'), 1);
  assert.equal(marked.requests.length, 1, 'mark asks for the profile only');
  const state = await createProbeState(r.stateDir, PROBE_ID).load();
  assert.match(state?.historyId ?? '', /^\d+$/, 'a decimal cursor was stored');

  const measured = await r.run('measure');
  assert.equal(measured.status, 'fail');
  assert.equal(measured.counts.unmeasured, 1, 'no archive happened, so nothing may be recorded');
  assert.equal(measured.counts.stateMissing, 0);
  assert.equal(measured.counts.historyRecords, 0);
  assert.equal(measured.counts.baselineUpdated, undefined, 'the cursor stays for the real delta');
});

test('mark, a Gmail-web-style archive of 2,000 threads, then measure records the delta cost', async () => {
  const r = await rig(3100);
  await r.run('mark');
  const from = r.emu.log.length;
  bigDelta(r.emu);

  const out = await r.run('measure');
  assert.equal(out.status, 'pass');
  assert.equal(out.counts.unmeasured, 0);
  assert.ok(
    out.counts.historyRecords >= out.counts.messagesTouched,
    'archive plus relabel can write two records for one message',
  );
  assert.ok(
    out.counts.archivedThreads >= 2000,
    `the archive reaches the row's minimum, got ${out.counts.archivedThreads}`,
  );
  assert.ok(out.counts.messagesTouched >= out.counts.archivedThreads);
  assert.equal(out.counts.pagesCapped, 0);
  assert.equal(out.counts.baselineUpdated, 1);
  assert.equal(calls(out.requests, 'gmail.users.history.list'), out.counts.historyPages);
  assert.equal(calls(out.requests, 'gmail.users.getProfile'), 1);
  assert.equal(out.requests.length, 2, 'history pages plus the one re-mark profile');
  assert.ok(
    out.counts.historyPages * HISTORY_PAGE_UNITS + PROFILE_UNITS < ARCHIVE_ROW_LIMIT_UNITS,
    'the measured cost sits under the 100-unit row',
  );

  const sent = gmailCalls(r.emu.log, from);
  assert.ok(
    sent.every(e => e.httpMethod === 'GET' && e.apiMethod !== 'gmail.users.threads.modify'),
    'measure only ever reads',
  );
  assert.ok(!/[@]/.test(out.text), 'the evidence keeps counts only, no addresses');

  // Measuring again right away is honest about the quiet mailbox: unmeasured, not a pass.
  const again = await r.run('measure');
  assert.equal(again.status, 'fail');
  assert.equal(again.counts.unmeasured, 1);
});

test('noise that never archives cannot reach the floor: ~1,000 archived threads fails unmeasured', async () => {
  const r = await rig(2100);
  await r.run('mark');
  const archived = r.emu.mailbox.archiveThreads(1000);
  const label = r.emu.mailbox.listLabels().find(l => l.type === 'user')!.id;
  const all = r.emu.mailbox.selectThreads({}).map(t => t.id);
  r.emu.mailbox.relabel({ threadIds: all }, [label], []);

  const out = await r.run('measure');
  assert.equal(out.status, 'fail');
  assert.equal(out.counts.unmeasured, 1);
  assert.ok(
    out.counts.messagesTouched > 2000,
    `the noise is bigger than the floor and still not an archive: ${out.counts.messagesTouched}`,
  );
  assert.equal(out.counts.archivedThreads, archived.length);
  assert.equal(out.counts.baselineUpdated, undefined, 'the cursor stays for the real archive');
});

test('the measure request carries the adapter historyTypes and exact fields mask', async () => {
  const r = await rig(3100);
  await r.run('mark');
  bigDelta(r.emu);
  const out = await r.run('measure');
  assert.equal(out.status, 'pass');

  const historyUrls = r.urls.map(u => new URL(u)).filter(u => u.pathname.endsWith('/history'));
  assert.ok(historyUrls.length >= 1);
  const url = historyUrls[0]!;
  assert.deepEqual(url.searchParams.getAll('historyTypes').sort(), [
    'labelAdded',
    'labelRemoved',
    'messageAdded',
    'messageDeleted',
  ]);
  // google/history.ts:52 — the exact mask the incremental sync sends.
  assert.equal(
    url.searchParams.get('fields'),
    'history(id,messagesAdded(message(id,threadId,labelIds)),' +
      'messagesDeleted(message(id,threadId,labelIds)),' +
      'labelsAdded(message(id,threadId,labelIds),labelIds),' +
      'labelsRemoved(message(id,threadId,labelIds),labelIds)),nextPageToken,historyId',
  );
  assert.equal(url.searchParams.get('maxResults'), '500');
  assert.match(url.searchParams.get('startHistoryId') ?? '', /^\d+$/);
});

test('a rate limit on history.list fails with the class and no retry', async () => {
  const faults: FaultHook = {
    intercept: request =>
      request.apiMethod === 'gmail.users.history.list'
        ? {
            kind: 'respond',
            response: new Response(
              JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }),
              { status: 429 },
            ),
          }
        : undefined,
  };
  const r = await rig(10, faults);
  await r.run('mark');
  const out = await r.run('measure');
  assert.equal(out.status, 'fail');
  assert.equal(calls(out.requests, 'gmail.users.history.list'), 1, 'a refused page is not retried');
  assert.equal(out.counts.baselineUpdated, undefined);
});

test('a delta past the page cap is a partial cost: pagesCapped, fail, and the cursor is kept', async () => {
  const r = await rig(3100);
  await r.run('mark');
  const cursor = (await createProbeState(r.stateDir, PROBE_ID).load())?.historyId;
  const label = r.emu.mailbox.listLabels().find(l => l.type === 'user')!.id;
  const all = r.emu.mailbox.selectThreads({}).map(t => t.id);
  const msgs = r.emu.mailbox.messageCount;
  // Over 2,000 inbox threads archive, so the floor alone would pass: only the cap stops re-mark.
  r.emu.mailbox.archiveThreads(r.emu.mailbox.threadCount);
  const rounds = Math.ceil((MAX_PAGES * 500) / (2 * msgs)) + 1;
  for (let i = 0; i < rounds; i++) {
    r.emu.mailbox.relabel({ threadIds: all }, [label], []);
    r.emu.mailbox.relabel({ threadIds: all }, [], [label]);
  }

  const out = await r.run('measure');
  assert.equal(out.status, 'fail');
  assert.equal(out.counts.pagesCapped, 1);
  assert.equal(out.counts.historyPages, MAX_PAGES);
  assert.equal(out.counts.baselineUpdated, undefined, 'a capped walk must not re-mark');
  const kept = (await createProbeState(r.stateDir, PROBE_ID).load())?.historyId;
  assert.equal(kept, cursor, 'the mark still points at the start of the unfinished delta');
});

test('the probe constants agree with budgets.json and the pacer table', async () => {
  const budgets = JSON.parse(
    await readFile(new URL('../../../budgets.json', import.meta.url), 'utf8'),
  ) as { rows: { id: string; value: number | null }[] };
  const row = budgets.rows.find(r => r.id === 'sync.archive-2000-units');
  assert.equal(row?.value, ARCHIVE_ROW_LIMIT_UNITS, 'the probe and the row use the same 100 units');
  assert.equal(unitCost('gmail.users.history.list', null), HISTORY_PAGE_UNITS);
  assert.equal(unitCost('gmail.users.getProfile', null), PROFILE_UNITS);
  assert.ok(
    MAX_PAGES * HISTORY_PAGE_UNITS + PROFILE_UNITS < ARCHIVE_ROW_LIMIT_UNITS,
    'even a capped walk spends less than the row',
  );
  assert.equal(ARCHIVE_MIN_THREADS, 2000);
});

test('measure without a mark fails with stateMissing; an expired cursor reports historyExpired', async () => {
  const r = await rig();
  const missing = await r.run('measure');
  assert.equal(missing.status, 'fail');
  assert.equal(missing.counts.stateMissing, 1);

  await r.run('mark');
  r.emu.mailbox.history.expire();
  const expired = await r.run('measure');
  assert.equal(expired.status, 'fail');
  assert.equal(expired.counts.historyExpired, 1);

  // A fresh mark and a big enough delta recover: the failed run left no false baseline.
  const r2 = await rig(3100);
  await r2.run('mark');
  bigDelta(r2.emu);
  const recovered = await r2.run('measure');
  assert.equal(recovered.status, 'pass');
  assert.equal(recovered.counts.historyExpired, 0);
});

test('no phase or an unknown phase is a skip; the probe never writes', async () => {
  const r = await rig();
  const none = await r.run();
  assert.equal(none.status, 'skip');
  const unknown = await r.run('inspect');
  assert.equal(unknown.status, 'skip');
  assert.ok(
    !r.emu.log.some(e => /modify|send|delete|trash|create|update/i.test(e.apiMethod)),
    'only reads went out',
  );
});
