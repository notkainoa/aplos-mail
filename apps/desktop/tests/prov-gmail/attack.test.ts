/**
 * Adversarial review of the prov-gmail read path (plan 20 PV0 "verify adversarially", test-plans ADV-01..ADV-11).
 * Written by a reviewer who did not write the adapter, from the code, the Gmail emulator and Google's own documents
 * (proto-google.md) only. Each test names the check it tries to break; a failing test is a finding, not a test bug.
 * Synthetic data only (example.test), fake clock, the emulator's fetch only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFaultInjector, type GmailEmulator } from '@aplos/emulators';
import { PausedError, type PlannedStep } from '@aplos/engine/ports';
import { GMAIL_BUDGET, GmailAdapter } from '../../src/host/providers/google/adapter';
import { gmailLog, peakWindowUnits, rig, type Rig } from './harness';

const GOOGLE_DIR = join(import.meta.dirname, '../../src/host/providers/google');
const windowDone = (r: Rig) => () => r.store.states.get('window:inbox')?.phase === 'done';
const unitsSince = (r: Rig, since: number) =>
  r.emu.log.filter(e => e.at >= since).reduce((sum, e) => sum + e.units, 0);
const gets = (r: Rig, since: number) =>
  gmailLog(r.emu, since).filter(e => /(messages|threads)\.get$/.test(e.apiMethod));
const HOUR = 3_600_000;

async function historyPass(r: Rig): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
    if (!/^pass:/.test(r.store.states.get('history')?.phase ?? '')) return;
  }
  throw new Error('history pass did not finish');
}

async function synced(r: Rig): Promise<Rig> {
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.clock.advance(60_000);
  return r;
}

const planNow = (r: Rig, trigger: 'manual' | 'poll' | 'resume' = 'manual'): PlannedStep[] =>
  r.adapter.plan({
    account: r.account,
    states: [...r.store.states.values()],
    trigger,
    env: r.env(),
    memory: r.store.memory,
  });

/** A fetch that answers like Google's documented history shape: "History messages typically only have id and threadId". */
function strippedHistoryFetch(holder: { emu?: GmailEmulator }): typeof fetch {
  return async (input, init) => {
    const response = await holder.emu!.fetch(input, init);
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.pathname.endsWith('/history') || !response.ok) return response;
    const body = JSON.parse(await response.text()) as {
      history?: Record<string, { message: { labelIds?: string[] } }[]>[];
    };
    for (const record of body.history ?? []) {
      for (const key of ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) {
        for (const entry of record[key] ?? []) delete entry.message.labelIds;
      }
    }
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

// ---- ADV-01/02: two requests in flight, more than 3,000 units in 60 s ----

test('ADV-01/02 at most one request in flight and <= 3,000 units/60 s while open, search and the window race', async t => {
  const r = await rig({ threads: 800 });
  const known = r.emu.mailbox
    .selectThreads({ labelIds: ['INBOX'] })
    .slice(0, 12)
    .map(th => th.id);
  const racing = (async () => {
    for (const id of known) {
      await r.clock.advance(3_000);
      await Promise.all([
        r.adapter.openThread({ remoteThreadId: id }, 'interactive', r.ctx()),
        r.adapter.search({ text: 'synthetic', limit: 25 }, r.ctx()),
      ]);
    }
  })();
  await Promise.all([r.drive({ until: windowDone(r), maxSteps: 300 }), racing]);
  const direct = r.emu.log.filter(e => e.service === 'gmail' && e.batch === undefined);
  const maxInFlight = Math.max(...direct.map(e => e.inFlight));
  t.diagnostic(
    `max in flight at the emulator ${maxInFlight}, peak ${peakWindowUnits(r.emu)} units/60 s`,
  );
  assert.equal(maxInFlight, 1);
  assert.ok(peakWindowUnits(r.emu) <= 3_000);
});

test('ADV-01/02 the shipped Gmail budget itself says one in flight and a 3,000-unit target (plan 20 PV0 item 1)', () => {
  // The only thing that keeps the tests under 3,000 and at one in flight is the test harness's StubGovernor. A
  // governor that honours the BudgetSpec this adapter ships would run 3 in flight at 4,500 units a minute.
  assert.ok(
    GMAIL_BUDGET.target.primary <= 3_000,
    `GMAIL_BUDGET.target.primary = ${GMAIL_BUDGET.target.primary}`,
  );
  assert.equal(GMAIL_BUDGET.inFlight, 1, `GMAIL_BUDGET.inFlight = ${GMAIL_BUDGET.inFlight}`);
});

test('ADV-01/02 a src pacer (GovernorPort stub for Google) exists until prov-gov lands (plan 20 PV0 item 1)', () => {
  const src = readdirSync(GOOGLE_DIR)
    .map(f => readFileSync(join(GOOGLE_DIR, f), 'utf8'))
    .join('\n');
  assert.ok(
    /implements (BoundGovernor|GovernorPort)/.test(src),
    'no pacer under host/providers/google: prov-gmail can run unpaced',
  );
});

// ---- ADV-03: retries (requests per id) ----

test('ADV-03 no Gmail id is fetched twice across a whole first sync (window, Sent, backfill)', async t => {
  const r = await rig({ threads: 800 });
  const allDone = () =>
    ['window:inbox', 'sent:recent', 'backfill:inbox'].every(
      s => r.store.states.get(s as never)?.phase === 'done' || !r.store.states.has(s as never),
    ) && windowDone(r)();
  await r.drive({ until: allDone, maxSteps: 600 });
  const ids = r.metadataGets();
  const perId = new Map<string, number>();
  for (const id of ids) perId.set(id, (perId.get(id) ?? 0) + 1);
  const twice = [...perId].filter(([, n]) => n > 1);
  // Per message, across the three list scopes: nothing a scope stored is fetched again by another. A thread may gain
  // rows in P5 when an older Inbox message of it sat past the window's last page: that message is new to this device
  // and must become a row (proto-google D8, per-message labels), so it is not a re-fetch. (Reviewer's per-thread
  // count reformulated per message by the lane: see the D8 finding.)
  const perMessage = new Map<string, string[]>();
  for (const c of r.store.commits.filter(c =>
    ['window:inbox', 'backfill:inbox', 'sent:recent'].includes(c.step.scope),
  )) {
    for (const u of c.result.upserts ?? [])
      perMessage.set(u.remoteId, [...(perMessage.get(u.remoteId) ?? []), c.step.scope]);
  }
  const refetched = [...perMessage].filter(([, v]) => v.length > 1);
  const windowThreads = new Set(
    r.store.commits
      .filter(c => c.step.scope === 'window:inbox')
      .flatMap(c => (c.result.upserts ?? []).map(u => u.remoteThreadId)),
  );
  const extended = new Set(
    r.store.commits
      .filter(c => c.step.scope === 'backfill:inbox')
      .flatMap(c => (c.result.upserts ?? []).map(u => u.remoteThreadId))
      .filter(t => windowThreads.has(t)),
  );
  t.diagnostic(
    `re-fetched messages by scope: ${JSON.stringify(refetched.map(([, v]) => v.join('+')))}`,
  );
  t.diagnostic(
    `${ids.length} metadata gets; ${twice.length} entries fetched twice; ${refetched.length} messages fetched twice; ${extended.size} window threads gained older Inbox messages in backfill`,
  );
  assert.equal(twice.length, 0, 'an id fetched twice');
  assert.equal(refetched.length, 0, 'a scope re-fetches messages another scope already stored');
});

// ---- ADV-04: a request after quotaExceeded ----

test('ADV-04 quotaExceeded inside a batch part: zero Gmail requests until Pacific midnight, whatever is called', async () => {
  const faults = createFaultInjector();
  const r = await rig({ threads: 600, emulator: { faults } });
  await r.drive({ maxSteps: 1 }); // P0
  faults.failNext(
    { apiMethod: 'gmail.users.messages.get', after: 13 },
    {
      status: 403,
      reason: 'quotaExceeded',
      message:
        "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'gmail.googleapis.com'.",
    },
  );
  await r.drive({ trigger: 'manual', maxSteps: 5 });
  const refused = r.emu.log.find(e => e.reason === 'quotaExceeded');
  assert.ok(refused, 'the part was refused');
  const after = r.emu.log.length;
  const thread = r.emu.mailbox.selectThreads({ labelIds: ['INBOX'] })[0].id;
  for (let i = 0; i < 100; i++) {
    await r.clock.advance(5 * 60_000);
    await r.drive({ trigger: 'manual', maxSteps: 3 });
    await r.adapter
      .openThread({ remoteThreadId: thread }, 'interactive', r.ctx())
      .catch(e => assert.ok(e instanceof PausedError));
    await r.adapter
      .search({ text: 'synthetic', limit: 25 }, r.ctx())
      .catch(e => assert.ok(e instanceof PausedError));
    if (r.clock.now() >= r.governor.dailyUntil - 5 * 60_000) break;
  }
  const during = r.emu.log.slice(after).filter(e => e.at < r.governor.dailyUntil);
  assert.equal(during.length, 0, `${during.length} requests before the daily reset`);
});

// ---- ADV-05: a loop on invalid_grant ----

test('ADV-05 invalid_grant: one refused refresh, then zero Gmail and token calls for 24 h of syncs, opens and searches', async () => {
  const r = await rig({ threads: 120 });
  await synced(r);
  r.emu.oauth.revoke(r.account.address);
  r.emu.oauth.expireAccessTokens();
  await r.drive({ trigger: 'manual', maxSteps: 3 });
  const tokenCalls = () => r.emu.log.filter(e => e.service !== 'gmail').length;
  const firstTokens = tokenCalls();
  const firstGmail = gmailLog(r.emu).length;
  const thread = [...r.store.rows.values()][0].facts.remoteThreadId;
  for (let i = 0; i < 48; i++) {
    await r.clock.advance(30 * 60_000);
    await r.drive({ trigger: 'manual', maxSteps: 3 });
    await r.adapter.openThread({ remoteThreadId: thread }, 'interactive', r.ctx()).catch(() => {});
    await r.adapter.search({ text: 'synthetic', limit: 25 }, r.ctx()).catch(() => {});
  }
  assert.equal(gmailLog(r.emu).length, firstGmail, 'no Gmail call after the reauth block');
  assert.equal(tokenCalls(), firstTokens, 'no token call after the refused refresh');
  assert.equal(r.governor.blocked?.reason, 'invalid_grant');
});

// ---- ADV-06: a request during a pause ----

test('ADV-06 a throttle mid-window: zero requests for 100 manual re-plans, opens, searches and attachment reads', async () => {
  const faults = createFaultInjector();
  const r = await rig({ threads: 600, emulator: { faults } });
  await r.drive({ maxSteps: 2 });
  faults.failNext(
    { apiMethod: 'gmail.batch' },
    { status: 429, reason: 'rateLimitExceeded', retryAfterSeconds: 120 },
  );
  await r.drive({ trigger: 'manual', maxSteps: 3 });
  assert.ok(r.governor.pausedUntil > r.clock.now());
  const before = r.fetches.length;
  const stored = [...r.store.rows.values()][0].facts;
  for (let i = 0; i < 100; i++) {
    await r.drive({ trigger: 'manual', maxSteps: 3 });
    await r.adapter
      .openThread({ remoteThreadId: stored.remoteThreadId }, 'interactive', r.ctx())
      .catch(() => {});
    await r.adapter.search({ text: 'synthetic', limit: 25 }, r.ctx()).catch(() => {});
    await r.adapter
      .fetchAttachment({ remoteMessageId: stored.remoteId, part: 'x' } as never, r.ctx())
      .catch(() => {});
  }
  assert.equal(r.fetches.length, before, 'no request while paused');
});

// ---- ADV-08: false deletion / lost INBOX placement ----

test('ADV-08 D8 trashing the newest reply of a 3-message Inbox thread keeps the conversation in the local Inbox', async t => {
  const r = await rig({ threads: 120 });
  const now = r.clock.now();
  const m1 = r.emu.mailbox.addMessage({
    from: 'Ada Quill <ada.quill@mail.example.test>',
    subject: 'Synthetic trip',
    text: 'one',
    labelIds: ['INBOX'],
    internalDate: now - 3 * HOUR,
  });
  const m2 = r.emu.mailbox.addMessage({
    from: 'Ada Quill <ada.quill@mail.example.test>',
    text: 'two',
    labelIds: ['INBOX'],
    replyTo: m1.id,
    internalDate: now - 2 * HOUR,
  });
  const m3 = r.emu.mailbox.addMessage({
    from: 'Ada Quill <ada.quill@mail.example.test>',
    text: 'three',
    labelIds: ['INBOX'],
    replyTo: m2.id,
    internalDate: now - HOUR,
  });
  await synced(r);
  assert.ok(r.store.threadsIn('INBOX').has(m1.threadId));
  t.diagnostic(
    `stored rows of the thread after the window: ${[m1, m2, m3].filter(m => r.store.rows.has(m.id)).length} of 3`,
  );
  r.emu.mailbox.trashMessage(m3.id); // one reply deleted in Gmail web
  await historyPass(r);
  assert.ok(
    r.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).some(th => th.id === m1.threadId),
    'server: still in the Inbox',
  );
  assert.ok(
    r.store.threadsIn('INBOX').has(m1.threadId),
    'local: the conversation left the Inbox because only its newest message was stored',
  );
});

