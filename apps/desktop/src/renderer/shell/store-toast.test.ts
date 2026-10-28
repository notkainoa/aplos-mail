import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createManualTimers } from '../data/scheduler';
import {
  dismissToast,
  holdToast,
  pushToast,
  releaseToast,
  runToastAction,
  setToastCommandRunner,
  updateToast,
} from './index';
import { getToasts, resetToasts } from './store-toast';
import type { PushedToast } from './index';

const clock = createManualTimers(0);

beforeEach(() => resetToasts(clock));

const plain = (id: string): PushedToast => ({ id, kind: 'info', message: id, undoable: false });
const undo = (id: string): PushedToast => ({
  id,
  kind: 'done',
  message: id,
  undoable: true,
  actions: [{ id: 'undo', label: 'Undo', commandId: 'app.undo' }],
});
const ids = (): string[] => getToasts().map(t => t.id);

test('push returns the id; newest is last; onAction is stripped from the view', () => {
  const id = pushToast({ ...plain('a'), onAction: () => undefined });
  pushToast(plain('b'));
  assert.equal(id, 'a');
  assert.deepEqual(ids(), ['a', 'b']);
  assert.ok(!('onAction' in (getToasts()[0] ?? {})));
});

test('the fourth toast drops the oldest plain one; undo toasts are never evicted', () => {
  pushToast(undo('u1'));
  pushToast(plain('p1'));
  pushToast(plain('p2'));
  pushToast(plain('p3'));
  assert.deepEqual(ids(), ['u1', 'p2', 'p3']);
  pushToast(undo('u2'));
  assert.deepEqual(ids(), ['u1', 'p3', 'u2']);
});

test('with three undo toasts open, a plain newcomer is the one dropped; more undo toasts all stay', () => {
  pushToast(undo('u1'));
  pushToast(undo('u2'));
  pushToast(undo('u3'));
  pushToast(plain('p1'));
  assert.deepEqual(ids(), ['u1', 'u2', 'u3']);
  pushToast(undo('u4'));
  assert.deepEqual(ids(), ['u1', 'u2', 'u3', 'u4']);
});

test('an action with the undo command makes a toast undo even if undoable is false', () => {
  pushToast({ ...undo('u1'), undoable: false });
  pushToast(plain('p1'));
  pushToast(plain('p2'));
  pushToast(plain('p3'));
  assert.deepEqual(ids(), ['u1', 'p2', 'p3']);
});

test('one operation, one notice: pushing a live id and updateToast change it in place', () => {
  pushToast({ ...plain('op'), kind: 'pending', message: 'Archiving…', persistent: true });
  pushToast(plain('other'));
  updateToast('op', { kind: 'done', message: 'Done', undoable: true, persistent: false });
  assert.deepEqual(ids(), ['op', 'other']);
  assert.equal(getToasts()[0]?.message, 'Done');
  pushToast({ ...plain('op'), message: 'Done again' });
  assert.deepEqual(ids(), ['op', 'other']);
  assert.equal(getToasts()[0]?.message, 'Done again');
});

test('updateToast and dismissToast are no-ops for a closed toast', () => {
  updateToast('gone', { message: 'x' });
  dismissToast('gone');
  assert.deepEqual(ids(), []);
  pushToast(plain('a'));
  dismissToast('a');
  updateToast('a', { message: 'x' });
  assert.deepEqual(ids(), []);
});

test('plain toasts close after 4 s, undo after 8 s, persistent ones stay', () => {
  pushToast(plain('p'));
  pushToast(undo('u'));
  pushToast({ ...plain('e'), persistent: true });
  clock.advance(3_999);
  assert.deepEqual(ids(), ['p', 'u', 'e']);
  clock.advance(1);
  assert.deepEqual(ids(), ['u', 'e']);
  clock.advance(4_000);
  assert.deepEqual(ids(), ['e']);
  clock.advance(60_000);
  assert.deepEqual(ids(), ['e']);
});

test('an update restarts the clock, and a pending toast that confirms becomes a timed undo', () => {
  pushToast({ ...plain('op'), persistent: true });
  clock.advance(20_000);
  updateToast('op', { persistent: false, undoable: true });
  clock.advance(7_999);
  assert.deepEqual(ids(), ['op']);
  clock.advance(1);
  assert.deepEqual(ids(), []);
});

test('hover holds the clock and release resumes with the time left', () => {
  pushToast(plain('p'));
  clock.advance(3_000);
  holdToast('p');
  clock.advance(60_000);
  assert.deepEqual(ids(), ['p']);
  releaseToast('p');
  clock.advance(999);
  assert.deepEqual(ids(), ['p']);
  clock.advance(1);
  assert.deepEqual(ids(), []);
});

test('runToastAction runs the command through the runner, or onAction, then closes the toast', () => {
  const ran: string[] = [];
  setToastCommandRunner(commandId => ran.push(commandId));
  pushToast(undo('u'));
  runToastAction('u', 'undo');
  assert.deepEqual(ran, ['app.undo']);
  assert.deepEqual(ids(), []);
  const chosen: string[] = [];
  pushToast({
    ...plain('c'),
    actions: [{ id: 'retry', label: 'Retry' }],
    onAction: actionId => chosen.push(actionId),
  });
  runToastAction('c', 'retry');
  assert.deepEqual(chosen, ['retry']);
  assert.deepEqual(ids(), []);
  runToastAction('c', 'retry');
  assert.deepEqual(chosen, ['retry']);
});

test('the toast closes even when its action throws', () => {
  pushToast({
    ...plain('t'),
    actions: [{ id: 'x', label: 'X' }],
    onAction: () => {
      throw new Error('boom');
    },
  });
  assert.throws(() => runToastAction('t', 'x'), /boom/);
  assert.deepEqual(ids(), []);
});
