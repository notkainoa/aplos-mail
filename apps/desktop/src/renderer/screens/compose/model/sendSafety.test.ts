/**
 * The send-safety review's findings, at the reducer (pure: no engine, no clock but the numbers passed in). Each test
 * failed before its fix: a second press while pending (mutant M1) and a per-press opId (mutant M2), Try again after a
 * refused send later, Undo pressed before an answer of "already on its way", an Undo that lost the race, a stale or
 * missing draft on save, a send-at in the past, the autosave cap, the draft line of an untouched message and hidden
 * Cc rows that still send.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, Submission } from '../../../data';
import { AUTOSAVE, draftStateOf, FRESH_SAVE, saveDueAt } from './autosave';
import { composeReducer } from './composeReducer';
import {
  composeFromDraft,
  freshCompose,
  sendOpId,
  type ComposeEffect,
  type ComposeEvent,
  type ComposeState,
} from './composeState';
import { ccRowsShown } from './composeView';
import { phaseOf } from './sendState';

const T0 = 1_000_000;
const JORDAN = { id: 'jordan@example.com', name: 'Jordan Lee', address: 'jordan@example.com' };
const CONTEXT = { accountId: 'a1', mode: 'reply' as const, threadId: 't1', replyToMessageId: 'm1' };

function run(
  state: ComposeState,
  ...events: ComposeEvent[]
): { state: ComposeState; effects: ComposeEffect[] } {
  const effects: ComposeEffect[] = [];
  let current = state;
  for (const event of events) {
    const step = composeReducer(current, event);
    current = step.state;
    effects.push(...step.effects);
  }
  return { state: current, effects };
}

function draftRow(extra: Partial<Draft> = {}): Draft {
  return {
    id: 'd1',
    rev: 1,
    revision: 1,
    accountId: 'a1',
    mode: 'reply',
    threadId: 't1',
    to: [{ address: 'jordan@example.com', name: 'Jordan Lee' }],
    cc: [],
    bcc: [],
    subject: 'Re: plans',
    html: '<p>Hello</p>',
    attachments: [],
    signature: false,
    updatedAt: T0,
    origin: 'local',
    sync: 'localOnly',
    ...extra,
  };
}

function subRow(state: Submission['state'], extra: Partial<Submission> = {}): Submission {
  return {
    id: 's1',
    rev: 1,
    draftId: 'd1',
    accountId: 'a1',
    internetId: '<s1@example.test>',
    revision: 1,
    state,
    queuedAt: T0,
    notBefore: T0 + 8_000,
    toNames: ['Jordan Lee'],
    subject: 'Re: plans',
    ...extra,
  };
}

function fresh(): ComposeState {
  return freshCompose(CONTEXT, { to: [JORDAN], cc: [], bcc: [], subject: 'Re: plans', body: '' });
}

/** "Hello" saved as draft d1 revision 1. */
function saved(): ComposeState {
  const typed = run(fresh(), { type: 'edit', patch: { body: 'Hello' }, now: T0 });
  return run(typed.state, { type: 'saved', seq: 1, draft: { id: 'd1', revision: 1, rev: 1 } })
    .state;
}

const press = (now = T0, extra: Partial<Extract<ComposeEvent, { type: 'send' }>> = {}) =>
  ({ type: 'send', now, undoSeconds: 8, ...extra }) as const;

const submits = (effects: readonly ComposeEffect[]) => effects.filter(e => e.type === 'submit');

test('M1: a second Return before the engine answers changes nothing and asks for nothing', () => {
  const first = run(saved(), press());
  assert.equal(submits(first.effects).length, 1);
  const second = composeReducer(first.state, press(T0 + 40));
  assert.deepEqual(second.effects, [], 'no second Submission/set send');
  assert.equal(
    second.state,
    first.state,
    'the pending send (its press time, its Undo) is kept as it was',
  );
});

test('M1: Undo, then Return again, before the answer: the Undo still reaches the send', () => {
  const pressed = run(saved(), press(), { type: 'action', action: 'undo' }, press(T0 + 50));
  assert.equal(submits(pressed.effects).length, 1, 'one send for the two presses');
  const accepted = run(pressed.state, { type: 'sendAccepted', submission: subRow('queued') });
  assert.deepEqual(accepted.effects, [
    { type: 'submission', action: { type: 'undo', submissionId: 's1' } },
  ]);
});