test('ADV-08 archiving only the newest message must not drop the older Inbox messages of the thread', async () => {
  const r = await rig({ threads: 120 });
  const now = r.clock.now();
  const a1 = r.emu.mailbox.addMessage({
    from: 'Bo Tern <bo.tern@mail.example.test>',
    subject: 'Synthetic rota',
    text: 'one',
    labelIds: ['INBOX'],
    internalDate: now - 2 * HOUR,
  });
  const a2 = r.emu.mailbox.addMessage({
    from: 'Bo Tern <bo.tern@mail.example.test>',
    text: 'two',
    labelIds: ['INBOX'],
    replyTo: a1.id,
    internalDate: now - HOUR,
  });
  await synced(r);
  r.emu.mailbox.relabel({ messageIds: [a2.id] }, [], ['INBOX']);
  await historyPass(r);
  assert.ok(
    r.emu.mailbox.getMessage(a1.id)!.labelIds.includes('INBOX'),
    'server: a1 is in the Inbox',
  );
  assert.ok(
    r.store.threadsIn('INBOX').has(a1.threadId),
    'local: the thread lost its Inbox placement',
  );
});

test('ADV-08 D10 control: a capped resync (51 Inbox threads left) sweeps the ghosts newer than its bound', async () => {
  const r = await synced(await rig({ threads: 600 }));
  const inbox = r.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).length;
  const ghosts = r.emu.mailbox.archiveThreads(inbox - 51);
  r.emu.mailbox.expireHistory();
  await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
  await r.drive({ trigger: 'reset', until: windowDone(r), maxSteps: 20 });
  const left = ghosts.filter(id => r.store.threadsIn('INBOX').has(id));
  assert.equal(left.length, 0, `${left.length} ghosts left`);
});

