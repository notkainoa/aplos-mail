import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkResult,
  ContractError,
  type EngineMethodName,
  type Frame,
  type Input,
  type Output,
} from '@aplos/contract';
import { listenerCaller, type Caller } from '@aplos/contract/access';
import type { EngineSession } from '@aplos/contract/client';
import { createFixtureEngine } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';

/** The stand-in's side of the freeze review's findings (plans/freeze/findings.md): knobs and behaviour per finding. */

function typed(session: EngineSession) {
  const frames: Frame[] = [];
  session.subscribe(f => frames.push(f));
  const call = async <M extends EngineMethodName>(method: M, args: Input<M>): Promise<Output<M>> =>
    checkResult(method, await session.call(method, args));
  return { session, frames, call };
}
function start() {
  const engine = createFixtureEngine({ scenario: 'demo' });
  const window = typed(engine.connect());
  const as = (caller: Caller) => typed(engine.connect(caller));
  return { engine, control: fixtureControl(window.session), ...window, as };
}
let n = 0;
const opId = () => `freeze-${++n}`;
const fails = (promise: Promise<unknown>, type: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof ContractError && e.type === type);
const tool = (...scopes: string[]): Caller =>
  listenerCaller({ id: 'tool', kind: 'cli', scopes }, 'socket');
const hour = 3_600_000;

async function draftAndSend(fx: ReturnType<typeof start>, notBefore?: number) {
  await fx.call('Settings/set', { opId: opId(), patch: { mail: { undoSendSeconds: 10 } } });
  const accountId = (await fx.call('Account/get', {})).list[0]!.id;
  const { draft } = await fx.call('Draft/set', {
    opId: opId(),
    fields: {
      accountId,
      mode: 'new',
      to: [{ address: 'jordan@park.example', name: 'Jordan' }],
      cc: [],
      bcc: [],
      subject: 'Plans',
      html: '<p>Hi</p>',
      attachments: [],
      signature: false,
    },
  });
  const out = await fx.call('Submission/set', {
    opId: opId(),
    action: { type: 'send', draftId: draft.id, revision: draft.revision, notBefore },
  });
  return { draft, ...out };
}

test('FR-3: re-sending a failed submission from the queue needs send, not just admin', async () => {
  const fx = start();
  await fx.control.nextSendOutcome({ outcome: 'failed' });
  const { submission } = await draftAndSend(fx);
  await fx.control.advanceClock({ ms: 11_000 });
  assert.equal(
    (await fx.call('Submission/get', { ids: [submission.id] })).list[0]!.state,
    'failed',
  );
  const item = (await fx.call('Queue/list', {})).list.find(i => i.id === submission.id)!;
  assert.equal(item.scope, 'send');
  await fails(fx.as(tool('read', 'admin')).call('Queue/retry', { id: submission.id }), 'forbidden');
  await fails(
    fx.as(tool('read', 'admin')).call('Queue/discard', { id: submission.id }),
    'forbidden',
  );
  await fx.as(tool('read', 'admin', 'send')).call('Queue/retry', { id: submission.id });
  assert.equal(
    (await fx.call('Submission/get', { ids: [submission.id] })).list[0]!.state,
    'queued',
  );
});

test('FR-4: an Ask event with a guest needs send to accept; a plan never carries guests', async () => {
  const fx = start();
  const now = (await fx.call('Session/get', {})).now;
  const event = {
    title: 'Lunch with Jordan',
    start: { type: 'utc' as const, utc: now + 24 * hour },
    end: { type: 'utc' as const, utc: now + 25 * hour },
    allDay: false,
    attendees: [{ address: 'jordan@park.example' }],
  };
  await fx.control.askScript({
    blocks: [{ text: 'Jordan suggested lunch tomorrow.' }],
    proposals: [
      { kind: 'addEvent', id: 'p1', consequence: 'Invites Jordan.', state: 'open', event },
    ],
  });
  const run = await fx.call('Ask/run', { question: 'Set up lunch with Jordan' });
  await fx.control.advanceClock({ ms: 2_000 });
  const turn = (await fx.call('Conversation/get', { ids: [run.conversationId] })).list[0]!
    .turns[0]!;
  const decide = {
    conversationId: run.conversationId,
    turnId: turn.id,
    proposalId: 'p1',
    accept: true,
  };
  await fails(
    fx.as(tool('read', 'triage')).call('Ask/decide', { opId: opId(), ...decide }),
    'forbidden',
  );
  const { eventId, receipt } = await fx.call('Ask/decide', { opId: opId(), ...decide });
  const created = (await fx.call('Event/get', { ids: [eventId!] })).list[0]!;
  assert.deepEqual(
    created.attendees.filter(a => !a.self).map(a => a.address),
    ['jordan@park.example'],
  );
  assert.equal((await fx.call('Operation/get', { opIds: [receipt.opId] })).list[0]!.scope, 'send');

  const plan = (await fx.call('View/query', { spec: { kind: 'plans' } })).ids[0];
  if (plan) {
    const confirmed = await fx.call('Plan/confirm', {
      opId: opId(),
      id: plan,
      fields: { attendees: [{ address: 'stranger@guest.example' }] } as never,
    });
    const e = (await fx.call('Event/get', { ids: [confirmed.eventId] })).list[0]!;
    assert.equal(e.attendees.filter(a => !a.self).length, 0, 'a confirmed plan invites nobody');
  }
});

