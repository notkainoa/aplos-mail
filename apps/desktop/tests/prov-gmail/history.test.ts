/**
 * prov-gmail incremental sync on the Gmail emulator: zero-fetch label deltas (D13), the INBOX-gain rule (D3), new
 * replies (D14), drafts (D9), the change cap, the per-page cursor and the bounded resync after a history 404 (D10).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaultInjector } from '@aplos/emulators';
import { gmailLog, rig, type Rig } from './harness';

const windowDone = (r: Rig) => () => r.store.states.get('window:inbox')?.phase === 'done';
const unitsSince = (r: Rig, since: number) =>
  r.emu.log.filter(e => e.at >= since).reduce((sum, e) => sum + e.units, 0);
const gets = (r: Rig, since: number) =>
  gmailLog(r.emu, since).filter(e => /(messages|threads)\.get$/.test(e.apiMethod));

/** One history pass: pages until the cursor has caught up (the actor runs them back to back). */
async function historyPass(r: Rig): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
    if (!/^pass:/.test(r.store.states.get('history')?.phase ?? '')) return;
  }
  throw new Error('history pass did not finish');
}

async function synced(threads: number): Promise<Rig> {
  const r = await rig({ threads });
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.clock.advance(60_000);
  return r;
}

test('prov-gmail-T38/T39 D3 2,000 threads archived elsewhere cost under 2,500 units (and no fetch) in the next pass', async t => {
  const r = await synced(3_000);
  const archived = r.emu.mailbox.archiveThreads(2_000);
  assert.equal(archived.length, 2_000);
  const start = r.clock.now();
  await historyPass(r);
  const units = unitsSince(r, start);
  const cost = r.store.commits
    .filter(c => c.at >= start)
    .reduce((s, c) => s + c.result.costUnits, 0);
  t.diagnostic(
    `2,000-thread archive: ${units} units (${cost} by costUnits) over ${gmailLog(r.emu, start).length} requests`,
  );
  assert.ok(units < 2_500, `${units} units`);
  assert.ok(units < 100, 'in practice only history pages');
  assert.equal(cost, units);
  assert.equal(gets(r, start).length, 0, 'no messages.get or threads.get');
  assert.equal(
    r.store.states.get('history')?.cursor,
    String(r.emu.mailbox.history.currentId),
    'cursor caught up',
  );
  const archivedSet = new Set(archived);
  const stillInbox = [...r.store.threadsIn('INBOX')].filter(id => archivedSet.has(id));
  assert.equal(stillInbox.length, 0, 'every archived thread left the Inbox locally');
});

test('prov-gmail-T42 D13 label-only changes on known messages cost zero fetches and land as deltas', async () => {
  const r = await synced(600);
  const known = [...r.store.rows.keys()].slice(0, 200);
  const projects = r.emu.mailbox.labelIdByName('Projects')!;
  r.emu.mailbox.relabel({ messageIds: known.slice(0, 100) }, ['STARRED', projects], ['UNREAD']);
  r.emu.mailbox.relabel({ messageIds: known.slice(100) }, ['UNREAD'], ['INBOX']);
  const start = r.clock.now();
  await historyPass(r);
  assert.equal(gets(r, start).length, 0);
  assert.deepEqual(
    new Set(gmailLog(r.emu, start).map(e => e.apiMethod)),
    new Set(['gmail.users.history.list']),
  );
  for (const id of known) {
    const server = r.emu.mailbox.getMessage(id)!;
    const row = r.store.rows.get(id)!;
    assert.equal(row.seen, !server.labelIds.includes('UNREAD'));
    assert.equal(row.flagged, server.labelIds.includes('STARRED'));
    const folders = server.labelIds.filter(l => !['UNREAD', 'STARRED', 'DRAFT'].includes(l)).sort();
    assert.deepEqual(
      [...row.folders.keys()].sort(),
      folders,
      'per-message labels match the server',
    );
  }
});

test('prov-gmail-T43 D14 a new reply in a known thread fetches only the added message, as metadata', async () => {
  const r = await synced(600);
  const known = [...r.store.rows.values()][0].facts;
  const reply = r.emu.mailbox.addMessage({
    from: 'Odessa Kestrel <odessa.kestrel@mail.example.test>',
    to: [r.account.address],
    subject: 'Re: synthetic',
    text: 'A synthetic reply.',
    labelIds: ['INBOX', 'UNREAD'],
    replyTo: known.remoteId,
  });
  const start = r.clock.now();
  await historyPass(r);
  const fetched = gets(r, start);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].apiMethod, 'gmail.users.messages.get');
  assert.equal(fetched[0].units, 20, 'metadata, not full');
  const row = r.store.rows.get(reply.id)!;
  assert.equal(row.facts.partial, true);
  assert.equal(row.facts.remoteThreadId, known.remoteThreadId);
  assert.equal(row.seen, false);
});