test('ADV-08 D10 a resync whose Inbox has exactly 50 threads lists the whole Inbox but never sweeps its ghosts', async () => {
  const r = await synced(await rig({ threads: 600 }));
  const inbox = r.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).length;
  const ghosts = r.emu.mailbox.archiveThreads(inbox - 50);
  r.emu.mailbox.expireHistory();
  await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
  assert.equal(r.store.commits.at(-1)!.result.reset, 'cursorExpired');
  await r.drive({ trigger: 'reset', until: windowDone(r), maxSteps: 20 });
  const left = ghosts.filter(id => r.store.threadsIn('INBOX').has(id));
  assert.equal(
    left.length,
    0,
    `${left.length} of ${ghosts.length} archived threads still in the local Inbox (no scopeCovered: read == cap, no nextPageToken)`,
  );
});

test('ADV-08 D10 a thread re-inboxed during a paused resync is falsely swept from the Inbox', async t => {
  const r = await synced(await rig({ threads: 600 }));
  const victimThread = r.emu.mailbox.selectThreads({ labelIds: ['INBOX'] })[4].id;
  const victim = r.emu.mailbox
    .select({ labelIds: ['INBOX'] })
    .find(m => m.threadId === victimThread)!.id;
  assert.ok(r.store.rows.get(victim)?.folders.has('INBOX'));
  // While away: the thread is archived, three new mails arrive, the cursor expires.
  r.emu.mailbox.relabel({ threadIds: [victimThread] }, [], ['INBOX']);
  for (let i = 0; i < 3; i++)
    r.emu.mailbox.addMessage({
      from: 'Cy Wren <cy.wren@mail.example.test>',
      subject: `Synthetic ${i}`,
      text: 'x',
      labelIds: ['INBOX'],
    });
  r.emu.mailbox.expireHistory();
  await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 }); // 404 -> reset
  await r.drive({ trigger: 'reset', scopes: ['history'], maxSteps: 1 }); // P0: a fresh cursor
  // P0 already delivered the three arrivals; one more lands after it, so the resync still has a fetch to be paused in.
  r.emu.mailbox.addMessage({
    from: 'Cy Wren <cy.wren@mail.example.test>',
    subject: 'Synthetic late',
    text: 'x',
    labelIds: ['INBOX'],
  });
  r.governor.pauseAfter = 2; // the list and the date probe go out, then the batch meets a pause
  await r.drive({ trigger: 'reset', scopes: ['window:inbox'], maxSteps: 1 });
  assert.equal(r.store.states.get('window:inbox')?.phase, 'resyncing');
  // The user moves the thread back to the Inbox; history sees it as a zero-cost label delta.
  r.emu.mailbox.relabel({ threadIds: [victimThread] }, ['INBOX'], []);
  await r.clock.advance(61_000);
  await r.drive({ trigger: 'resume', scopes: ['history'], maxSteps: 1 });
  await r.drive({
    trigger: 'resume',
    until: windowDone(r),
    scopes: ['window:inbox'],
    maxSteps: 10,
  });
  assert.ok(r.store.commits.at(-1)!.result.scopeCovered, 'the resync swept');
  const historyDelta = r.store.commits
    .filter(c => c.step.scope === 'history')
    .flatMap(c => c.result.labelDeltas ?? [])
    .find(d => d.remoteId === victim);
  t.diagnostic(
    `history gave ${JSON.stringify(historyDelta)}; swept by the resync: ${r.store.swept.includes(victim)}`,
  );
  assert.ok(r.emu.mailbox.getMessage(victim)!.labelIds.includes('INBOX'), 'server: in the Inbox');
  assert.ok(
    r.store.rows.get(victim)?.folders.has('INBOX'),
    'local: swept out of the Inbox although the server has it there',
  );
});

