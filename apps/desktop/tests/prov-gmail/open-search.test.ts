/**
 * prov-gmail lazy bodies (AM-1, D15) and server search on Enter only (D2), on the Gmail emulator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PausedError } from '@aplos/engine/ports';
import { gmailLog, rig, type Rig } from './harness';

const SELF_FROM = 'Willa Pennick <willa.pennick@mail.example.test>';

function seedThread(
  r: Rig,
  count: number,
  opts: { htmlAsAttachment?: boolean; draft?: boolean } = {},
) {
  const ids: string[] = [];
  let threadId: string | undefined;
  for (let i = 0; i < count; i++) {
    const m = r.emu.mailbox.addMessage({
      from: SELF_FROM,
      to: [r.account.address],
      subject: i === 0 ? 'Synthetic plans' : 'Re: Synthetic plans',
      text: `Plain part ${i}.`,
      html: `<p>Html part ${i} <img src="cid:logo${i}@example.test"></p>`,
      htmlAsAttachment: opts.htmlAsAttachment,
      attachments:
        i === 0
          ? [
              {
                filename: 'logo.png',
                mimeType: 'image/png',
                data: Buffer.from('png'),
                contentId: `logo${i}@example.test`,
              },
            ]
          : undefined,
      labelIds: ['INBOX'],
      threadId,
      internalDate: r.clock.now() - (count - i) * 60_000,
    });
    threadId ??= m.threadId;
    ids.push(m.id);
  }
  if (opts.draft)
    r.emu.mailbox.createDraftElsewhere({
      to: ['willa.pennick@mail.example.test'],
      subject: 'Re: Synthetic plans',
      text: 'draft',
      threadId,
    });
  return { threadId: threadId!, ids };
}

test('prov-gmail-T35 D1 AM-1: threads.get full unless exactly one message is known, then messages.get full', async () => {
  const r = await rig();
  const multi = seedThread(r, 3);
  const single = seedThread(r, 1);
  // The engine knows the single thread's one message from the window.
  r.store.commit(
    { scope: 'window:inbox', lane: 'incremental', origin: 'baseline', trigger: 'first' },
    {
      upserts: [
        {
          remoteId: single.ids[0],
          remoteThreadId: single.threadId,
          to: [],
          cc: [],
          date: 0,
          internalDate: 0,
          flags: { seen: true, flagged: false, draft: false, fromMe: false },
          placements: [{ folder: 'INBOX' }],
          list: {},
          partial: true,
        },
      ],
      nextStates: [],
      done: true,
      costUnits: 0,
    },
    r.clock.now(),
  );

  const cases: [string, number | undefined, string, number][] = [
    [multi.threadId, undefined, 'gmail.users.threads.get', 120],
    [single.threadId, 1, 'gmail.users.messages.get', 60],
    [multi.threadId, 3, 'gmail.users.threads.get', 120],
  ];
  for (const [remoteThreadId, knownCount, method, units] of cases) {
    const since = r.emu.log.length;
    const opened = await r.adapter.openThread(
      { remoteThreadId, ...(knownCount !== undefined ? { knownCount } : {}) },
      'interactive',
      r.ctx(),
    );
    const calls = r.emu.log.slice(since);
    assert.deepEqual(
      calls.map(e => [e.apiMethod, e.units]),
      [[method, units]],
    );
    assert.equal(opened.costUnits, units);
    assert.ok(
      opened.messages.every(m => m.partial === false && m.body.text?.startsWith('Plain part')),
    );
  }
  const lanes = r.governor.sentCalls().map(c => c.lane);
  assert.ok(lanes.every(l => l === 'interactive'));
});

test('a reply that arrived after the count was stored is fetched too: a stale count of 1 opens the whole thread', async () => {
  // The 2026-11-17 retest: an earlier open stored the thread's count as 1; the owner's reply then arrived by a bare
  // history fetch, which never moves the count. Every open took the one-message path, fetched the original only, and
  // the reply showed "Couldn't load this email." with a Try again that could never succeed.
  const r = await rig();
  const thread = seedThread(r, 2);
  const known = (remoteId: string, minutes: number) => ({
    remoteId,
    remoteThreadId: thread.threadId,
    to: [],
    cc: [],
    date: minutes,
    internalDate: minutes,
    flags: { seen: true, flagged: false, draft: false, fromMe: false },
    placements: [{ folder: 'INBOX' }],
    list: {},
    partial: true,
  });
  r.store.commit(
    { scope: 'window:inbox', lane: 'incremental', origin: 'baseline', trigger: 'first' },
    {
      upserts: [known(thread.ids[0], 1), known(thread.ids[1], 2)],
      nextStates: [],
      done: true,
      costUnits: 0,
    },
    r.clock.now(),
  );
  const since = r.emu.log.length;
  const opened = await r.adapter.openThread(
    { remoteThreadId: thread.threadId, knownCount: 1 },
    'interactive',
    r.ctx(),
  );
  assert.deepEqual(
    r.emu.log.slice(since).map(e => e.apiMethod),
    ['gmail.users.threads.get'],
  );
  const reply = opened.messages.find(m => m.remoteId === thread.ids[1]);
  assert.equal(reply?.body.text, 'Plain part 1.');
  // The open also stores the true size, so the next open is right without this guard.
  assert.equal(reply?.threadSize, 2);
  assert.ok(!opened.removed?.length, 'nothing the device holds is removed');
});

test('prov-gmail-T34/T36 D15 an open resolves body parts held by attachment id in one batch, and lists attachments', async () => {
  const r = await rig();
  const thread = seedThread(r, 8, { htmlAsAttachment: true, draft: true });
  const since = r.emu.log.length;
  const opened = await r.adapter.openThread(
    { remoteThreadId: thread.threadId },
    'interactive',
    r.ctx(),
  );
  const calls = r.emu.log.slice(since);
  const envelopes = calls.filter(e => e.apiMethod === 'gmail.batch');
  const parts = calls.filter(e => e.apiMethod === 'gmail.users.messages.attachments.get');
  assert.equal(envelopes.length, 1, 'one batch, never one request per part');
  assert.equal(parts.length, 8);
  assert.equal(
    calls.reduce((s, e) => s + e.units, 0),
    120 + 8 * 20,
  );
  assert.equal(opened.costUnits, 120 + 8 * 20);
  assert.equal(r.governor.maxInFlight, 1);
  assert.equal(opened.messages.length, 8, 'the phone draft is not part of the conversation (D9)');
  for (const [i, m] of opened.messages.entries()) {
    assert.equal(m.body.html, `<p>Html part ${i} <img src="cid:logo${i}@example.test"></p>`);
    assert.equal(m.body.text, `Plain part ${i}.`);
    assert.equal(m.threadSize, 8);
  }
  const first = opened.messages[0];
  assert.equal(first.attachments?.length, 1);
  assert.equal(first.attachments![0].name, 'logo.png');
  assert.equal(first.body.cidMap['logo0@example.test'], first.attachments![0].part);
  assert.equal(first.attachments![0].inline, true);
  const bytes: Uint8Array[] = [];
  for await (const chunk of await r.adapter.fetchAttachment(
    { remoteMessageId: first.remoteId, part: first.attachments![0].part },
    r.ctx(),
  ))
    bytes.push(chunk);
  assert.equal(Buffer.concat(bytes).toString(), 'png');
});

test('prov-gmail-T34 D1 the first sync makes no full fetch and no attachment fetch', async () => {
  const r = await rig({ threads: 200 });
  await r.drive({ until: () => r.store.states.get('window:inbox')?.phase === 'done' });
  // Metadata prices only: messages.get 20, and threads.get 40 for a new thread whose page lists several Inbox messages (D8).
  const metadataPrice: Record<string, number> = {
    'gmail.users.messages.get': 20,
    'gmail.users.threads.get': 40,
  };
  assert.ok(
    gmailLog(r.emu).every(
      e =>
        e.apiMethod !== 'gmail.users.messages.attachments.get' &&
        e.units <= (metadataPrice[e.apiMethod] ?? 20),
    ),
  );
});

test('prov-gmail-T37 D2 typing makes zero Google calls; Enter runs one list and batched metadata', async () => {
  const r = await rig({ threads: 200 });
  const query = 'subject:Notes';
  // The UI's flow: every keystroke asks the local index; Enter asks the server.
  const localHits: string[] = [];
  const onType = (text: string) => localHits.push(text);
  const onEnter = (text: string) => r.adapter.search!({ text, limit: 25 }, r.ctx());
  for (let i = 1; i <= query.length; i++) {
    onType(query.slice(0, i));
    await r.clock.advance(250);
  }
  await r.clock.advance(10_000);
  assert.equal(r.fetches.length, 0, 'zero calls while typing');
  const result = await onEnter(query);
  const methods = r.emu.log.map(e => e.apiMethod);
  assert.equal(methods.filter(m => m === 'gmail.users.messages.list').length, 1);
  assert.equal(
    methods.filter(m => m === 'gmail.batch').length,
    Math.ceil(result.remoteThreadIds.length / 10),
  );
  assert.ok(result.costUnits <= 5 + 25 * 20, `${result.costUnits} units`);
  assert.ok(result.remoteThreadIds.length > 0 && result.remoteThreadIds.length <= 25);
  assert.equal(new Set(result.remoteThreadIds).size, result.remoteThreadIds.length);
  assert.ok(result.upserts.every(u => u.partial && /Notes/.test(u.subject ?? '')));
  assert.ok(r.governor.sentCalls().every(c => c.lane === 'interactive'));
  // A refusal is surfaced, never swallowed into "no results".
  r.governor.apply({
    class: 'throttle',
    provider: 'gmail',
    method: 'gmail.messages.list',
    reason: 'rateLimitExceeded',
  });
  await assert.rejects(onEnter(query), PausedError);
});