test('prov-gmail-T40 D3 an unknown thread is fetched only when it gains INBOX', async () => {
  const r = await synced(600);
  const knownThreads = new Set([...r.store.rows.values()].map(row => row.facts.remoteThreadId));
  const unknown = r.emu.mailbox.threadIds().filter(id => !knownThreads.has(id));
  const [toInbox, toLabel] = [unknown.slice(0, 5), unknown.slice(5, 40)];
  const receipts = r.emu.mailbox.labelIdByName('Receipts')!;
  r.emu.mailbox.relabel({ threadIds: toLabel }, [receipts], []);
  r.emu.mailbox.relabel({ threadIds: toInbox }, ['INBOX'], ['TRASH', 'SPAM']);
  const gained = toInbox
    .flatMap(id => r.emu.mailbox.threadMessageIds(id))
    .filter(id => !r.emu.mailbox.getMessage(id)!.labelIds.includes('DRAFT'));
  const start = r.clock.now();
  await historyPass(r);
  const fetched = gets(r, start);
  // One metadata call per thread that gained INBOX (messages.get for one message, threads.get for several), none for
  // the label-only threads; every message that gained INBOX is then a row (D8).
  assert.equal(
    fetched.length,
    toInbox.length,
    'one metadata call per thread that gained INBOX, none for the label-only threads',
  );
  assert.ok(
    fetched.every(e =>
      e.apiMethod === 'gmail.users.threads.get' ? e.units === 40 : e.units === 20,
    ),
  );
  for (const id of gained)
    assert.ok(
      r.store.rows.get(id)?.folders.has('INBOX'),
      'each message that gained INBOX is stored',
    );
  for (const id of toInbox)
    assert.ok(r.store.threadsIn('INBOX').has(id), 'the thread is now in the local Inbox');
  for (const id of toLabel)
    assert.ok(
      !knownThreads.has(id) &&
        ![...r.store.rows.values()].some(row => row.facts.remoteThreadId === id),
    );
});

test('prov-gmail-T45 D9 a draft made on a phone becomes a RemoteDraftFact, never a thread message, with no message fetch', async () => {
  const r = await synced(600);
  const known = [...r.store.rows.values()][0].facts;
  const draft = r.emu.mailbox.createDraftElsewhere({
    to: ['maren.ashgrove@mail.example.test'],
    subject: 'Re: synthetic',
    text: 'Draft text.',
    threadId: known.remoteThreadId,
  });
  const start = r.clock.now();
  await historyPass(r);
  assert.equal(gets(r, start).length, 0, 'no message fetched for the draft');
  assert.ok(!r.store.rows.has(draft.messageId), 'the draft is not a row in the thread');
  const fact = r.store.drafts.get(draft.draftId);
  assert.ok(fact, 'reported as a remote draft');
  assert.equal(fact.remoteMessageId, draft.messageId);
  assert.equal(fact.remoteThreadId, known.remoteThreadId);
});

test('prov-gmail-T45 D9 a draft copy this device wrote (KnownLookup.draftsByMessageId) is not reported back; an edit elsewhere is', async () => {
  const r = await synced(600);
  const known = [...r.store.rows.values()][0].facts;
  const spec = {
    to: ['maren.ashgrove@mail.example.test'],
    subject: 'Re: synthetic',
    text: 'Draft text.',
    threadId: known.remoteThreadId,
  };
  const mine = r.emu.mailbox.createDraftElsewhere(spec);
  r.store.ownDrafts.set(mine.messageId, mine.draftId);
  const theirs = r.emu.mailbox.createDraftElsewhere({ ...spec, subject: 'Re: from the phone' });
  await historyPass(r);
  assert.ok(!r.store.drafts.has(mine.draftId), "Aplos's own save is not news");
  assert.equal(r.store.drafts.get(theirs.draftId)?.remoteMessageId, theirs.messageId);
  assert.ok(![...r.store.rows.keys()].includes(mine.messageId), 'and never a thread row');
});

