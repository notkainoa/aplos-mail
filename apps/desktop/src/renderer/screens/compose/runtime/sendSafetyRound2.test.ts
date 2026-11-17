/**
 * Send-safety review, round 2, against the stand-in engine (nothing leaves the stand-in): a refused Undo always says
 * why; four sends in one undo window each keep their Undo and their failure; another window's send never turns this
 * window's text into a silent second send; a lost create reply never makes a second draft; a send that never answers
 * lets go of the page and Z after `SEND_CONFIRM_MS`; Try again keeps the undo window; a kept composer that is still
 * sending is not let go. Run: `cd apps/desktop && npx tsx --test
 * src/renderer/screens/compose/runtime/sendSafetyRound2.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Submission } from '../../../data';
import { addToast, getToasts, resetToasts } from '../../../shell/store-toast';
import { pageDone, pendingUndoTable } from '../ComposeScreen';
import { AUTOSAVE, FRESH_SAVE } from '../model/autosave';
import { composeReducer } from '../model/composeReducer';
import { freshCompose, type ComposeState } from '../model/composeState';
import { htmlToText } from '../model/fields';
import { phaseOf, SEND_CONFIRM_MS, SEND_COPY, type SendIntent } from '../model/sendState';
import type { ComposeApi } from './composeApi';
import {
  keepUntilSaved,
  keptCount,
  releaseAllKept,
  releaseKeptFor,
  withKeptText,
} from './recovery';
import { handoffStore, release, watchedSends, type HandoffState } from './sendHandoff';
import { pushHeldSend } from './sendNotices';
import { createComposeSession, type ComposeSession, type SendAnswer } from './session';
import { bootStandIn, type StandInKit } from './standinKit';
import { toastPlan } from './toastPlan';
import { closeSession, followLateAnswer } from './useComposeSession';

const JORDAN = { id: 'jordan@example.com', name: 'Jordan Lee', address: 'jordan@example.com' };

function reply(kit: StandInKit): ComposeState {
  return freshCompose(
    { accountId: kit.accountId, mode: 'reply', threadId: kit.threadId },
    { to: [JORDAN], cc: [], bcc: [], subject: 'Re: plans', body: '' },
  );
}

function open(
  kit: StandInKit,
  options: {
    readonly initial?: ComposeState;
    readonly api?: ComposeApi;
    readonly notices?: string[];
    readonly onLateAnswer?: (answer: SendAnswer) => void;
  } = {},
): ComposeSession {
  const notices = options.notices ?? [];
  return createComposeSession(
    {
      api: options.api ?? kit.api,
      timers: kit.timers,
      notify: (notice, message) => notices.push(message ? `${notice}: ${message}` : notice),
      ...(options.onLateAnswer ? { onLateAnswer: options.onLateAnswer } : {}),
    },
    options.initial ?? reply(kit),
  );
}

async function typed(kit: StandInKit, session: ComposeSession, body: string) {
  session.dispatch({ type: 'edit', patch: { body }, now: kit.timers.now() });
  await kit.settle();
  kit.observe(session);
}

function press(kit: StandInKit, session: ComposeSession) {
  session.dispatch({ type: 'send', now: kit.timers.now(), undoSeconds: kit.undoSeconds });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------- 1: a refused Undo always says why

test('an Undo refused for another reason shows the engine’s sentence, not nothing', async () => {
  const kit = await bootStandIn();
  const notices: string[] = [];
  const session = open(kit, { notices });
  await typed(kit, session, 'Hello');
  press(kit, session);
  await kit.settle();
  kit.observe(session);
  await kit.control.failNextWrite({
    mode: 'reject',
    type: 'unavailable',
    message: 'The outbox is busy. Try again.',
  });
  session.dispatch({ type: 'action', action: 'undo' });
  await kit.settle();
  assert.deepEqual(notices, ['undoRefused: The outbox is busy. Try again.']);
  session.dispose();
});

// ---------------------------------------------------------------- 2: every send in the window keeps its Undo

function heldRow(id: string, extra: Partial<Submission> = {}): Submission {
  return {
    id,
    rev: 1,
    draftId: `d-${id}`,
    accountId: 'a1',
    internetId: `<${id}@example.test>`,
    revision: 1,
    state: 'queued',
    queuedAt: 0,
    notBefore: 30_000,
    toNames: [`Person ${id}`],
    subject: 'Plans',
    ...extra,
  };
}

test('four sends handed off inside one undo window: all four are followed, the first keeps its Undo', () => {
  resetToasts();
  let state: HandoffState = { handedOff: [], claims: new Map(), rows: new Map() };
  const rows = ['s1', 's2', 's3', 's4'].map(id => heldRow(id));
  for (const row of rows) state = release(state, row.id, true, row);
  const watched = watchedSends(state, []);
  assert.deepEqual(
    watched.map(w => w.id),
    ['s1', 's2', 's3', 's4'],
  );
  const plan = toastPlan(watched, 2_000, true, String);
  assert.equal(plan.tray?.row.id, 's4', 'the newest is the tray');
  assert.deepEqual(
    plan.held.map(h => h.row.id),
    ['s1', 's2', 's3'],
    'every older held send has its Undo toast',
  );
  for (const held of plan.held) pushHeldSend(held.row, held.recipients, held.secondsLeft);
  // Plain notices meanwhile never push an Undo toast out (the shell store's rule).
  for (let i = 0; i < 4; i++)
    addToast({ id: `plain-${i}`, kind: 'info', message: 'Archived', undoable: false });
  const undoable = getToasts().filter(t => t.id.startsWith('send-held-s'));
  assert.deepEqual(
    undoable.map(t => t.id),
    ['send-held-s1', 'send-held-s2', 'send-held-s3'],
  );
  assert.ok(undoable.every(t => t.undoable && t.actions?.some(a => a.label === 'Undo')));
  resetToasts();
});

test('the first of four sends failing late still reaches the toast stack', () => {
  let state: HandoffState = { handedOff: [], claims: new Map(), rows: new Map() };
  for (const id of ['s1', 's2', 's3', 's4']) state = release(state, id, true, heldRow(id));
  const failed = heldRow('s1', { state: 'failed', rev: 2 });
  const plan = toastPlan(watchedSends(state, [failed]), 40_000, true, String);
  assert.deepEqual(
    plan.failed.map(r => r.id),
    ['s1'],
  );
});

test('the app’s hand-off store follows a fourth send without dropping the first', () => {
  for (const id of ['h1', 'h2', 'h3', 'h4'])
    handoffStore.set(release(handoffStore.get(), id, true));
  const ids = watchedSends(handoffStore.get(), []).map(w => w.id);
  assert.ok(
    ['h1', 'h2', 'h3', 'h4'].every(id => ids.includes(id)),
    ids.join(' '),
  );
});

// ---------------------------------------------------------------- 3: locked by another window's send

test('another window’s send locks the draft: this window says so and sends nothing until Send is pressed again', async () => {
  const kit = await bootStandIn();
  const mine = open(kit);
  await typed(kit, mine, 'Hello');
  const id = mine.getState().save.draftId!;
  // The other window sends the draft as it stands.
  const theirs = open(kit, {
    initial: {
      ...reply(kit),
      fields: { ...reply(kit).fields, body: 'Hello' },
      save: { ...FRESH_SAVE, draftId: id, revision: 1, rowRev: 1 },
    },
  });
  theirs.dispatch({ type: 'observeDraft', draft: kit.draft(id)! });
  press(kit, theirs);
  await kit.settle();
  assert.equal(kit.submissions(id).length, 1, 'the other window’s send');

  mine.dispatch({ type: 'edit', patch: { body: 'Hello, and more' }, now: kit.timers.now() });
  press(kit, mine);
  await kit.settle();
  kit.observe(mine);
  await kit.advance(AUTOSAVE.retryMs[0]);
  kit.observe(mine);
  await kit.settle();
  const state = mine.getState();
  assert.equal(state.blocked?.message, SEND_COPY.sendingElsewhere);
  assert.equal(SEND_COPY.sendingElsewhere, 'This draft is being sent from another window.');
  assert.equal(state.open, true, 'the composer is back');
  assert.equal(state.send.kind, 'none', 'the press here did not send');
  const copy = state.save.draftId!;
  assert.notEqual(copy, id, 'the text is a draft of its own');
  assert.equal(htmlToText(kit.draft(copy)!.html), 'Hello, and more');
  const all = kit.engine.fixture.store.all('Submission').filter(s => s.draftId === copy);
  assert.equal(all.length, 0, 'no second copy went out by itself');

  press(kit, mine);
  await kit.settle();
  assert.equal(kit.submissions(copy).length, 1, 'only an explicit second Send mails it');
  mine.dispose();
  theirs.dispose();
});

test('a draft create whose reply was lost is retried with the same key: one draft, with the latest text', async () => {
  const kit = await bootStandIn();
  const before = kit.engine.fixture.store.all('Draft').length;
  let lost = false;
  const api: ComposeApi = {
    ...kit.api,
    async saveDraft(args) {
      const answer = await kit.api.saveDraft(args);
      if (args.id === undefined && !lost) {
        lost = true;
        throw new Error('the reply was lost');
      }
      return answer;
    },
  };
  const session = open(kit, { api });
  await typed(kit, session, 'H');
  assert.equal(lost, true);
  await typed(kit, session, 'Hello');
  await kit.advance(AUTOSAVE.retryMs[0]);
  await kit.advance(AUTOSAVE.maxWaitMs);
  const created = kit.engine.fixture.store.all('Draft').length - before;
  assert.equal(created, 1, 'one draft, not two');
  const id = session.getState().save.draftId!;
  assert.equal(
    htmlToText(kit.draft(id)!.html),
    'Hello',
    'the edits after the lost reply are saved',
  );
  assert.equal(session.getState().save.savedSeq, session.getState().save.editSeq);
  session.dispose();
});

// ---------------------------------------------------------------- 5: a send that never answers

test('a send with no answer after 15 s reads as unconfirmed: the page and Z let go, the toast stack takes it', async () => {
  resetToasts();
  const kit = await bootStandIn();
  const hang = deferred();
  const api: ComposeApi = {
    ...kit.api,
    setSubmission: args =>
      args.action.type === 'send'
        ? hang.promise.then(() => kit.api.setSubmission(args))
        : kit.api.setSubmission(args),
  };
  const late: SendAnswer[] = [];
  const session = open(kit, { api, onLateAnswer: answer => late.push(answer) });
  await typed(kit, session, 'Hello');
  press(kit, session);
  await kit.settle();
  assert.equal(pageDone(session.getState()), false, 'waiting for the answer');
  assert.ok(pendingUndoTable(session.getState(), session)['app.undo'], 'Z is this send’s');

  await kit.advance(SEND_CONFIRM_MS);
  const state = session.getState();
  assert.equal(state.send.kind === 'pending' && state.send.unconfirmed, true);
  assert.equal(phaseOf(state.send, kit.timers.now(), true).kind, 'uncertain');
  assert.equal(pageDone(state), true, 'the page goes');
  assert.deepEqual(pendingUndoTable(state, session), {}, 'Z is let go');
  closeSession(session);
  await kit.settle();
  const toast = getToasts().find(t => t.message === SEND_COPY.unconfirmed);
  assert.ok(toast, 'the toast stack says it');
  assert.deepEqual(
    toast.actions?.map(a => a.label),
    ['Check Sent'],
  );

  hang.resolve();
  await kit.settle();
  assert.equal(late.length, 1, 'the late answer is still followed');
  const answer = late[0]!;
  assert.equal(answer.type, 'sendAccepted');
  followLateAnswer(answer, session.getState());
  assert.equal(
    getToasts().some(t => t.message === SEND_COPY.unconfirmed),
    false,
    'the unconfirmed notice goes',
  );
  if (answer.type === 'sendAccepted')
    assert.ok(handoffStore.get().handedOff.includes(answer.submission.id), 'the stack follows it');
  assert.equal(
    kit.engine.fixture.store.all('Submission').filter(s => s.draftId === state.save.draftId).length,
    1,
  );
  resetToasts();
});

test('Send anyway on an unconfirmed send reuses its key: still one submission', async () => {
  const kit = await bootStandIn();
  const hang = deferred();
  let sends = 0;
  const api: ComposeApi = {
    ...kit.api,
    setSubmission: args => {
      if (args.action.type !== 'send') return kit.api.setSubmission(args);
      sends++;
      return sends === 1
        ? hang.promise.then(() => kit.api.setSubmission(args))
        : kit.api.setSubmission(args);
    },
  };
  const session = open(kit, { api });
  await typed(kit, session, 'Hello');
  press(kit, session);
  await kit.advance(SEND_CONFIRM_MS);
  session.dispatch({ type: 'action', action: 'sendAnyway' });
  await kit.settle();
  hang.resolve();
  await kit.settle();
  const id = session.getState().save.draftId!;
  assert.equal(kit.submissions(id).length, 1);
  assert.equal(session.getState().send.kind, 'tracking');
  session.dispose();
});

// ---------------------------------------------------------------- 6: Try again keeps the undo window

test('Try again on a send-at that has passed sends with the account’s undo window, not 0', () => {
  const now = 1_000_000;
  let state: ComposeState = {
    ...freshCompose(
      { accountId: 'a1', mode: 'new' },
      {
        to: [JORDAN],
        cc: [],
        bcc: [],
        subject: 'Plans',
        body: 'Hi',
      },
    ),
    save: { ...FRESH_SAVE, draftId: 'd1', revision: 1, rowRev: 1 },
  };
  const step = (event: Parameters<typeof composeReducer>[1]) => {
    state = composeReducer(state, event).state;
  };
  step({ type: 'send', now, undoSeconds: 10, notBefore: now + 60_000 });
  step({ type: 'sendRefused', refusal: { type: 'unavailable', message: 'down' } });
  assert.equal(state.send.kind, 'refused');
  const later = now + 120_000;
  step({ type: 'action', action: 'retry', now: later });
  const sendOf = (current: ComposeState): SendIntent => current.send;
  const retried = sendOf(state);
  assert.equal(retried.kind === 'pending' && retried.undoSeconds, 10);
  assert.equal(phaseOf(retried, later + 1_000, true).kind, 'submitting', 'with its Undo');
});

// ---------------------------------------------------------------- 7: a kept composer that is still sending

test('a kept composer whose send is in flight is not let go when a new composer opens on the draft', () => {
  releaseAllKept();
  const base = freshCompose(
    { accountId: 'a1', mode: 'new' },
    {
      to: [JORDAN],
      cc: [],
      bcc: [],
      subject: 'Plans',
      body: 'Unsaved words',
    },
  );
  const held: ComposeState = {
    ...base,
    open: false,
    save: { ...FRESH_SAVE, draftId: 'd1', revision: 1, rowRev: 1, editSeq: 2, savedSeq: 1 },
    send: { kind: 'tracking', submissionId: 's1', row: null },
  };
  let disposed = 0;
  const kept: ComposeSession = {
    getState: () => held,
    subscribe: () => () => undefined,
    dispatch: () => undefined,
    settled: async () => undefined,
    dispose: () => {
      disposed++;
    },
  };
  keepUntilSaved(kept);
  assert.equal(keptCount(), 1);
  const fresh: ComposeState = { ...base, save: { ...FRESH_SAVE, draftId: 'd1', revision: 1 } };
  assert.equal(withKeptText(fresh), fresh, 'not taken over: the new composer starts from the row');
  releaseKeptFor(fresh);
  assert.equal(disposed, 0, 'its unsaved text and its send are not dropped');
  assert.equal(keptCount(), 1);
  releaseAllKept();
});