// ---- ADV-09: drafts (D9) ----

test('ADV-09 D9 server search never returns a phone draft as a thread message', async () => {
  const r = await rig({ threads: 60 });
  const draft = r.emu.mailbox.createDraftElsewhere({
    to: ['dee.finch@mail.example.test'],
    subject: 'Quokkadraft plans',
    text: 'quokkadraft',
  });
  const found = await r.adapter.search({ text: 'quokkadraft', limit: 25 }, r.ctx());
  assert.ok(
    !found.upserts.some(u => u.remoteId === draft.messageId),
    'the draft came back as a message row',
  );
  assert.ok(
    !found.remoteThreadIds.includes(draft.threadId),
    'the draft-only thread came back as a result',
  );
});

test("ADV-09 D9 with Google's documented history shape (id and threadId only) a phone draft is not fetched as a message", async () => {
  const holder: { emu?: GmailEmulator } = {};
  const r = await rig({ threads: 600, adapter: { fetch: strippedHistoryFetch(holder) } });
  holder.emu = r.emu;
  await synced(r);
  const draft = r.emu.mailbox.createDraftElsewhere({
    to: ['dee.finch@mail.example.test'],
    subject: 'Synthetic draft',
    text: 'draft',
  });
  const start = r.clock.now();
  await historyPass(r);
  assert.equal(gets(r, start).length, 0, 'the draft was fetched');
  assert.ok(!r.store.rows.has(draft.messageId), 'the draft is now a thread row');
});