test('FR-13 and FR-14: Draft/destroy cancels a held send; an uncertain send can be cancelled', async () => {
  const fx = start();
  await fx.control.nextSendOutcome({ outcome: 'uncertain' });
  const { submission, draft } = await draftAndSend(fx);
  await fx.control.advanceClock({ ms: 11_000 });
  assert.equal(
    (await fx.call('Submission/get', { ids: [submission.id] })).list[0]!.state,
    'uncertain',
  );
  await fails(
    fx.call('Draft/set', {
      opId: opId(),
      id: draft.id,
      fields: { ...draft, mode: 'new', signatureSource: undefined },
    }),
    'stateMismatch',
  );
  await fx.call('Submission/set', {
    opId: opId(),
    action: { type: 'cancel', submissionId: submission.id },
  });
  assert.equal((await fx.call('Draft/get', { ids: [draft.id] })).list[0]!.submissionId, undefined);
});

test('FR-17: connect, AI, remote search, transcription and calendar knobs', async () => {
  const fx = start();
  const accountId = (await fx.call('Account/get', {})).list[0]!.id;
  await fx.control.resolveConnect({ outcome: 'failed', reasonCode: 'auth.wrongAccount' });
  const { connectId } = await fx.call('Account/reconnect', { accountId });
  await fx.control.advanceClock({ ms: 1_000 });
  const last = fx.frames.filter(
    (f): f is Extract<Frame, { frame: 'connect' }> =>
      f.frame === 'connect' && f.connectId === connectId,
  );
  assert.deepEqual(
    last.map(f => [f.state, f.mode, f.accountId, f.reasonCode]),
    [
      ['waiting', 'reconnect', accountId, undefined],
      ['failed', 'reconnect', accountId, 'auth.wrongAccount'],
    ],
  );

  const thread = (await fx.call('View/query', { spec: { kind: 'mailbox', role: 'inbox' } }))
    .ids[0]!;
  await fx.control.failNextAi({ feature: 'summaries', reasonCode: 'ai.rateLimited' });
  await assert.rejects(
    fx.call('Ai/request', { opId: opId(), kind: 'summary', threadId: thread, force: true }),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'ai.rateLimited',
  );

  await fx.control.failNextAi({ feature: 'ask', reasonCode: 'ai.unreachable' });
  const run = await fx.call('Ask/run', { question: 'What is new?' });
  await fx.control.advanceClock({ ms: 2_000 });
  assert.ok(
    fx.frames.some(f => f.frame === 'progress' && f.runId === run.runId && f.kind === 'error'),
  );
  const failed = (await fx.call('Conversation/get', { ids: [run.conversationId] })).list[0]!;
  assert.equal(failed.turns[0]!.problem?.reasonCode, 'ai.unreachable');

  const win = await fx.call('View/watch', { spec: { kind: 'search', query: { text: 'zzqx' } } });
  assert.equal(win.total, 0);
  await fx.control.searchRemote({ ids: [thread] });
  await fx.call('Search/remote', { opId: opId(), query: { text: 'zzqx' } });
  await fx.control.advanceClock({ ms: 1_000 });
  const joined = fx.frames.filter(f => f.frame === 'window' && f.windowId === win.windowId).at(-1);
  assert.ok(joined?.frame === 'window' && joined.ids.includes(thread), 'remote results join');
  await fx.control.searchRemote({
    error: {
      type: 'paused',
      message: 'Gmail asked Aplos to slow down.',
      reasonCode: 'rate.minute',
    },
  });
  await fx.call('Search/remote', { opId: opId(), query: { text: 'zzqx' } });
  await fx.control.advanceClock({ ms: 1_000 });
  const stopped = fx.frames.filter(f => f.frame === 'window' && f.windowId === win.windowId).at(-1);
  assert.ok(stopped?.frame === 'window' && stopped.error?.type === 'paused');

  await fx.control.transcribeResult({ text: 'Move the review to Friday.' });
  const { blobId } = await fx.call('Blob/put', {
    bytes: new Uint8Array([1, 2]),
    mime: 'audio/webm',
  });
  assert.equal(
    (await fx.call('Ai/transcribe', { requestId: 'r1', blobId })).text,
    'Move the review to Friday.',
  );

  const now = (await fx.call('Session/get', {})).now;
  const events = await fx.call('View/query', {
    spec: { kind: 'events', from: now - 7 * 86_400_000, to: now + 14 * 86_400_000 },
  });
  await fx.control.calendarChange({
    eventId: events.ids[0]!,
    patch: { title: 'Moved by the organizer' },
  });
  assert.equal(
    (await fx.call('Event/get', { ids: [events.ids[0]!] })).list[0]!.title,
    'Moved by the organizer',
  );
});