test('prov-gmail-T41 D3 the cursor advances per history page; a failed page replays only itself', async () => {
  const faults = createFaultInjector();
  const r = await rig({ threads: 600, emulator: { faults } });
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.clock.advance(60_000);
  // About 1,300 label records: three history pages of 500.
  const ids = [...r.store.rows.keys()];
  r.emu.mailbox.relabel({ messageIds: ids }, ['STARRED'], []);
  r.emu.mailbox.relabel({ messageIds: ids }, [], ['STARRED']);
  r.emu.mailbox.relabel({ messageIds: ids.slice(0, 400) }, ['STARRED'], []);
  const original = r.store.states.get('history')!.cursor!;
  faults.failNext(
    { apiMethod: 'gmail.users.history.list', after: 1 },
    { status: 503, reason: 'backendError' },
  );
  await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
  const afterPage1 = r.store.states.get('history')!;
  assert.notEqual(afterPage1.cursor, original, 'page 1 moved the cursor');
  assert.match(afterPage1.phase ?? '', /^pass:/);
  await assert.rejects(r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 }));
  assert.equal(
    r.store.states.get('history')!.cursor,
    afterPage1.cursor,
    'a failed page never moves the cursor',
  );
  await historyPass(r);
  assert.equal(r.store.states.get('history')!.cursor, String(r.emu.mailbox.history.currentId));
  const starredLocal = [...r.store.rows.values()].filter(row => row.flagged).length;
  assert.equal(
    starredLocal,
    [...r.store.rows.keys()].filter(id =>
      r.emu.mailbox.getMessage(id)!.labelIds.includes('STARRED'),
    ).length,
  );
});

test('prov-gmail-T40 D3 more than 150 fetches in one pass takes the bounded fresh-window path', async () => {
  const r = await synced(800);
  const knownThreads = new Set([...r.store.rows.values()].map(row => row.facts.remoteThreadId));
  const outside = r.emu.mailbox
    .threadIds()
    .filter(
      id =>
        !knownThreads.has(id) &&
        !r.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).some(t => t.id === id),
    );
  r.emu.mailbox.relabel({ threadIds: outside.slice(0, 160) }, ['INBOX'], []);
  const start = r.clock.now();
  await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
  const reset = r.store.commits.at(-1)!.result;
  assert.equal(reset.reset, 'changeCapExceeded');
  assert.equal(gets(r, start).length, 0, 'the capped page fetches nothing');
  await r.drive({ trigger: 'reset', until: windowDone(r), maxSteps: 20 });
  const units = unitsSince(r, start);
  const fetched = gets(r, start).length;
  assert.ok(
    fetched <= 51,
    `${fetched} fetches: at most the 50 newest Inbox threads plus one date probe`,
  );
  assert.ok(units < 2_500, `${units} units`);
  assert.ok(r.store.states.get('history')?.cursor, 'a fresh cursor was taken first');
});

test('prov-gmail-T46 D10 a history 404 gives a bounded Inbox resync that removes ghosts without a full re-download', async t => {
  const r = await synced(600);
  // While this device was away: three newest Inbox threads deleted for good, one new mail arrives, history expires.
  const newest = r.emu.mailbox
    .selectThreads({ labelIds: ['INBOX'] })
    .slice(0, 3)
    .map(th => th.id);
  const ghosts = newest.flatMap(id => r.emu.mailbox.threadMessageIds(id));
  for (const id of ghosts) r.emu.mailbox.deleteMessage(id);
  const fresh = r.emu.mailbox.addMessage({
    from: 'Hello <hello@quillonlabs.example.test>',
    to: [r.account.address],
    subject: 'Synthetic news',
    text: 'x',
    labelIds: ['INBOX'],
  });
  r.emu.mailbox.expireHistory();
  const start = r.clock.now();
  await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
  assert.equal(r.store.commits.at(-1)!.result.reset, 'cursorExpired');
  await r.drive({ trigger: 'reset', until: windowDone(r), maxSteps: 20 });
  const units = unitsSince(r, start);
  const fetched = gets(r, start);
  t.diagnostic(`resync: ${units} units, ${fetched.length} gets`);
  for (const id of ghosts)
    assert.ok(!r.store.rows.get(id)?.folders.has('INBOX'), 'ghost swept from the Inbox');
  assert.ok(
    r.store.rows.get(fresh.id)?.folders.has('INBOX'),
    'the mail that arrived in the gap is there',
  );
  assert.ok(fetched.length <= 2, 'only the new mail and one date probe: no re-download');
  assert.ok(units < 100, `${units} units`);
  // Inside the swept range the local Inbox equals the server's.
  const since = r.store.commits.at(-1)!.result.scopeCovered!.bound.since!;
  const serverInbox = new Set(
    r.emu.mailbox
      .select({ labelIds: ['INBOX'] })
      .filter(m => m.date > since)
      .map(m => m.id),
  );
  const localInbox = new Set(
    [...r.store.rows.values()]
      .filter(row => row.folders.has('INBOX') && row.facts.internalDate > since)
      .map(row => row.facts.remoteId),
  );
  for (const id of localInbox) assert.ok(serverInbox.has(id), 'no ghost left in the covered range');
});