test('ADV-09 D9 a phone draft deleted or sent on the phone leaves Drafts, and the sent reply joins the thread', async () => {
  const r = await synced(await rig({ threads: 600 }));
  const known = [...r.store.rows.values()][0].facts;
  const a = r.emu.mailbox.createDraftElsewhere({
    to: ['dee.finch@mail.example.test'],
    subject: 'Re: synthetic',
    text: 'a',
    threadId: known.remoteThreadId,
  });
  const b = r.emu.mailbox.createDraftElsewhere({
    to: ['dee.finch@mail.example.test'],
    subject: 'Re: synthetic',
    text: 'b',
    threadId: known.remoteThreadId,
  });
  await historyPass(r);
  assert.ok(r.store.drafts.has(a.draftId) && r.store.drafts.has(b.draftId));
  r.emu.mailbox.deleteDraft(a.draftId);
  r.emu.mailbox.sendDraft(b.draftId); // drafts.send: same message id, DRAFT -> SENT
  await historyPass(r);
  const problems: string[] = [];
  if (!r.store.drafts.get(a.draftId)?.removed) problems.push('deleted phone draft still in Drafts');
  if (!r.store.drafts.get(b.draftId)?.removed) problems.push('sent phone draft still in Drafts');
  if (!r.store.rows.has(b.messageId))
    problems.push('the reply sent from the phone never appears in the thread');
  assert.deepEqual(problems, []);
});

