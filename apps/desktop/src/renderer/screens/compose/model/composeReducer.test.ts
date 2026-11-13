/**
 * The composer reducer, transition by transition (DESIGN 7.6): autosave, Send with unsaved edits, a second Return,
 * Undo before and after the answer, every follow-up verb on every state, refusals, the Esc ladder, discard, the dim
 * suggestion and dictation. Pure: no engine, no clock but the numbers passed in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, Submission } from '../../../data';
import { AUTOSAVE } from './autosave';
import { canChangeAccount, composeReducer } from './composeReducer';
import {
  composeFromDraft,
  freshCompose,
  sendOpId,
  type ComposeEffect,
  type ComposeEvent,
  type ComposeState,
} from './composeState';
import type { SendAction } from './sendState';

const T0 = 1_000_000;
const JORDAN = { id: 'jordan@example.com', name: 'Jordan Lee', address: 'jordan@example.com' };
const CONTEXT = { accountId: 'a1', mode: 'reply' as const, threadId: 't1', replyToMessageId: 'm1' };

function fresh(): ComposeState {
  return freshCompose(CONTEXT, { to: [JORDAN], cc: [], bcc: [], subject: 'Re: plans', body: '' });
}

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

/** A composer with "Hello" saved as draft d1 revision 1. */
function saved(): ComposeState {
  const typed = run(fresh(), { type: 'edit', patch: { body: 'Hello' }, now: T0 });
  return run(typed.state, { type: 'saved', seq: 1, draft: { id: 'd1', revision: 1, rev: 1 } })
    .state;
}

/** Saved, sent, and accepted by the engine as `row`. */
function tracked(row: Submission): ComposeState {
  const sent = run(saved(), { type: 'send', now: T0, undoSeconds: 8 });
  return run(sent.state, { type: 'sendAccepted', submission: row }).state;
}

test('the first keystroke saves at once (create); later edits wait for the quiet spell, capped while typing', () => {
  const first = run(fresh(), { type: 'edit', patch: { body: 'H' }, now: T0 });
  assert.equal(first.effects[0]?.type, 'save');
  assert.equal(first.effects[0]?.type === 'save' && first.effects[0].draftId, null);
  const created = run(first.state, {
    type: 'saved',
    seq: 1,
    draft: { id: 'd1', revision: 1, rev: 1 },
  }).state;
  const typing = run(created, { type: 'edit', patch: { body: 'He' }, now: T0 + 100 });
  assert.deepEqual(typing.effects, [], 'not yet');
  const quiet = run(typing.state, { type: 'tick', now: T0 + 100 + AUTOSAVE.quietMs });
  assert.equal(
    quiet.effects[0]?.type === 'save' && quiet.effects[0].baseRevision,
    1,
    'compare-and-set on revision',
  );
  let busy = created;
  for (let t = 0; t <= AUTOSAVE.maxWaitMs + AUTOSAVE.quietMs; t += AUTOSAVE.quietMs / 2)
    busy = run(busy, { type: 'edit', patch: { body: `x${t}` }, now: T0 + 200 + t }).state;
  assert.notEqual(busy.save.flightSeq, null, 'a save left while typing never paused');
});

test('one save at a time; a failure shows "Couldn\'t save" and Retry saves at once', () => {
  const first = run(fresh(), { type: 'edit', patch: { body: 'H' }, now: T0 });
  const more = run(
    first.state,
    { type: 'edit', patch: { body: 'Hi' }, now: T0 + 1 },
    { type: 'tick', now: T0 + 5_000 },
  );
  assert.deepEqual(more.effects, [], 'the create is still in flight');
  const failed = run(more.state, { type: 'saveFailed', seq: 1, now: T0 + 10 });
  assert.equal(failed.state.save.failures, 1);
  const retried = run(failed.state, { type: 'retrySave', now: T0 + 20 });
  assert.equal(retried.effects[0]?.type, 'save');
});