test('M2: the send key is the draft, its revision, its row version and the attempt; never per press', () => {
  const one = submits(run(saved(), press()).effects)[0];
  const other = submits(run(saved(), press(T0 + 9_999)).effects)[0];
  assert.ok(one?.type === 'submit' && other?.type === 'submit');
  assert.equal(one.opId, sendOpId('d1', 1, 1, 0));
  assert.equal(one.opId, other.opId, 'two composers on the same draft and revision share the key');
  const twin = submits(run(composeFromDraft(draftRow()), press(T0 + 5)).effects)[0];
  assert.ok(twin?.type === 'submit');
  assert.equal(twin.opId, one.opId, 'a second composer from the row uses the same key');
});

test('Try again after a refused send later keeps its time and its Done', () => {
  const at = T0 + 3_600_000;
  const pressed = run(saved(), press(T0, { notBefore: at, alsoDone: true })).state;
  const refused = run(pressed, {
    type: 'sendRefused',
    refusal: { type: 'paused', message: 'limit', reasonCode: 'quota.sendLimit' },
  }).state;
  const again = run(refused, { type: 'action', action: 'retry', now: T0 + 60_000 });
  const submit = submits(again.effects)[0];
  assert.ok(submit?.type === 'submit');
  assert.equal(submit.notBefore, at, 'still a send later');
  assert.equal(submit.alsoDone, true);
  assert.equal(phaseOf(again.state.send, T0 + 60_000, true).kind, 'scheduled');
  const late = run(refused, { type: 'action', action: 'retry', now: at + 1 });
  const lateSubmit = submits(late.effects)[0];
  assert.ok(lateSubmit?.type === 'submit');
  assert.equal(
    lateSubmit.notBefore,
    undefined,
    'a time that has passed sends now (with the undo window)',
  );
});

test('a send-at in the past is never scheduled: it sends now with the undo window', () => {
  const step = run(saved(), press(T0, { notBefore: T0 - 60_000 }));
  const submit = submits(step.effects)[0];
  assert.ok(submit?.type === 'submit');
  assert.equal(submit.notBefore, undefined);
  assert.equal(phaseOf(step.state.send, T0, true).kind, 'submitting');
});

test('Undo pressed before an answer of "already on its way" follows the send the draft row names', () => {
  const pressed = run(saved(), press(), { type: 'action', action: 'undo' }).state;
  const conflict = run(pressed, {
    type: 'sendRefused',
    refusal: { type: 'conflict', message: 'This message is already on its way.' },
  }).state;
  const found = run(conflict, {
    type: 'observeDraft',
    draft: draftRow({ rev: 2, submissionId: 's9' }),
  });
  assert.equal(found.state.send.kind, 'tracking');
  assert.deepEqual(found.effects, [
    { type: 'submission', action: { type: 'undo', submissionId: 's9' } },
  ]);
});

test('an Undo that lost the race says "Already sent."', () => {
  const step = composeReducer(saved(), { type: 'undoLost' });
  assert.deepEqual(step.effects, [{ type: 'notify', notice: 'alreadySent' }]);
});

test('a save on a draft that no longer exists makes a new draft instead of retrying for ever', () => {
  const dirty = run(saved(), { type: 'edit', patch: { body: 'Hello again' }, now: T0 + 1_000 });
  const flight = run(dirty.state, { type: 'tick', now: T0 + 1_000 + AUTOSAVE.quietMs });
  assert.equal(flight.effects[0]?.type, 'save');
  const gone = run(flight.state, { type: 'saveFailed', seq: 2, now: T0 + 2_000, cause: 'gone' });
  const save = gone.effects[0];
  assert.ok(save?.type === 'save', 'saved again at once');
  assert.equal(save.draftId, null, 'as a new draft');
  assert.equal(save.fields.body, 'Hello again', 'with the text');
});