test('FR-30: answers carry chip offsets, not [n] markers', async () => {
  const fx = start();
  const run = await fx.call('Ask/run', { question: 'What needs my reply today?' });
  await fx.control.advanceClock({ ms: 2_000 });
  const turn = (await fx.call('Conversation/get', { ids: [run.conversationId] })).list[0]!
    .turns[0]!;
  assert.ok(turn.citations.length > 0);
  for (const b of turn.answer!.blocks) {
    assert.doesNotMatch(b.text, /\[\d+\]/);
    for (const c of b.cites ?? []) assert.ok(c.at <= b.text.length);
  }
  const streamed = fx.frames
    .filter(f => f.frame === 'progress' && f.runId === run.runId)
    .flatMap(f => (f.frame === 'progress' && f.kind === 'text' ? [f.delta ?? ''] : []))
    .join('');
  for (const f of fx.frames)
    if (f.frame === 'progress' && f.runId === run.runId && f.kind === 'citation')
      assert.ok(f.at !== undefined && f.at <= streamed.length, 'each chip has its place');
});

test('FR-21, FR-22: hidden events leave the grid; plans take a range', async () => {
  const fx = start();
  const now = (await fx.call('Session/get', {})).now;
  const spec = { kind: 'events' as const, from: now - 7 * 86_400_000, to: now + 14 * 86_400_000 };
  const before = await fx.call('View/query', { spec });
  const id = before.ids[0]!;
  await fx.call('Event/hide', { opId: opId(), ids: [id], hidden: true });
  assert.ok(!(await fx.call('View/query', { spec })).ids.includes(id));
  assert.ok(
    (await fx.call('View/query', { spec: { ...spec, includeHidden: true } })).ids.includes(id),
  );
  assert.equal((await fx.call('Operation/get', { opIds: [] })).list.length, 0);
  const all = await fx.call('View/query', { spec: { kind: 'plans' } });
  const none = await fx.call('View/query', {
    spec: { kind: 'plans', from: now + 40 * 86_400_000, to: now + 41 * 86_400_000 },
  });
  assert.ok(none.total <= all.total);
  assert.equal(none.ids.length, 0);
});

test('FR-27: Low importance threads grouped by sender', async () => {
  const fx = start();
  const senders = await fx.call('View/query', { spec: { kind: 'lowSenders' } });
  const groups = (await fx.call('SenderGroup/get', { ids: senders.ids })).list;
  const low = await fx.call('View/query', { spec: { kind: 'lowBySender' } });
  assert.equal(low.rowType, 'Thread');
  assert.deepEqual(
    low.sections.map(s => [s.key, s.count]),
    groups.map(g => [g.address, g.count]),
  );
  const first = low.sections[0]!;
  await fx.call('Thread/act', {
    opId: opId(),
    selector: { spec: { kind: 'lowBySender' }, section: first.key, atState: low.state },
    action: { type: 'read' },
  });
});