// ---- ADV-10: an unknown thread fetched without INBOX gain (D3) ----

test("ADV-10 D3 with Google's documented history shape, mail filtered out of the Inbox costs no fetch", async () => {
  const holder: { emu?: GmailEmulator } = {};
  const r = await rig({ threads: 600, adapter: { fetch: strippedHistoryFetch(holder) } });
  holder.emu = r.emu;
  await synced(r);
  const receipts = r.emu.mailbox.labelIdByName('Receipts')!;
  for (let i = 0; i < 160; i++) {
    r.emu.mailbox.addMessage({
      from: `Shop ${i} <orders@shop${i}.example.test>`,
      subject: `Synthetic receipt ${i}`,
      text: 'x',
      labelIds: [receipts],
    });
  }
  const start = r.clock.now();
  await historyPass(r);
  const resets = r.store.commits
    .filter(c => c.at >= start && c.result.reset)
    .map(c => c.result.reset);
  assert.deepEqual(resets, [], 'the history pass reset the account');
  assert.equal(gets(r, start).length, 0, 'unknown non-Inbox threads were fetched');
});

test('ADV-10 D3 moving 20 long unknown threads to the Inbox costs one fetch per thread, not a reset', async () => {
  const r = await rig({ threads: 600 });
  const receipts = r.emu.mailbox.labelIdByName('Receipts')!;
  const threads: string[] = [];
  const base = r.clock.now() - 400 * 86_400_000;
  for (let t = 0; t < 20; t++) {
    let prev: string | undefined;
    for (let i = 0; i < 8; i++) {
      const m = r.emu.mailbox.addMessage({
        from: 'Eve Lark <eve.lark@mail.example.test>',
        subject: `Synthetic long ${t}`,
        text: 'x',
        labelIds: [receipts],
        replyTo: prev,
        internalDate: base + t * HOUR + i * 60_000,
      });
      prev = m.id;
    }
    threads.push(r.emu.mailbox.getMessage(prev!)!.threadId);
  }
  await synced(r);
  r.emu.mailbox.relabel({ threadIds: threads }, ['INBOX'], []);
  const start = r.clock.now();
  await historyPass(r);
  const reset = r.store.commits.filter(c => c.at >= start).find(c => c.result.reset)?.result.reset;
  assert.equal(reset, undefined, `20 threads moved to the Inbox gave reset ${reset}`);
  assert.ok(gets(r, start).length <= 20, `${gets(r, start).length} fetches for 20 threads`);
});