test('a stale save keeps the newer remote as its own draft, then saves the local text on top', () => {
  const dirty = run(saved(), { type: 'edit', patch: { body: 'Mine' }, now: T0 + 1_000 });
  const flight = run(dirty.state, { type: 'tick', now: T0 + 1_000 + AUTOSAVE.quietMs }).state;
  const refused = run(flight, { type: 'saveFailed', seq: 2, now: T0 + 2_000, cause: 'mismatch' });
  assert.deepEqual(refused.effects, [], 'no blind retry on the same base');
  assert.equal(saveDueAt(refused.state.save), null, 'not on the backoff either');
  const theirs = draftRow({ revision: 3, rev: 4, html: '<p>Theirs</p>' });
  const seen = run(refused.state, { type: 'observeDraft', draft: theirs, now: T0 + 2_100 });
  assert.deepEqual(seen.effects, [{ type: 'preserve', draft: theirs }], 'theirs is kept first');
  assert.equal(seen.state.fields.body, 'Mine', 'the local text is never replaced');
  const kept = run(seen.state, { type: 'preserved', ok: true, now: T0 + 2_200 });
  const save = kept.effects[0];
  assert.ok(save?.type === 'save');
  assert.equal(save.draftId, 'd1');
  assert.equal(
    save.baseRevision,
    3,
    'on top of the newer revision: local wins as the next revision',
  );
  assert.equal(save.fields.body, 'Mine');
});

test('a stale save whose remote copy fails moves the local text to a new draft', () => {
  const dirty = run(saved(), { type: 'edit', patch: { body: 'Mine' }, now: T0 + 1_000 });
  const flight = run(dirty.state, { type: 'tick', now: T0 + 1_000 + AUTOSAVE.quietMs }).state;
  const theirs = draftRow({ revision: 3, rev: 4, html: '<p>Theirs</p>' });
  const seen = run(flight, { type: 'observeDraft', draft: theirs, now: T0 + 1_900 }).state;
  const refused = run(seen, { type: 'saveFailed', seq: 2, now: T0 + 2_000, cause: 'mismatch' });
  assert.deepEqual(
    refused.effects,
    [{ type: 'preserve', draft: theirs }],
    'the row already seen explains it',
  );
  const failed = run(refused.state, { type: 'preserved', ok: false, now: T0 + 2_100 });
  const save = failed.effects[0];
  assert.ok(save?.type === 'save');
  assert.equal(save.draftId, null);
  assert.equal(save.fields.body, 'Mine');
});

test('a save refused because another window is sending the draft: the text goes to a new draft, this send stops', () => {
  const dirty = run(saved(), { type: 'edit', patch: { body: 'Mine' }, now: T0 + 1_000 }).state;
  const pressed = run(dirty, press(T0 + 1_100)).state;
  const locked = draftRow({ submissionId: 's7' });
  const seen = run(pressed, { type: 'observeDraft', draft: locked, now: T0 + 1_200 }).state;
  const refused = run(seen, { type: 'saveFailed', seq: 2, now: T0 + 1_300, cause: 'mismatch' });
  assert.equal(refused.state.send.kind, 'none', 'no second send of the same message');
  assert.equal(refused.state.open, true, 'the composer comes back with the text');
  const save = refused.effects[0];
  assert.ok(save?.type === 'save');
  assert.equal(save.draftId, null);
  assert.equal(save.fields.body, 'Mine');
});

test('autosave never lets typing go unsaved for more than 2 s', () => {
  assert.ok(AUTOSAVE.maxWaitMs <= 2_000);
  const clock = { ...FRESH_SAVE, draftId: 'd1', revision: 1, editSeq: 9, savedSeq: 1 };
  const typing = { ...clock, firstDirtyAt: T0, lastEditAt: T0 + 1_990 };
  assert.ok(saveDueAt(typing)! <= T0 + 2_000);
});

test('an untouched new message has no draft line; a draft on the engine says "Draft saved"', () => {
  assert.equal(draftStateOf(FRESH_SAVE), 'none');
  assert.equal(draftStateOf(saved().save), 'saved');
  assert.equal(draftStateOf(composeFromDraft(draftRow()).save), 'saved');
});

test('Cc and Bcc rows that hold recipients are never hidden', () => {
  const none = { cc: [], bcc: [] };
  assert.equal(ccRowsShown(false, none), false);
  assert.equal(ccRowsShown(true, none), true);
  assert.equal(ccRowsShown(false, { cc: [JORDAN], bcc: [] }), true, 'toggled off with a Cc');
  assert.equal(ccRowsShown(false, { cc: [], bcc: [JORDAN] }), true, 'toggled off with a Bcc');
});
