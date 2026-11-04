/**
 * The send-state table (DESIGN 7.6, 7.13, 7.15; plan 30 4.5 row 4): every phase, the sentence it shows and the verbs it
 * offers, as pure functions of the intent, the engine's row, the clock and the connection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Submission } from '../../../data';
import {
  phaseOf,
  rowPhase,
  sendOwnsDraft,
  sendView,
  type SendIntent,
  type SendPhase,
} from './sendState';

const T0 = Date.UTC(2026, 9, 27, 16, 0, 0);

function row(state: Submission['state'], extra: Partial<Submission> = {}): Submission {
  return {
    id: 'sub-1',
    rev: 1,
    draftId: 'd1',
    accountId: 'a1',
    internetId: '<sub-1@example.test>',
    revision: 2,
    state,
    queuedAt: T0,
    notBefore: T0 + 8_000,
    toNames: ['Jordan Lee'],
    subject: 'Re: plans',
    ...extra,
  };
}

const at = (ms: number) => `t+${ms}`;
const view = (phase: SendPhase) => sendView(phase, ms => at(ms - T0));
const tracking = (submission: Submission): SendIntent => ({
  kind: 'tracking',
  submissionId: submission.id,
  row: submission,
});

test('idle and cancelled show nothing and leave the composer to own the draft', () => {
  for (const phase of [phaseOf({ kind: 'none' }, T0, true), rowPhase(row('cancelled'), T0, true)]) {
    assert.deepEqual(view(phase), { tray: null, failure: null, notice: null, actions: [] });
    assert.equal(sendOwnsDraft(phase), false);
  }
});

test('submitting: before the engine answers, the tray already counts down the undo window', () => {
  const intent: SendIntent = {
    kind: 'pending',
    pressedAt: T0,
    undoSeconds: 8,
    names: ['Jordan Lee'],
    alsoDone: false,
    undoAsked: false,
    sendNowAsked: false,
  };
  const phase = phaseOf(intent, T0 + 500, true);
  assert.equal(phase.kind, 'submitting');
  assert.deepEqual(view(phase).tray, {
    kind: 'sending',
    recipients: 'Jordan',
    secondsLeft: 7.5,
    totalSeconds: 8,
  });
  assert.deepEqual(view(phase).actions, ['undo', 'sendNow']);
  assert.equal(
    phaseOf({ ...intent, undoSeconds: 0 }, T0, true).kind,
    'sending',
    'no window, no tray',
  );
});

test('held: "Sending to Jordan in 8 s · Undo Z · Send now", the drain spanning queuedAt to notBefore', () => {
  const phase = rowPhase(row('queued'), T0 + 2_000, true);
  assert.equal(phase.kind, 'held');
  const v = view(phase);
  assert.deepEqual(v.tray, {
    kind: 'sending',
    recipients: 'Jordan',
    secondsLeft: 6,
    totalSeconds: 8,
  });
  assert.deepEqual(v.actions, ['undo', 'sendNow']);
  const two = rowPhase(row('queued', { toNames: ['Jordan Lee', 'Mina Cho'] }), T0, true);
  const tray = view(two).tray;
  assert.equal(tray?.kind === 'sending' ? tray.recipients : null, 'Jordan and Mina');
});

test('scheduled: one notice "Scheduled for …" with Undo, no tray', () => {
  const phase = rowPhase(row('scheduled', { notBefore: T0 + 3_600_000 }), T0, true);
  assert.equal(phase.kind, 'scheduled');
  const v = view(phase);
  assert.equal(v.tray, null);
  assert.deepEqual(v.notice, {
    kind: 'scheduled',
    message: 'Scheduled for t+3600000',
    actions: ['undo'],
  });
});

test('sending and sent show nothing (the message arrives in its thread); offline says "Saved here · will sync"', () => {
  assert.equal(rowPhase(row('sending'), T0, true).kind, 'sending');
  assert.equal(
    rowPhase(row('queued'), T0 + 9_000, true).kind,
    'sending',
    'past the window, about to go',
  );
  assert.deepEqual(view(rowPhase(row('sent'), T0, true)), {
    tray: null,
    failure: null,
    notice: null,
    actions: [],
  });
  const offline = rowPhase(row('queued'), T0 + 9_000, false);
  assert.equal(offline.kind, 'offline');
  assert.deepEqual(view(offline).notice, {
    kind: 'offline',
    message: 'Saved here · will sync',
    actions: [],
  });
});

test('failed: the send-failed line for Jordan with Try again and Edit; with `until` it is the deferred tray', () => {
  const failed = rowPhase(row('failed', { problem: { reasonCode: 'net.offline' } }), T0, true);
  assert.deepEqual(failed, { kind: 'failed', names: ['Jordan Lee'], reasonCode: 'net.offline' });
  assert.deepEqual(view(failed).failure, { recipient: 'Jordan' });
  assert.deepEqual(view(failed).actions, ['retry', 'edit']);
  const until = T0 + 600_000;
  const deferred = rowPhase(
    row('failed', { problem: { reasonCode: 'quota.sendLimit', until } }),
    T0,
    true,
  );
  assert.equal(deferred.kind, 'deferred');
  assert.equal(view(deferred).tray?.kind, 'deferred');
  assert.deepEqual(view(deferred).actions, []);
  assert.equal(
    rowPhase(row('failed', { problem: { reasonCode: 'x', until } }), until + 1, true).kind,
    'failed',
  );
});

test('uncertain offers Check Sent and Send anyway; suspended offers Send now and Reschedule', () => {
  const uncertain = view(rowPhase(row('uncertain'), T0, true));
  assert.deepEqual(uncertain.tray, { kind: 'uncertain' });
  assert.deepEqual(uncertain.actions, ['checkSent', 'sendAnyway']);
  const suspended = view(rowPhase(row('suspended'), T0, true));
  assert.deepEqual(suspended.tray, { kind: 'suspended' });
  assert.deepEqual(suspended.actions, ['sendNow', 'reschedule']);
});

test('a refusal before any row: the daily limit is deferred until it lifts, anything else is the send-failed line', () => {
  const limit: SendIntent = {
    kind: 'refused',
    names: ['Jordan'],
    reasonCode: 'quota.sendLimit',
    until: T0 + 60_000,
  };
  assert.equal(phaseOf(limit, T0, true).kind, 'deferred');
  const other: SendIntent = { kind: 'refused', names: ['Jordan'], reasonCode: 'unavailable' };
  assert.equal(phaseOf(other, T0, true).kind, 'failed');
});

test('tracking with no row yet reads as sending, never as idle', () => {
  assert.equal(
    phaseOf({ kind: 'tracking', submissionId: 'sub-1', row: null }, T0, true).kind,
    'sending',
  );
  assert.equal(phaseOf(tracking(row('queued')), T0, true).kind, 'held');
});