// ---- ADV-11: full bodies during sync, fields masks, snippet entities ----

test('ADV-11 no format=full or raw request during sync (window, Sent, backfill, history) and every read names fields', async () => {
  const r = await rig({ threads: 800 });
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.drive({ maxSteps: 200 });
  const known = [...r.store.rows.values()][0].facts;
  r.emu.mailbox.addMessage({
    from: 'Fay Moss <fay.moss@mail.example.test>',
    text: 'r',
    labelIds: ['INBOX'],
    replyTo: known.remoteId,
  });
  r.emu.mailbox.createDraftElsewhere({
    to: ['fay.moss@mail.example.test'],
    subject: 'Re: x',
    text: 'd',
    threadId: known.remoteThreadId,
  });
  await r.clock.advance(60_000);
  await historyPass(r);
  // The one exception: the bounded body read of a foreign draft (draft-body.ts), one `drafts.get` per draft.
  const full = r.emu.log.filter(e => e.service === 'gmail' && e.units >= 60);
  assert.deepEqual(
    full.map(e => e.apiMethod),
    ['gmail.users.drafts.get'],
    'full-priced calls during sync',
  );
  // Exactly the allowed read: one format=full `drafts.get`, for the one foreign draft.
  const bodyReads = r.fetches.filter(f => /\/drafts\/[^/]+$/.test(f.path));
  assert.equal(bodyReads.length, 1);
  assert.equal(bodyReads[0].query.get('format'), 'full');
  for (const f of r.fetches.filter(f => f.path.startsWith('/gmail/'))) {
    assert.ok(
      !['full', 'raw'].includes(f.query.get('format') ?? '') || f === bodyReads[0],
      `${f.path} format ${f.query.get('format')}`,
    );
    assert.ok(f.query.has('fields'), `${f.path} has no fields mask`);
  }
  for (const f of r.fetches.filter(f => f.path.startsWith('/batch/'))) {
    for (const [, target] of f.body!.matchAll(/^GET (\S+) HTTP/gm)) {
      assert.match(target, /[?&]fields=/, `batch part ${target.split('?')[0]} has no fields mask`);
      assert.doesNotMatch(target, /format=(full|raw)/);
    }
  }
});

test('ADV-11 D22 snippet entities are decoded exactly once; RFC 2047 names keep their commas', async () => {
  const r = await rig();
  const m = r.emu.mailbox.addMessage({
    from: '=?UTF-8?Q?Doe=2C_Jane?= <jane.doe@mail.example.test>',
    subject: 'Synthetic quotes',
    text: `Tom's "R&D" <draft> costs 5 > 3 and literally &amp; stays`,
    labelIds: ['INBOX'],
  });
  await r.drive({ until: windowDone(r), maxSteps: 20 });
  const facts = r.store.rows.get(m.id)!.facts;
  assert.equal(facts.snippet, `Tom's "R&D" <draft> costs 5 > 3 and literally &amp; stays`);
  assert.deepEqual(facts.from, { address: 'jane.doe@mail.example.test', name: 'Doe, Jane' });
});

// ---- ADV-12: content in log lines ----

test('ADV-12 no subject, address, snippet, Message-ID or search text in any log line, refusals included', async () => {
  const faults = createFaultInjector();
  const r = await rig({ threads: 200, emulator: { faults } });
  await synced(r);
  const canaries = new Set<string>(['zanzibarcanary']);
  for (const m of r.emu.mailbox.listMessages()) {
    if (m.subject.length > 6) canaries.add(m.subject);
    canaries.add(m.messageId);
    if (m.snippet.length > 12) canaries.add(m.snippet.slice(0, 24));
    for (const a of m.from.match(/[\w.+-]+@[\w.-]+/g) ?? []) canaries.add(a);
  }
  canaries.add(r.account.address);
  canaries.add(r.tokens.access);
  canaries.add(r.tokens.refreshToken);
  faults.failNext(
    { apiMethod: 'gmail.users.messages.list' },
    { status: 400, reason: 'invalidArgument', message: 'Invalid query' },
  );
  await r.adapter
    .search({ text: 'zanzibarcanary from:someone@example.test', limit: 25 }, r.ctx())
    .catch(() => {});
  faults.failNext({ apiMethod: 'gmail.users.threads.get' }, { status: 404, reason: 'notFound' });
  await r.adapter
    .openThread(
      { remoteThreadId: [...r.store.rows.values()][0].facts.remoteThreadId },
      'interactive',
      r.ctx(),
    )
    .catch(() => {});
  const text = JSON.stringify(r.log.lines);
  const leaked = [...canaries].filter(c => c && text.includes(c));
  assert.deepEqual(leaked, []);
});