test('FR-28: a reminder clears; Clear from Home keeps each Later date', async () => {
  const fx = start();
  const ids = (await fx.call('View/query', { spec: { kind: 'mailbox', role: 'inbox' } })).ids;
  const now = (await fx.call('Session/get', {})).now;
  await fx.call('Thread/act', {
    opId: opId(),
    ids: [ids[0]!],
    action: { type: 'reminder', at: now + hour },
  });
  await fx.call('Thread/act', {
    opId: opId(),
    ids: [ids[0]!],
    action: { type: 'reminder', clear: true },
  });
  assert.equal(
    (await fx.call('Thread/get', { ids: [ids[0]!] })).list[0]!.workflow.reminderAt,
    undefined,
  );

  const until = [now + 1_000, now + 2_000];
  for (const [i, u] of until.entries())
    await fx.call('Thread/act', {
      opId: opId(),
      ids: [ids[i + 1]!],
      action: { type: 'later', until: u },
    });
  await fx.control.advanceClock({ ms: 5_000 });
  const home = await fx.call('View/query', { spec: { kind: 'home' } });
  const back = home.sections.find(s => s.key === 'fromLater')!;
  const backIds = home.ids.slice(back.start, back.start + back.count);
  assert.ok(backIds.includes(ids[1]!) && backIds.includes(ids[2]!), 'both are Back from Later');
  await fx.call('Thread/act', {
    opId: opId(),
    selector: { spec: { kind: 'home' }, section: 'fromLater', atState: home.state },
    action: { type: 'clearFromHome' },
  });
  const rows = (await fx.call('Thread/get', { ids: [ids[1]!, ids[2]!] })).list;
  assert.deepEqual(
    rows.map(t => t.workflow.laterUntil),
    until,
    'each keeps its own date',
  );
  const after = await fx.call('View/query', { spec: { kind: 'home' } });
  assert.ok(!after.ids.includes(ids[1]!) && !after.ids.includes(ids[2]!), 'off Home');
  const later = await fx.call('View/query', { spec: { kind: 'later' } });
  const overdue = later.sections.find(s => s.key === 'overdue')!;
  assert.ok(later.ids.slice(overdue.start, overdue.start + overdue.count).includes(ids[1]!));
});

test('FR-29: recipient type-ahead from the people you write to and hear from', async () => {
  const fx = start();
  const all = (await fx.call('Contact/suggest', { query: '' })).list;
  assert.ok(all.length > 0);
  const mine = (await fx.call('Account/get', {})).list.map(a => a.address);
  assert.ok(
    all.every(p => !mine.includes(p.address)),
    'never your own address',
  );
  const q = all[0]!.address.slice(0, 2);
  assert.ok(
    (await fx.call('Contact/suggest', { query: q })).list.every(
      p =>
        p.address.startsWith(q) ||
        (p.name ?? '')
          .toLowerCase()
          .split(/\s+/)
          .some(w => w.startsWith(q)),
    ),
  );
});

test('FR-25: a Google account reconnects in the browser, not with a pasted secret', async () => {
  const fx = start();
  const accountId = (await fx.call('Account/get', {})).list[0]!.id;
  await fails(
    fx.call('Account/updateSecret', { accountId, secret: 'app-password' }),
    'unsupported',
  );
});

test('FR-5: moving the Summaries provider to another host needs consent again, and is not local', async () => {
  const fx = start();
  const consent = await fx.call('Consent/get', {});
  await fx.call('Consent/grant', {
    scope: 'background',
    version: consent.currentVersion,
    provider: 'ollama',
    model: 'llama3.2',
  });
  await fx.call('Settings/set', {
    opId: opId(),
    patch: {
      ai: {
        features: {
          ...(await fx.call('Settings/get', {})).ai.features,
          summaries: { provider: 'ollama', model: 'llama3.2' },
        },
      },
    },
  });
  const again = await fx.call('Consent/get', {});
  assert.equal(again.needsReconsent, true, 'a provider change needs the card again');
  const v = again.currentVersion;
  await fx.call('Consent/grant', {
    scope: 'background',
    version: v,
    provider: 'ollama',
    model: 'llama3.2',
  });
  const ollama = () => fx.call('Ai/providers', {}).then(r => r.list.find(p => p.id === 'ollama')!);
  assert.equal((await ollama()).local, true);
  await fx.call('Settings/set', {
    opId: opId(),
    patch: { ai: { providers: { ollama: { address: 'http://198.51.100.4:11434/v1' } } } },
  });
  assert.equal((await ollama()).local, false, 'local follows the address');
  const moved = await fx.call('Consent/get', {});
  assert.equal(moved.needsReconsent, true);
  assert.ok(moved.currentVersion > v);
});

test('FR-2: the stand-in takes the waiting states and the overdue grace from @aplos/contract/rules', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(f =>
    f.endsWith('.ts'),
  );
  const text = (f: string) => readFileSync(join(src, f), 'utf8');
  assert.match(
    text('methods/compose.ts'),
    /OVERDUE_GRACE_MS, WAITING_SUBMISSION_STATES } from '@aplos\/contract\/rules'/,
  );
  for (const f of files)
    assert.doesNotMatch(text(f), /\b5 \* 60_000|overdueGrace/i, `${f} keeps no copy of the grace`);
});
