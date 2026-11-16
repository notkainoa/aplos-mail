/**
 * What happens to a send once its composer is gone, against the stand-in engine (nothing leaves the stand-in): the
 * compose page waits for the engine's answer and Z undoes this send meanwhile; a refused send becomes the notice
 * "Couldn’t send to Jordan. Your draft is saved." with Try again and Edit; every phase of a handed-off send reaches the
 * toast stack (older held sends stack instead of being replaced); a late Undo says "Already sent."; text the engine
 * never confirmed stays kept and is taken over by the next composer; saves on a vanished or stale draft never loop; and
 * hiding the window flushes the autosave. Run: `cd apps/desktop && npx tsx --test
 * src/renderer/screens/compose/runtime/sendHandoff.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Submission } from '../../../data';
import { getToasts, resetToasts } from '../../../shell/store-toast';
import { pageDone, pendingUndoTable } from '../ComposeScreen';
import { composeFromDraft, freshCompose, type ComposeState } from '../model/composeState';
import { htmlToText } from '../model/fields';
import { SEND_COPY } from '../model/sendState';
import { keptCount, releaseAllKept, withKeptText } from './recovery';
import { createComposeSession, type ComposeSession } from './session';
import { bootStandIn, type StandInKit } from './standinKit';
import { toastPlan, type Watched } from './toastPlan';
import { closeSession, flushOnHide, handOffIfLive } from './useComposeSession';

const JORDAN = { id: 'jordan@example.com', name: 'Jordan Lee', address: 'jordan@example.com' };

function reply(kit: StandInKit): ComposeState {
  return freshCompose(
    { accountId: kit.accountId, mode: 'reply', threadId: kit.threadId },
    { to: [JORDAN], cc: [], bcc: [], subject: 'Re: plans', body: '' },
  );
}

function open(kit: StandInKit, initial: ComposeState = reply(kit), notices: string[] = []) {
  return createComposeSession(
    { api: kit.api, timers: kit.timers, notify: n => notices.push(n) },
    initial,
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

const messages = () => getToasts().map(t => t.message);

test('the compose page stays while the send awaits its answer, and Z then undoes this send', async () => {
  const kit = await bootStandIn();
  const session = open(kit);
  await typed(kit, session, 'Hello');
  press(kit, session);
  assert.equal(pageDone(session.getState()), false, 'pending: the page waits for the answer');
  const z = pendingUndoTable(session.getState(), session)['app.undo'];
  assert.ok(z, 'Z belongs to this send, not to an older triage action');
  z.run?.({} as never);
  await kit.settle();
  kit.observe(session);
  const id = session.getState().save.draftId!;
  assert.equal(kit.submissions(id).filter(s => s.state === 'queued').length, 0, 'the Undo won');
  assert.equal(pageDone(session.getState()), false, 'the composer is back on the draft');
  session.dispose();
});

test('a refused send after the page closed says so on the toast stack, never silently', async () => {
  resetToasts();
  const kit = await bootStandIn();
  const session = open(kit);
  await typed(kit, session, 'Hello');
  await kit.control.failNextWrite({ mode: 'reject', type: 'paused', message: 'limit' });
  press(kit, session);
  closeSession(session);
  await kit.settle();
  const state = session.getState();
  assert.equal(state.send.kind, 'refused');
  assert.equal(pageDone(state), true);
  const toast = getToasts().find(t => t.message === SEND_COPY.failed('Jordan'));
  assert.ok(toast, `the refusal reached the toast stack: ${messages().join(' | ')}`);
  assert.deepEqual(
    toast.actions?.map(a => a.label),
    ['Try again', 'Edit'],
  );
  assert.equal(toast.kind, 'error');
  assert.equal(toast.persistent, true, 'the toast stays until the owner acts on it');
  assert.equal(htmlToText(kit.draft(state.save.draftId!)!.html), 'Hello', 'the draft is saved');
  resetToasts();
});

test('an Undo that reaches the engine after the send left says "Already sent."', async () => {
  const kit = await bootStandIn();
  const notices: string[] = [];
  const session = open(kit, reply(kit), notices);
  await typed(kit, session, 'Hello');
  press(kit, session);
  await kit.settle();
  kit.observe(session);
  await kit.advance(kit.undoSeconds * 1000 + 5_000);
  // The tray still shows the held row (its next frame has not arrived) when Undo is pressed.
  session.dispatch({ type: 'action', action: 'undo' });
  await kit.settle();
  assert.deepEqual(notices, ['alreadySent']);
  assert.equal(SEND_COPY.alreadySent, 'Already sent.');
  session.dispose();
});

function row(id: string, state: Submission['state'], extra: Partial<Submission> = {}): Submission {
  return {
    id,
    rev: 1,
    draftId: `d-${id}`,
    accountId: 'a1',
    internetId: `<${id}@example.test>`,
    revision: 1,
    state,
    queuedAt: 0,
    notBefore: 8_000,
    toNames: [id === 's1' ? 'Jordan Lee' : 'Mina Cho'],
    subject: 'Plans',
    ...extra,
  };
}

const watched = (...rows: Submission[]): Watched[] => rows.map(r => ({ id: r.id, row: r }));

test('two handed-off held sends: the newest is the tray, the older keeps its Undo as a toast', () => {
  const plan = toastPlan(watched(row('s1', 'queued'), row('s2', 'queued')), 2_000, true, String);
  assert.equal(plan.tray?.row.id, 's2');
  assert.deepEqual(
    plan.held.map(h => [h.row.id, h.recipients, h.secondsLeft]),
    [['s1', 'Jordan', 6]],
  );
  assert.deepEqual(plan.settle, []);
});

test('every phase of a handed-off send reaches the toast stack; only a finished send leaves it', () => {
  const scheduled = row('s3', 'scheduled', { notBefore: 3_600_000 });
  const failed = row('s4', 'failed');
  const sending = row('s5', 'queued', { notBefore: 0 });
  const offline = row('s6', 'queued', { notBefore: 0 });
  const plan = toastPlan(watched(scheduled, failed, sending), 2_000, true, () => 'tomorrow');
  assert.deepEqual(plan.notices, [
    { id: 's3', kind: 'scheduled', message: 'Scheduled for tomorrow', actions: ['undo'] },
  ]);
  assert.deepEqual(
    plan.failed.map(r => r.id),
    ['s4'],
  );
  assert.deepEqual(
    plan.settle,
    ['s3', 's4'],
    'a send on its way stays followed; a send later belongs to Scheduled; a failure to its notice',
  );
  const away = toastPlan(watched(offline), 2_000, false, String);
  assert.deepEqual(
    away.notices.map(n => n.message),
    [SEND_COPY.offline],
  );
  const done = toastPlan(watched(row('s7', 'sent'), row('s8', 'cancelled')), 2_000, true, String);
  assert.deepEqual(done.settle, ['s7', 's8']);
  assert.equal(done.tray, null);
});

test('handing off a tracked send is still one notice; a refusal is the failure notice', async () => {
  resetToasts();
  const kit = await bootStandIn();
  const session = open(kit);
  await typed(kit, session, 'Hello');
  await kit.control.failNextWrite({ mode: 'reject', type: 'paused', message: 'limit' });
  press(kit, session);
  await kit.settle();
  handOffIfLive(session.getState());
  handOffIfLive(session.getState());
  assert.equal(
    getToasts().filter(t => t.message === SEND_COPY.failed('Jordan')).length,
    1,
    'one notice per send',
  );
  session.dispose();
  resetToasts();
});

test('text the engine never confirmed is kept after the composer closes and taken over by the next one', async () => {
  releaseAllKept();
  const kit = await bootStandIn();
  const session = open(kit);
  await typed(kit, session, 'Hello');
  const id = session.getState().save.draftId!;
  await kit.control.failNextWrite({ mode: 'reject', type: 'unavailable', message: 'down' });
  session.dispatch({ type: 'edit', patch: { body: 'Hello, unsaved' }, now: kit.timers.now() });
  closeSession(session);
  await kit.settle();
  assert.equal(keptCount(), 1, 'not let go while unsaved');
  const next = withKeptText(composeFromDraft(kit.draft(id)!));
  assert.equal(
    next.fields.body,
    'Hello, unsaved',
    'the next composer starts from the unsaved text',
  );
  await kit.advance(60_000);
  assert.equal(
    htmlToText(kit.draft(id)!.html),
    'Hello, unsaved',
    'the kept composer saved it on retry',
  );
  assert.equal(keptCount(), 0, 'and let go once saved');
});

test('a save onto a draft destroyed elsewhere makes a new draft with the text, once', async () => {
  const kit = await bootStandIn();
  const session = open(kit);
  await typed(kit, session, 'Hello');
  const id = session.getState().save.draftId!;
  await kit.api.destroyDraft({ id });
  await typed(kit, session, 'Hello again');
  await kit.advance(5_000);
  const now = session.getState().save.draftId!;
  assert.notEqual(now, id);
  assert.equal(htmlToText(kit.draft(now)!.html), 'Hello again');
  const saves = kit.calls.filter(c => c.startsWith('Draft/set'));
  assert.ok(saves.length <= 4, `no retry loop: ${saves.join(', ')}`);
  session.dispose();
});

test('a stale save keeps the other window’s text as its own draft and saves this one on top', async () => {
  const kit = await bootStandIn();
  const session = open(kit);
  await typed(kit, session, 'Hello');
  const id = session.getState().save.draftId!;
  const other = open(kit, composeFromDraft(kit.draft(id)!));
  await typed(kit, other, 'Theirs');
  await kit.advance(5_000);
  await typed(kit, session, 'Mine');
  await kit.advance(5_000);
  kit.observe(session);
  await kit.advance(5_000);
  assert.equal(htmlToText(kit.draft(id)!.html), 'Mine', 'local wins as the next revision');
  const texts = kit.engine.fixture.store.all('Draft').map(d => htmlToText(d.html));
  assert.ok(texts.includes('Theirs'), 'the newer remote text is kept, not overwritten');
  session.dispose();
  other.dispose();
});

test('hiding or closing the window flushes the autosave', () => {
  const flushed: string[] = [];
  const handlers = new Map<string, () => void>();
  const target = {
    addEventListener: (type: string, fn: () => void) => handlers.set(type, fn),
    removeEventListener: (type: string) => handlers.delete(type),
  };
  const doc = { ...target, visibilityState: 'hidden' as DocumentVisibilityState };
  const stop = flushOnHide(
    { dispatch: event => flushed.push(event.type) },
    target as never,
    doc as never,
  );
  handlers.get('pagehide')?.();
  handlers.get('beforeunload')?.();
  handlers.get('visibilitychange')?.();
  assert.deepEqual(flushed, ['flush', 'flush', 'flush']);
  stop();
  assert.equal(handlers.size, 0);
});
