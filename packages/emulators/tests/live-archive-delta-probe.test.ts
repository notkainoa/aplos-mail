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
import type { RequestCount } from '../../../apps/desktop/scripts/live/types';

const CLIENT = { clientId: 'live-client', clientSecret: 'live-secret' };
const PROBE_ID = 'gmail.archive-delta-cost';

interface Rig {
  emu: GmailEmulator;
  stateDir: string;
  run(phase?: string): Promise<{
    counts: Record<string, number>;
    requests: RequestCount[];
    status: string;
    text: string;
  }>;
}

async function rig(threads = 10): Promise<Rig> {
  const clock = new FakeClock();
  const emu = createGmailEmulator({ clock, latencyMs: 0 });
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
  const deps: RunDeps = {
    env: {
      APLOS_LIVE_VAULT: vault,
      APLOS_GOOGLE_CLIENT_ID: CLIENT.clientId,
      APLOS_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
    },
    fetch: emu.fetch,
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

test('mark stores the cursor; measure over a quiet mailbox walks one empty page and re-marks', async () => {
  const r = await rig();
  const marked = await r.run('mark');
  assert.equal(marked.status, 'pass');
  assert.equal(marked.counts.marked, 1);
  assert.ok(marked.counts.threadsTotal > 0, 'the seeded mailbox has threads');
  const state = await createProbeState(r.stateDir, PROBE_ID).load();
  assert.match(state?.historyId ?? '', /^\d+$/, 'a decimal cursor was stored');

  const measured = await r.run('measure');
  assert.equal(measured.status, 'pass');
  assert.equal(measured.counts.stateMissing, 0);
  assert.equal(measured.counts.historyRecords, 0);
  assert.equal(measured.counts.historyPages, 1);
  assert.equal(measured.counts.historyExpired, 0);
  assert.equal(measured.counts.pagesCapped, 0);
  assert.equal(measured.counts.baselineUpdated, 1);
});

test('mark, a Gmail-web-style archive, then measure counts the delta in history pages', async () => {
  const r = await rig();
  await r.run('mark');
  const archived = r.emu.mailbox.archiveThreads(3);
  assert.equal(archived.length, 3);

  const out = await r.run('measure');
  assert.equal(out.status, 'pass');
  assert.equal(out.counts.historyPages, 1);
  // The emulator writes one labelsRemoved record per archived message, each naming that message.
  assert.ok(
    out.counts.historyRecords >= archived.length,
    `one record per archived message, got ${out.counts.historyRecords}`,
  );
  assert.equal(out.counts.messagesTouched, out.counts.historyRecords);
  assert.equal(calls(out.requests, 'gmail.users.history.list'), 1);
  assert.ok(!/[@]/.test(out.text), 'the evidence keeps counts only, no addresses');

  // Measuring again right away sees a quiet mailbox: the walk left the newest cursor behind.
  const again = await r.run('measure');
  assert.equal(again.counts.historyRecords, 0);
});

test('measure walks pages: an archive of 600 threads costs pages, not messages, of units', async () => {
  const r = await rig(600);
  await r.run('mark');
  r.emu.mailbox.archiveThreads(600);
  const out = await r.run('measure');
  assert.equal(out.status, 'pass');
  assert.ok(out.counts.historyRecords > 500, `${out.counts.historyRecords} records`);
  assert.ok(out.counts.historyPages >= 2, `paged: ${out.counts.historyPages} pages`);
  assert.ok(
    out.counts.historyPages * 2 <= 100,
    'the budget row records under 100 units for thousands of changes',
  );
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

  // A fresh mark and measure recover: the failed run left no false baseline.
  await r.run('mark');
  const recovered = await r.run('measure');
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