test('Send closes the composer at once, saves unsaved edits first, then sends that exact revision once', () => {
  const dirty = run(saved(), { type: 'edit', patch: { body: 'Hello again' }, now: T0 + 50 }).state;
  const pressed = run(dirty, { type: 'send', now: T0 + 60, undoSeconds: 8 });
  assert.equal(pressed.state.open, false);
  assert.deepEqual(
    pressed.effects.map(e => e.type),
    ['save'],
  );
  const again = run(pressed.state, { type: 'send', now: T0 + 61, undoSeconds: 8 });
  assert.deepEqual(again.effects, [], 'a second Return does nothing');
  const savedNow = run(again.state, {
    type: 'saved',
    seq: 2,
    draft: { id: 'd1', revision: 2, rev: 2 },
  });
  const submit = savedNow.effects[0];
  assert.equal(submit?.type, 'submit');
  assert.equal(submit?.type === 'submit' && submit.revision, 2);
  assert.equal(submit?.type === 'submit' && submit.opId, sendOpId('d1', 2, 2, 0));
});

test('an untouched reply is created on Send; a blocked send outlines To and explains', () => {
  const pressed = run(fresh(), { type: 'send', now: T0, undoSeconds: 8 });
  assert.deepEqual(
    pressed.effects.map(e => e.type),
    ['save'],
  );
  const none = freshCompose(CONTEXT);
  const blocked = run(none, { type: 'send', now: T0, undoSeconds: 8 });
  assert.deepEqual(blocked.state.blocked, { field: 'to', message: 'Add at least one recipient.' });
  assert.equal(blocked.state.open, true);
  assert.deepEqual(blocked.effects, []);
  const bad = run(
    freshCompose(CONTEXT, { ...none.fields, to: [{ id: 'x', address: 'jordan@' }] }),
    {
      type: 'send',
      now: T0,
      undoSeconds: 8,
    },
  );
  assert.match(bad.state.blocked?.message ?? '', /^Check the address jordan@\./);
});

test('Undo pressed before the answer is sent the moment the submission id is known', () => {
  const pressed = run(
    saved(),
    { type: 'send', now: T0, undoSeconds: 8 },
    { type: 'action', action: 'undo' },
  );
  const accepted = run(pressed.state, { type: 'sendAccepted', submission: subRow('queued') });
  assert.deepEqual(accepted.effects, [
    { type: 'submission', action: { type: 'undo', submissionId: 's1' } },
  ]);
  const back = run(accepted.state, {
    type: 'observeSubmission',
    submission: subRow('cancelled', { rev: 2 }),
  });
  assert.equal(back.state.open, true, 'the draft comes back');
  assert.equal(back.state.send.kind, 'none');
  assert.equal(back.state.attempt, 1, 'the next send gets a new idempotency key');
});

const VERBS: readonly [Submission['state'], SendAction, string | null][] = [
  ['queued', 'undo', 'undo'],
  ['queued', 'sendNow', 'sendNow'],
  ['scheduled', 'undo', 'undo'],
  ['scheduled', 'reschedule', 'reschedule'],
  ['uncertain', 'sendAnyway', 'sendAnyway'],
  ['uncertain', 'edit', 'cancel'],
  ['failed', 'retry', 'retry'],
  ['failed', 'edit', 'cancel'],
  ['suspended', 'sendNow', 'sendNow'],
  ['suspended', 'reschedule', 'reschedule'],
  ['suspended', 'edit', 'cancel'],
  ['sending', 'undo', null],
  ['sent', 'undo', null],
  ['failed', 'sendNow', null],
  ['queued', 'retry', null],
];

test('every follow-up verb names the tracked row, and only where the state allows it', () => {
  for (const [state, action, expected] of VERBS) {
    const step = run(tracked(subRow(state)), { type: 'action', action, notBefore: T0 + 3_600_000 });
    const effect = step.effects.find(e => e.type === 'submission');
    const got = effect?.type === 'submission' ? effect.action.type : null;
    assert.equal(got, expected, `${action} on ${state}`);
  }
  const check = run(tracked(subRow('uncertain')), { type: 'action', action: 'checkSent' });
  assert.deepEqual(check.effects, [{ type: 'checkSent' }]);
});

test('frames: an older row never replaces a newer one; sent ends the composer; cancelled after discard stays closed', () => {
  const state = tracked(subRow('queued', { rev: 3 }));
  const stale = run(state, {
    type: 'observeSubmission',
    submission: subRow('sending', { rev: 2 }),
  });
  assert.equal(stale.state.send.kind === 'tracking' && stale.state.send.row?.state, 'queued');
  const sent = run(state, { type: 'observeSubmission', submission: subRow('sent', { rev: 4 }) });
  assert.equal(sent.state.ended, 'sent');
  const discarded = { ...state, ended: 'discarded' as const };
  const cancelled = run(discarded, {
    type: 'observeSubmission',
    submission: subRow('cancelled', { rev: 5 }),
  });
  assert.equal(cancelled.state.open, false);
});

