/**
 * The composer session against the stand-in engine (DESIGN 7.6; lane card criterion 5): autosave creates the draft on
 * the first keystroke and updates it debounced, a reload finds the draft and the send again, a double Return makes one
 * submission, Undo before the window closes cancels it, Discard asks first and destroys the draft. Nothing is sent
 * outside the stand-in. Run: `cd apps/desktop && npx tsx --test src/renderer/screens/compose/runtime/session.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTOSAVE } from '../model/autosave';
import { composeFromDraft, freshCompose } from '../model/composeState';
import { htmlToText } from '../model/fields';
import { phaseOf } from '../model/sendState';
import { createComposeSession, type ComposeSession } from './session';
import { bootStandIn, type StandInKit } from './standinKit';

const JORDAN = { id: 'jordan@example.com', name: 'Jordan Lee', address: 'jordan@example.com' };

function open(kit: StandInKit, notices: string[] = []): ComposeSession {
  const initial = freshCompose(
    { accountId: kit.accountId, mode: 'reply', threadId: kit.threadId },
    {
      to: [JORDAN],
      cc: [],
      bcc: [],
      subject: 'Re: plans',
      body: '',
    },
  );
  return createComposeSession(
    { api: kit.api, timers: kit.timers, notify: n => notices.push(n) },
    initial,
  );
}

async function type(kit: StandInKit, session: ComposeSession, body: string) {
  session.dispatch({ type: 'edit', patch: { body }, now: kit.timers.now() });
  await kit.settle();
  kit.observe(session);
}

async function send(kit: StandInKit, session: ComposeSession) {
  session.dispatch({ type: 'send', now: kit.timers.now(), undoSeconds: kit.undoSeconds });
  await kit.settle();
  kit.observe(session);
}

test('the first keystroke creates the draft at once, later edits save after a quiet spell', async () => {
  const kit = await bootStandIn();
  const session = open(kit);
  assert.equal(session.getState().save.draftId, null, 'an untouched reply has no draft');
  await type(kit, session, 'H');
  const id = session.getState().save.draftId;
  assert.ok(id, 'created on the first keystroke');
  await type(kit, session, 'Hello there');
  assert.equal(htmlToText(kit.draft(id)!.html), 'H', 'not saved before the quiet spell');
  await kit.advance(AUTOSAVE.quietMs);
  kit.observe(session);
  assert.equal(htmlToText(kit.draft(id)!.html), 'Hello there');
  assert.equal(session.getState().save.savedSeq, session.getState().save.editSeq);
});

test('a reload finds the draft text, and a reload during the undo window finds the send', async () => {
  const kit = await bootStandIn();
  const first = open(kit);
  await type(kit, first, 'See you at noon.');
  const id = first.getState().save.draftId!;
  first.dispose();
  const reopened = createComposeSession(
    { api: kit.api, timers: kit.timers },
    composeFromDraft(kit.draft(id)!),
  );
  assert.equal(reopened.getState().fields.body, 'See you at noon.');
  await send(kit, reopened);
  reopened.dispose();
  const afterReload = createComposeSession(
    { api: kit.api, timers: kit.timers },
    composeFromDraft(kit.draft(id)!),
  );
  kit.observe(afterReload);
  const phase = phaseOf(afterReload.getState().send, kit.timers.now(), true);
  assert.equal(phase.kind, 'held', 'the tray comes back from the engine row');
  assert.equal(
    afterReload.getState().open,
    false,
    'the composer stays closed while the send owns the draft',
  );
});

test('a double Return makes one submission; Undo inside the window cancels it and reopens the draft', async () => {
  const kit = await bootStandIn();
  const session = open(kit);
  await type(kit, session, 'Twice?');
  session.dispatch({ type: 'send', now: kit.timers.now(), undoSeconds: kit.undoSeconds });
  session.dispatch({ type: 'send', now: kit.timers.now(), undoSeconds: kit.undoSeconds });
  await kit.settle();
  kit.observe(session);
  const id = session.getState().save.draftId!;
  assert.equal(kit.submissions(id).length, 1);
  assert.equal(kit.calls.filter(c => c === 'Submission/set send').length, 1);
  session.dispatch({ type: 'action', action: 'undo' });
  await kit.settle();
  kit.observe(session);
  assert.equal(kit.submissions(id)[0]!.state, 'cancelled');
  assert.equal(session.getState().open, true, 'the draft comes back');
  assert.equal(session.getState().fields.body, 'Twice?');
  await kit.advance(kit.undoSeconds * 1000 + 1000);
  assert.equal(kit.sentMessages().length, 0, 'nothing left');
});

test('after the window the stand-in sends once and the draft becomes the sent message', async () => {
  const kit = await bootStandIn();
  const session = open(kit);
  await type(kit, session, 'On my way.');
  const id = session.getState().save.draftId!;
  await send(kit, session);
  await kit.advance(kit.undoSeconds * 1000 + 500);
  kit.observe(session);
  assert.equal(kit.draft(id), undefined);
  assert.equal(kit.submissions(id)[0]!.state, 'sent');
  assert.equal(session.getState().ended, 'sent');
  assert.equal(kit.sentMessages().length, 1);
});

test('Discard asks first, then destroys the draft and says so', async () => {
  const kit = await bootStandIn();
  const notices: string[] = [];
  const session = open(kit, notices);
  await type(kit, session, 'Never mind.');
  const id = session.getState().save.draftId!;
  session.dispatch({ type: 'askDiscard' });
  await kit.settle();
  assert.equal(session.getState().confirm, 'discard');
  assert.ok(kit.draft(id), 'asking does not discard');
  session.dispatch({ type: 'confirmDiscard' });
  await kit.settle();
  assert.equal(kit.draft(id), undefined);
  assert.deepEqual(notices, ['discarded']);
});

test('From: a new message moves to the other account, keeps its text, and says nothing about a discard', async () => {
  const kit = await bootStandIn();
  const other = kit.engine.fixture.store.all('Account').find(a => a.id !== kit.accountId)!;
  const notices: string[] = [];
  const session = createComposeSession(
    { api: kit.api, timers: kit.timers, notify: n => notices.push(n) },
    freshCompose({ accountId: kit.accountId, mode: 'new' }),
  );
  await type(kit, session, 'Hello there');
  const first = session.getState().save.draftId!;
  assert.equal(kit.draft(first)!.accountId, kit.accountId);
  session.dispatch({ type: 'setAccount', accountId: other.id, now: kit.timers.now() });
  await kit.settle();
  kit.observe(session);
  const moved = session.getState().save.draftId!;
  assert.notEqual(moved, first, 'a new draft in the new account');
  assert.equal(kit.draft(first), undefined, 'the old one is gone');
  assert.equal(kit.draft(moved)!.accountId, other.id);
  assert.equal(htmlToText(kit.draft(moved)!.html), 'Hello there');
  assert.deepEqual(notices, [], 'a move is not a discard');
});

test('From: a reply moves to the other account before and after its first save, and keeps its thread', async () => {
  const kit = await bootStandIn();
  const other = kit.engine.fixture.store.all('Account').find(a => a.id !== kit.accountId)!;
  const before = open(kit);
  before.dispatch({ type: 'setAccount', accountId: other.id, now: kit.timers.now() });
  await kit.settle();
  await type(kit, before, 'Sounds good');
  const fresh = before.getState().save.draftId!;
  assert.ok(fresh, 'saved');
  assert.equal(
    before.getState().save.savedSeq,
    before.getState().save.editSeq,
    'nothing left unsaved',
  );
  assert.equal(kit.draft(fresh)!.accountId, other.id);
  assert.equal(kit.draft(fresh)!.threadId, kit.threadId, 'still a reply in the same thread');
  const after = open(kit);
  await type(kit, after, 'On my way');
  const first = after.getState().save.draftId!;
  after.dispatch({ type: 'setAccount', accountId: other.id, now: kit.timers.now() });
  await kit.settle();
  kit.observe(after);
  const moved = after.getState().save.draftId!;
  assert.notEqual(moved, first);
  assert.equal(kit.draft(first), undefined, 'the old account’s copy is gone');
  assert.equal(kit.draft(moved)!.accountId, other.id);
  assert.equal(kit.draft(moved)!.mode, 'reply');
  assert.equal(after.getState().save.savedSeq, after.getState().save.editSeq);
});

test('From: a create that was committed but whose reply was lost never binds the composer to the old account', async () => {
  const kit = await bootStandIn();
  const other = kit.engine.fixture.store.all('Account').find(a => a.id !== kit.accountId)!;
  let lost = true;
  const api = {
    ...kit.api,
    saveDraft: async (args: Parameters<typeof kit.api.saveDraft>[0]) => {
      const answer = await kit.api.saveDraft(args);
      if (lost) {
        lost = false;
        throw new Error('the reply was lost');
      }
      return answer;
    },
  };
  const session = createComposeSession(
    { api, timers: kit.timers },
    freshCompose({ accountId: kit.accountId, mode: 'new' }),
  );
  session.dispatch({ type: 'edit', patch: { body: 'Hello there' }, now: kit.timers.now() });
  await kit.settle();
  assert.equal(session.getState().save.draftId, null, 'the first create looked failed');
  session.dispatch({ type: 'setAccount', accountId: other.id, now: kit.timers.now() });
  await kit.advance(AUTOSAVE.retryMs[0]);
  kit.observe(session);
  const id = session.getState().save.draftId!;
  assert.ok(id, 'the retry saved');
  assert.equal(kit.draft(id)!.accountId, other.id, 'the draft is in the account the row shows');
  assert.equal(htmlToText(kit.draft(id)!.html), 'Hello there');
  assert.equal(session.getState().save.savedSeq, session.getState().save.editSeq);
  const left = kit.engine.fixture.store
    .all('Draft')
    .filter(d => d.accountId === kit.accountId && htmlToText(d.html) === 'Hello there');
  assert.equal(left.length, 0, 'the create that did commit in the old account is removed');
});

test('a later autosave still fires when the clock stands still (the visual gallery): the timer firing means it is due', async () => {
  const kit = await bootStandIn();
  const frozen = kit.timers.now();
  const fired: (() => void)[] = [];
  const timers = {
    now: () => frozen,
    setTimeout(callback: () => void) {
      fired.push(callback);
      return () => {
        const at = fired.indexOf(callback);
        if (at >= 0) fired.splice(at, 1);
      };
    },
  };
  const session = createComposeSession(
    { api: kit.api, timers },
    freshCompose(
      { accountId: kit.accountId, mode: 'reply', threadId: kit.threadId },
      { to: [JORDAN], cc: [], bcc: [], subject: 'Re: plans', body: '' },
    ),
  );
  session.dispatch({ type: 'edit', patch: { body: 'H' }, now: frozen });
  await session.settled();
  const id = session.getState().save.draftId;
  assert.ok(id, 'the first keystroke created the draft');
  session.dispatch({ type: 'edit', patch: { body: 'Hello there' }, now: frozen });
  assert.ok(fired.length > 0, 'a save is scheduled');
  fired.splice(0).forEach(callback => callback());
  await session.settled();
  assert.equal(
    htmlToText(kit.draft(id)!.html),
    'Hello there',
    'saved although the clock never moved',
  );
  assert.equal(session.getState().save.savedSeq, session.getState().save.editSeq);
  session.dispose();
});

test('a wall clock stepped back an hour holds a save no longer than autosave’s longest wait', async () => {
  const kit = await bootStandIn();
  let skew = 0;
  const first = open(kit);
  await type(kit, first, 'Draft one.');
  const id = first.getState().save.draftId!;
  first.dispose();
  const session = createComposeSession(
    {
      api: kit.api,
      timers: { now: () => kit.timers.now() + skew, setTimeout: kit.timers.setTimeout },
    },
    composeFromDraft(kit.draft(id)!),
  );
  session.dispatch({ type: 'edit', patch: { body: 'Sounds good' }, now: kit.timers.now() });
  skew = -3_600_000;
  // Any later event re-arms the timer (here the draft row arriving again), now against the stepped-back clock.
  kit.observe(session);
  await kit.advance(Math.max(AUTOSAVE.quietMs, AUTOSAVE.maxWaitMs, ...AUTOSAVE.retryMs));
  kit.observe(session);
  assert.equal(htmlToText(kit.draft(id)!.html), 'Sounds good');
  session.dispose();
});
