/**
 * prov-gmail first sync on the Gmail emulator: D1 inverted, the P1 call measurement, the commit cadence, the run memo
 * and a stale re-run. Every number here is fake-clock time and emulator-charged units; nothing touches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaultInjector } from '@aplos/emulators';
import { gmailLog, peakWindowUnits, refusals, rig, upsertThreads, type Rig } from './harness';

const windowDone = (r: Rig) => () => r.store.states.get('window:inbox')?.phase === 'done';
const unitsSince = (r: Rig, since: number) =>
  r.emu.log.filter(e => e.at >= since).reduce((sum, e) => sum + e.units, 0);
const costUnits = (r: Rig) => r.store.commits.reduce((sum, c) => sum + c.result.costUnits, 0);

interface WindowRun {
  baselineMs: number;
  windowMs: number;
  threads: number;
  units: number;
  peak: number;
  refused: number;
}

async function firstWindow(r: Rig): Promise<WindowRun> {
  const start = r.clock.now();
  await r.drive({ until: windowDone(r), maxSteps: 200 });
  return {
    baselineMs: (r.store.baselineAt ?? Infinity) - start,
    windowMs: r.clock.now() - start,
    threads: r.store.threadsIn('INBOX').size,
    units: unitsSince(r, start),
    peak: peakWindowUnits(r.emu),
    refused: refusals(r.emu).length,
  };
}

test('prov-gmail-T04 D1 inverted: a 600-thread mailbox finishes its first window with zero refusals', async t => {
  const r = await rig({ threads: 600 });
  const inbox = r.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).length;
  const run = await firstWindow(r);
  t.diagnostic(
    `600 threads (${inbox} in the Inbox): baseline ${run.baselineMs} ms, window ${run.windowMs} ms, ${run.units} units, peak ${run.peak}/60 s`,
  );
  assert.equal(r.store.states.get('window:inbox')?.phase, 'done');
  assert.equal(run.threads, inbox, 'every Inbox thread is in the store');
  assert.equal(run.refused, 0, 'zero 403/429 in the emulator log');
  assert.ok(run.peak <= 3_000, `units in any 60 s window: ${run.peak}`);
  assert.ok(r.emu.meter.peakWindow() <= 3_000, 'the emulator meter agrees');
  assert.ok(run.baselineMs <= 15_000, `first 50 threads committed after ${run.baselineMs} ms`);
  assert.equal(costUnits(r), run.units, 'costUnits equals what the emulator charged');
  assert.equal(r.governor.maxInFlight, 1);
});

test('prov-gmail-T05/T06/T07 P1 call measured: messages.get metadata meets 50 in 15 s and 500 in about 4 min at 3,000/min', async t => {
  const results: Record<string, WindowRun> = {};
  for (const windowCall of ['messages.get', 'threads.get'] as const) {
    const r = await rig({ threads: 800, adapter: { windowCall } });
    results[windowCall] = await firstWindow(r);
    const run = results[windowCall];
    t.diagnostic(
      `${windowCall}: first 50 at ${(run.baselineMs / 1000).toFixed(1)} s, ${run.threads} threads at ${(run.windowMs / 1000).toFixed(1)} s, ` +
        `${run.units} units, peak ${run.peak}/60 s, ${run.refused} refusals`,
    );
    assert.equal(run.refused, 0);
    assert.ok(run.peak <= 3_000);
  }
  const chosen = results['messages.get'];
  assert.ok(chosen.threads >= 500, 'the window holds 500 threads');
  assert.ok(chosen.baselineMs <= 15_000, 'first 50 threads in under 15 s');
  // Every listed Inbox message becomes a row (D8): a new thread whose page lists several costs one threads.get (40)
  // instead of its newest message's messages.get (20). On this mailbox that is about a third more than newest-only.
  assert.ok(
    chosen.windowMs <= 300_000,
    `500 threads in about 4 minutes (took ${chosen.windowMs} ms)`,
  );
  assert.ok(chosen.units <= 14_000, `units ${chosen.units} <= 14,000`);
  assert.ok(
    results['threads.get'].windowMs > chosen.windowMs * 1.5,
    'threads.get metadata is the slower call at this target',
  );
});

test('prov-gmail-T09/T10 D19 every list and get names a fields mask, asks for gzip and says gzip in its User-Agent', async () => {
  const r = await rig({ threads: 120 });
  await r.drive({ until: windowDone(r) });
  const gmail = r.fetches.filter(f => f.path.startsWith('/gmail/') || f.path.startsWith('/batch/'));
  assert.ok(gmail.length > 3);
  for (const f of gmail) {
    assert.equal(f.headers.get('accept-encoding'), 'gzip');
    assert.match(f.headers.get('user-agent') ?? '', /gzip/);
    if (f.path.startsWith('/batch/')) {
      const parts = [...f.body!.matchAll(/^GET (\S+) HTTP/gm)].map(m => m[1]);
      assert.ok(parts.length > 1);
      for (const part of parts) assert.match(part, /[?&]fields=/);
    } else assert.ok(f.query.has('fields'), `${f.path} has a fields mask`);
  }
  // Metadata gets name ARCH 5.1's nine headers (plus List-Unsubscribe-Post and the threading headers).
  const batch = gmail.find(f => f.path.startsWith('/batch/'))!;
  const first = new URLSearchParams(/\?(\S+) HTTP/.exec(batch.body!)![1]);
  const headers = first.getAll('metadataHeaders');
  for (const h of [
    'From',
    'To',
    'Cc',
    'Subject',
    'Date',
    'Message-ID',
    'List-Unsubscribe',
    'Precedence',
    'Auto-Submitted',
    'List-Unsubscribe-Post',
  ]) {
    assert.ok(headers.includes(h), `asks for ${h}`);
  }
  // D16: the window lists the Inbox only, never spam or trash.
  for (const f of gmail.filter(f => f.path.endsWith('/messages') && f.method === 'GET')) {
    assert.ok(f.query.getAll('labelIds').length > 0);
    assert.ok(!f.query.has('includeSpamTrash'));
  }
});

test('prov-gmail-T11 D1 the window commits about 50 threads at a time with partial rows, baselineReached once', async () => {
  const r = await rig({ threads: 600 });
  await r.drive({ until: windowDone(r) });
  const windowCommits = r.store.commits.filter(c => c.step.scope === 'window:inbox');
  assert.ok(windowCommits.length >= 9, `${windowCommits.length} window commits`);
  for (const c of windowCommits) {
    assert.ok(upsertThreads(c.result) <= 50, 'at most 50 fetched threads per commit');
    for (const u of c.result.upserts ?? []) assert.equal(u.partial, true);
    const own = c.result.nextStates.find(s => s.scope === 'window:inbox')!;
    if (own.phase !== 'done')
      assert.ok(own.pending?.length || own.pageToken, 'each commit carries where to resume');
  }
  assert.equal(windowCommits.filter(c => c.result.baselineReached).length, 1);
  assert.equal(windowCommits[0].result.baselineReached, true, 'the first chunk is the baseline');
  assert.ok(windowCommits.at(-1)!.result.scopeCovered, 'the completed round may sweep');
  const origins = new Set(windowCommits.slice(1).map(c => c.step.origin));
  assert.deepEqual(
    [...origins],
    ['backfill'],
    'pages after the baseline are backfill: no notifications',
  );
});

test('prov-gmail-T16 D1 D8 one metadata call per thread, no message fetched twice, and every Inbox message stored', async t => {
  const r = await rig({ threads: 600 });
  await r.drive({ until: windowDone(r) });
  const gets = r.metadataGets();
  assert.equal(new Set(gets).size, gets.length, 'no entry fetched twice');
  // No message arrives twice, whether on its own or inside a threads.get.
  const upserted = r.store.commits
    .filter(c => c.step.scope === 'window:inbox')
    .flatMap(c => (c.result.upserts ?? []).map(u => u.remoteId));
  assert.equal(new Set(upserted).size, upserted.length, 'no message fetched twice');
  // D8: Gmail keeps labels per message, so every Inbox message is a row, not only each thread's newest.
  const inboxMessages = r.emu.mailbox.select({ labelIds: ['INBOX'] });
  for (const m of inboxMessages)
    assert.ok(r.store.rows.get(m.id)?.folders.has('INBOX'), 'every Inbox message is a row');
  const perThread = new Map<string, number>();
  for (const m of inboxMessages) perThread.set(m.threadId, (perThread.get(m.threadId) ?? 0) + 1);
  const threadGets = gets.filter(g => g.startsWith('thread:'));
  t.diagnostic(
    `${perThread.size} Inbox threads, ${inboxMessages.length} Inbox messages: ${gets.length - threadGets.length} messages.get, ${threadGets.length} threads.get`,
  );
  for (const g of threadGets)
    assert.ok(
      (perThread.get(g.slice('thread:'.length)) ?? 0) >= 2,
      'threads.get only for a thread with several Inbox messages',
    );
  assert.ok(
    gets.length >= perThread.size && gets.length < inboxMessages.length,
    'about one call per thread, fewer than one per message',
  );
});

test('prov-gmail-T12 D1 a pause mid-chunk returns partial facts and pending ids; the resume fetches only the rest', async () => {
  const r = await rig({ threads: 600 });
  await r.drive({ maxSteps: 1 }); // P0
  r.governor.pauseAfter = 3; // the list and two batches of 10 go out, then a refusal elsewhere pauses the account
  const step = r.adapter.plan({
    account: r.account,
    states: [...r.store.states.values()],
    trigger: 'poll',
    env: r.env(),
    memory: r.store.memory,
  })[0];
  assert.equal(step.scope, 'window:inbox');
  const partial = await r.adapter.syncStep(step, r.store.state('window:inbox'), r.ctx());
  assert.equal(partial.done, false);
  assert.equal(upsertThreads(partial), 20, 'two batches of 10 threads');
  assert.equal(partial.scopeCovered, undefined);
  const resumeState = partial.nextStates.find(s => s.scope === 'window:inbox')!;
  assert.ok(resumeState.pending!.length > 30, 'the unfetched ids are pending');
  r.store.commit(step, partial, r.clock.now());

  // A manual re-plan during the pause makes zero requests.
  const before = r.fetches.length;
  for (let i = 0; i < 20; i++) await r.drive({ trigger: 'manual', maxSteps: 3 });
  assert.equal(r.fetches.length, before, 'no request while paused');

  await r.clock.advance(61_000);
  await r.drive({ trigger: 'resume', until: windowDone(r) });
  const gets = r.metadataGets();
  assert.equal(new Set(gets).size, gets.length, 'each entry fetched exactly once across the pause');
  assert.equal(
    r.store.threadsIn('INBOX').size,
    r.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).length,
  );
});

test('prov-gmail-T12 D1 per-run memo: a step that fails after two batches does not re-spend them', async () => {
  const faults = createFaultInjector();
  const r = await rig({ threads: 600, emulator: { faults } });
  await r.drive({ maxSteps: 1 }); // P0
  faults.failNext({ apiMethod: 'gmail.batch', after: 2 }, { status: 503, reason: 'backendError' });
  const step = r.adapter.plan({
    account: r.account,
    states: [...r.store.states.values()],
    trigger: 'poll',
    env: r.env(),
    memory: r.store.memory,
  })[0];
  await assert.rejects(
    r.adapter.syncStep(step, r.store.state('window:inbox'), r.ctx()),
    (e: Error & { error?: { class: string } }) => e.error?.class === 'transient',
  );
  const firstTry = r.metadataGets().length;
  assert.equal(firstTry, 30, 'two batches answered, the third refused as a whole');
  // Nothing was committed; the re-run takes the 20 answered from the memo.
  const again = await r.adapter.syncStep(step, r.store.state('window:inbox'), r.ctx());
  assert.equal(again.done, true);
  assert.equal(upsertThreads(again), 50);
  const gets = r.metadataGets();
  const answered = gets.slice(0, 20);
  for (const id of answered)
    assert.equal(gets.filter(g => g === id).length, 1, 'a memo hit is never fetched again');
});

test('prov-gmail-T15 D1 a stale re-run (everything committed, nothing changed) costs under 100 units', async t => {
  const r = await rig({ threads: 600 });
  await r.drive({
    until: () => windowDone(r)() && r.store.states.get('sent:recent')?.phase === 'done',
    maxSteps: 300,
  });
  assert.equal(r.store.states.get('sent:recent')?.phase, 'done');
  await r.clock.advance(5 * 60_000);
  // A restart: a new adapter (empty memo) over the same committed state.
  const { GmailAdapter } = await import('../../src/host/providers/google/adapter');
  const fresh = new GmailAdapter(r.account, { fetch: r.emu.fetch });
  const start = r.clock.now();
  const steps = fresh.plan({
    account: r.account,
    states: [...r.store.states.values()],
    trigger: 'first',
    env: r.env(),
    memory: r.store.memory,
  });
  for (const step of steps.filter(s => (s.notBefore ?? 0) <= r.clock.now())) {
    r.store.commit(
      step,
      await fresh.syncStep(step, r.store.state(step.scope), r.ctx()),
      r.clock.now(),
    );
  }
  const units = unitsSince(r, start);
  const gets = gmailLog(r.emu, start).filter(e => /\.get$/.test(e.apiMethod));
  t.diagnostic(`stale re-run: ${units} units, steps ${steps.map(s => s.scope).join(', ')}`);
  assert.ok(units < 100, `${units} units`);
  assert.equal(gets.length, 0, 'no get-by-id requests');
});