test('refusals: already on its way waits for the row; validation outlines; the daily limit defers', () => {
  const pressed = run(saved(), { type: 'send', now: T0, undoSeconds: 8 }).state;
  const conflict = run(pressed, {
    type: 'sendRefused',
    refusal: { type: 'conflict', message: 'already' },
  });
  assert.equal(conflict.state.send.kind, 'pending');
  const found = run(conflict.state, {
    type: 'observeDraft',
    draft: draftRow({ rev: 2, submissionId: 's9' }),
  });
  assert.deepEqual(found.state.send, { kind: 'tracking', submissionId: 's9', row: null });
  const invalid = run(pressed, {
    type: 'sendRefused',
    refusal: { type: 'validation', message: 'Add at least one recipient.' },
  });
  assert.deepEqual(invalid.state.blocked, { field: 'to', message: 'Add at least one recipient.' });
  assert.equal(invalid.state.open, true);
  const limit = run(pressed, {
    type: 'sendRefused',
    refusal: {
      type: 'paused',
      message: 'limit',
      reasonCode: 'quota.sendLimit',
      resumeAt: T0 + 60_000,
    },
  });
  assert.deepEqual(limit.state.send, {
    kind: 'refused',
    names: ['Jordan Lee'],
    reasonCode: 'quota.sendLimit',
    undoSeconds: 8,
    until: T0 + 60_000,
  });
  const edit = run(limit.state, { type: 'action', action: 'edit' });
  assert.equal(edit.state.open, true);
});

test('a save that fails before the send hands the composer back instead of sending older text', () => {
  const dirty = run(saved(), { type: 'edit', patch: { body: 'Newer' }, now: T0 + 50 }).state;
  const pressed = run(dirty, { type: 'send', now: T0 + 60, undoSeconds: 8 }).state;
  const failed = run(pressed, { type: 'saveFailed', seq: 2, now: T0 + 70 });
  assert.equal(failed.state.open, true);
  assert.equal(failed.state.send.kind, 'none');
  assert.deepEqual(failed.effects, []);
});

test('Esc: dismisses the suggestion, then closes keeping the draft (flushing it); never discards', () => {
  const withSuggestion = run(
    saved(),
    { type: 'edit', patch: { body: '' }, now: T0 + 1 },
    {
      type: 'suggest',
      suggestion: { kind: 'draft', text: 'Sounds good.' },
    },
  ).state;
  const first = run(withSuggestion, { type: 'escape' });
  assert.equal(first.state.suggestion, null);
  assert.equal(first.state.open, true);
  const second = run(first.state, { type: 'escape' });
  assert.equal(second.state.open, false);
  assert.equal(second.state.ended, 'closed');
  assert.ok(second.effects.every(e => e.type !== 'destroy'));
  assert.deepEqual(
    second.effects.map(e => e.type),
    ['save'],
    'unsaved text goes to the engine on close',
  );
});

test('Esc with text the engine refused asks "Discard this draft?" instead of closing', () => {
  const typed = run(
    saved(),
    { type: 'edit', patch: { body: 'Unsaved' }, now: T0 + 1 },
    { type: 'tick', now: T0 + 5_000 },
  );
  const failed = run(typed.state, { type: 'saveFailed', seq: 2, now: T0 + 5_001 }).state;
  const esc = run(failed, { type: 'escape' });
  assert.equal(esc.state.confirm, 'discard');
  assert.equal(esc.state.open, true);
  assert.equal(
    run(esc.state, { type: 'escape' }).state.confirm,
    null,
    'a second Esc cancels the question',
  );
});