// ---- ADV-13: stale re-runs and the per-run memo ----

test('ADV-13 a stale re-run after a complete first sync including backfill costs under 100 units', async t => {
  const r = await rig({ threads: 800 });
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.drive({ maxSteps: 300 });
  await r.clock.advance(10 * 60_000);
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
  t.diagnostic(`stale re-run: ${units} units, steps ${steps.map(s => s.scope).join(', ')}`);
  assert.ok(units < 100, `${units} units`);
});

test('ADV-13 a restart in the middle of the window round fetches no message twice', async t => {
  const r = await rig({ threads: 800 });
  await r.drive({ maxSteps: 5 }); // P0 plus a few window chunks
  // Restart: a new adapter (empty memory of handled threads) over the same committed state.
  const fresh = new GmailAdapter(r.account, { fetch: r.emu.fetch });
  for (let i = 0; i < 300 && !windowDone(r)(); i++) {
    const step = fresh
      .plan({
        account: r.account,
        states: [...r.store.states.values()],
        trigger: 'poll',
        env: r.env(),
        memory: r.store.memory,
      })
      .find(s => (s.notBefore ?? 0) <= r.clock.now() && s.scope === 'window:inbox');
    if (!step) break;
    r.store.commit(
      step,
      await fresh.syncStep(step, r.store.state(step.scope), r.ctx()),
      r.clock.now(),
    );
  }
  // Per message: after the restart nothing already stored is fetched again (reformulated per message by the lane: a
  // thread spanning two pages gets its older Inbox message on the later page, which is new and needed for D8).
  const perMessage = new Map<string, number>();
  for (const c of r.store.commits.filter(c => c.step.scope === 'window:inbox')) {
    for (const u of c.result.upserts ?? [])
      perMessage.set(u.remoteId, (perMessage.get(u.remoteId) ?? 0) + 1);
  }
  const twice = [...perMessage].filter(([, n]) => n > 1).length;
  const gets = r.metadataGets();
  t.diagnostic(
    `${twice} messages fetched twice after the restart; ${gets.length - new Set(gets).size} entries fetched twice`,
  );
  assert.equal(twice, 0);
  assert.equal(new Set(gets).size, gets.length);
});

test('ADV-13 the per-run memo also covers history: a transient failure after one batch does not re-spend it', async () => {
  const faults = createFaultInjector();
  const r = await synced(await rig({ threads: 600, emulator: { faults } }));
  for (let i = 0; i < 25; i++)
    r.emu.mailbox.addMessage({
      from: 'Gil Rook <gil.rook@mail.example.test>',
      subject: `Synthetic new ${i}`,
      text: 'x',
      labelIds: ['INBOX'],
    });
  const start = r.clock.now();
  faults.failNext({ apiMethod: 'gmail.batch', after: 1 }, { status: 503, reason: 'backendError' });
  const step = planNow(r).find(s => s.scope === 'history')!;
  await assert.rejects(r.adapter.syncStep(step, r.store.state('history'), r.ctx()));
  await historyPass(r);
  // Answered (charged) metadata gets: 25 new messages should cost 25, whatever failed in between.
  const answered = gets(r, start).filter(e => e.status === 200);
  assert.equal(
    answered.length,
    25,
    `${answered.length} answered gets for 25 new messages (${(answered.length - 25) * 20} units re-spent)`,
  );
});