test('discard asks first; confirming destroys the draft (after an in-flight create lands); cancel keeps it', () => {
  const asked = run(saved(), { type: 'askDiscard' });
  assert.equal(asked.state.confirm, 'discard');
  assert.deepEqual(asked.effects, []);
  assert.equal(run(asked.state, { type: 'cancelDiscard' }).state.confirm, null);
  const confirmed = run(asked.state, { type: 'confirmDiscard' });
  assert.deepEqual(confirmed.effects, [{ type: 'destroy', draftId: 'd1' }]);
  const creating = run(
    fresh(),
    { type: 'edit', patch: { body: 'x' }, now: T0 },
    { type: 'askDiscard' },
    { type: 'confirmDiscard' },
  );
  assert.ok(
    creating.effects.every(e => e.type !== 'destroy'),
    'no id yet',
  );
  const landed = run(creating.state, {
    type: 'saved',
    seq: 1,
    draft: { id: 'd7', revision: 1, rev: 1 },
  });
  assert.deepEqual(landed.effects, [{ type: 'destroy', draftId: 'd7' }]);
  const blank = run(freshCompose(CONTEXT), { type: 'askDiscard' });
  assert.equal(blank.state.confirm, null, 'nothing to lose: it just closes');
  assert.equal(blank.state.open, false);
  const notice = run(landed.state, { type: 'discarded' });
  assert.deepEqual(notice.effects, [{ type: 'notify', notice: 'discarded' }]);
  const refused = run(landed.state, { type: 'discardFailed' });
  assert.equal(refused.state.open, true, 'a refused discard brings the draft back');
});

test('the dim suggestion: shown only on an empty body, Tab keeps it as text, typing replaces it', () => {
  const s = { type: 'suggest', suggestion: { kind: 'draft', text: 'Thursday works.' } } as const;
  const shown = run(fresh(), s).state;
  assert.equal(shown.suggestion?.text, 'Thursday works.');
  const kept = run(shown, { type: 'keepSuggestion', now: T0 });
  assert.equal(kept.state.fields.body, 'Thursday works.');
  assert.equal(kept.state.suggestion, null);
  assert.equal(kept.effects[0]?.type, 'save', 'kept text is an edit like any other');
  const typed = run(shown, { type: 'edit', patch: { body: 'N' }, now: T0 });
  assert.equal(typed.state.suggestion, null);
  const late = run(typed.state, s);
  assert.equal(late.state.suggestion, null, 'never over text you wrote');
});

test('dictation appends the words heard to the body as an edit', () => {
  const heard = run(saved(), { type: 'dictated', text: 'see you then', now: T0 + 10 });
  assert.equal(heard.state.fields.body, 'Hello see you then');
  assert.equal(heard.state.save.editSeq, 2);
});

test('a reload: a draft with a live send opens closed and tracking; adopting a newer revision from elsewhere', () => {
  const sending = composeFromDraft(draftRow({ submissionId: 's1' }));
  assert.equal(sending.open, false);
  assert.deepEqual(sending.send, { kind: 'tracking', submissionId: 's1', row: null });
  const plain = composeFromDraft(draftRow());
  const newer = run(plain, {
    type: 'observeDraft',
    draft: draftRow({ revision: 3, rev: 5, html: '<p>From the laptop</p>' }),
  });
  assert.equal(newer.state.fields.body, 'From the laptop');
  assert.equal(newer.state.save.revision, 3);
});

test('reopen (R again) brings a closed draft back, never a sent or discarded one', () => {
  const closed = run(saved(), { type: 'escape' }).state;
  assert.equal(run(closed, { type: 'reopen' }).state.open, true);
  assert.equal(run({ ...closed, ended: 'sent' }, { type: 'reopen' }).state.open, false);
  assert.equal(run({ ...closed, ended: 'discarded' }, { type: 'reopen' }).state.open, false);
});

describe_from();

function describe_from(): void {
  const NEW = { accountId: 'a1', mode: 'new' as const };
  const typed = (): ComposeState =>
    run(freshCompose(NEW), { type: 'edit', patch: { body: 'Hello' }, now: T0 }).state;
  const saved = (): ComposeState =>
    run(typed(), { type: 'saved', seq: 1, draft: { id: 'd1', revision: 1, rev: 1 } }).state;

  test('From: before anything is saved, the account just changes', () => {
    const step = composeReducer(freshCompose(NEW), {
      type: 'setAccount',
      accountId: 'a2',
      now: T0,
    });
    assert.equal(step.state.context.accountId, 'a2');
    assert.deepEqual(step.effects, []);
  });

  test('From: a saved draft moves: saved again in the new account first, the old one destroyed only after that', () => {
    const moved = run(saved(), { type: 'setAccount', accountId: 'a2', now: T0 + 10 });
    assert.equal(moved.state.context.accountId, 'a2');
    assert.equal(moved.state.fields.body, 'Hello');
    assert.equal(moved.state.leaving, 'd1');
    assert.equal(
      moved.effects.some(e => e.type === 'destroy'),
      false,
      'nothing is destroyed before the new draft exists',
    );
    const save = moved.effects.find(e => e.type === 'save');
    assert.ok(save && save.type === 'save');
    assert.equal(save.draftId, null, 'a new draft, so the account is the new one');
    assert.equal(save.context.accountId, 'a2');
    const landed = run(moved.state, {
      type: 'saved',
      seq: save.seq,
      draft: { id: 'd2', revision: 1, rev: 1 },
    });
    assert.deepEqual(landed.effects, [{ type: 'destroy', draftId: 'd1', quiet: true }]);
    assert.equal(landed.state.leaving, undefined);
  });

  test('From: if the new account’s save fails, the old draft stays and nothing is destroyed', () => {
    const moved = run(saved(), { type: 'setAccount', accountId: 'a2', now: T0 + 10 });
    const failed = run(moved.state, { type: 'saveFailed', seq: 1, now: T0 + 20 });
    assert.equal(
      failed.effects.some(e => e.type === 'destroy'),
      false,
    );
    assert.equal(failed.state.leaving, 'd1');
  });

  test('From: discarding after a move also removes the draft left in the old account', () => {
    const moved = run(saved(), { type: 'setAccount', accountId: 'a2', now: T0 + 10 });
    const asked = run(
      moved.state,
      { type: 'askDiscard' },
      { type: 'confirmDiscard' },
      { type: 'saved', seq: 1, draft: { id: 'd2', revision: 1, rev: 1 } },
    );
    const gone = asked.effects.filter(e => e.type === 'destroy').map(e => e.draftId);
    assert.deepEqual(gone.sort(), ['d1', 'd2']);
  });

  test('From: choosing the same account does nothing', () => {
    const before = saved();
    const step = composeReducer(before, { type: 'setAccount', accountId: 'a1', now: T0 });
    assert.equal(step.state, before);
    assert.deepEqual(step.effects, []);
  });

  test('From: a reply keeps the thread’s account, and so does a send or a save in flight', () => {
    const reply = fresh();
    assert.equal(canChangeAccount(reply), false);
    const moved = composeReducer(reply, { type: 'setAccount', accountId: 'a2', now: T0 });
    assert.equal(moved.state.context.accountId, 'a1');
    const flying = typed();
    assert.notEqual(flying.save.flightSeq, null);
    assert.equal(canChangeAccount(flying), false);
    const addressed = run(saved(), { type: 'edit', patch: { to: [JORDAN] }, now: T0 + 5 }).state;
    const sending = run(
      run(addressed, { type: 'saved', seq: 2, draft: { id: 'd1', revision: 2, rev: 2 } }).state,
      { type: 'send', now: T0 + 6, undoSeconds: 5 },
    ).state;
    assert.notEqual(sending.send.kind, 'none');
    assert.equal(canChangeAccount(sending), false);
  });

  test('From: each guard alone refuses the move', () => {
    const base = saved();
    const settled = run(base, {
      type: 'saved',
      seq: base.save.editSeq,
      draft: { id: 'd1', revision: 2, rev: 2 },
    }).state;
    assert.equal(canChangeAccount(settled), true, 'a settled new message can change account');
    const refused: Record<string, ComposeState> = {
      closed: { ...settled, open: false },
      discarding: { ...settled, discarding: true },
      forward: { ...settled, context: { ...settled.context, mode: 'forward' } },
      sending: { ...settled, send: { kind: 'pending', alsoDone: false } as ComposeState['send'] },
      waiting: { ...settled, save: { ...settled.save, waitingForRemote: true } },
      flying: { ...settled, save: { ...settled.save, flightSeq: 3 } },
    };
    for (const [name, state] of Object.entries(refused)) {
      assert.equal(canChangeAccount(state), false, name);
      const step = composeReducer(state, { type: 'setAccount', accountId: 'a2', now: T0 });
      assert.equal(step.state.context.accountId, state.context.accountId, name);
    }
  });
}
