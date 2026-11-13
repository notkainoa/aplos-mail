import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  dismissToast,
  pushToast,
  runToastAction,
  setToastCommandRunner,
  updateToast,
} from './index';
import { getToasts, resetToasts } from './store-toast';
import type { PushedToast } from './index';

beforeEach(() => resetToasts());

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
  pushToast({ ...plain('other'), message: 'Other again' });
  assert.deepEqual(ids(), ['op', 'other']);
  assert.equal(getToasts()[1]?.message, 'Other again');
});

test('a plain push with a live Undo toast id is refused and the Undo stays', () => {
  pushToast(undo('u'));
  pushToast({ ...plain('u'), message: 'Replaced' });
  assert.equal(getToasts()[0]?.message, 'u');
  assert.equal(getToasts()[0]?.undoable, true);
  pushToast({ ...undo('u'), message: 'Moved to Later' });
  assert.equal(getToasts()[0]?.message, 'Moved to Later');
});

test('patching an Undo toast keeps it undoable, even with a patch that drops the Undo action', () => {
  pushToast(undo('u'));
  updateToast('u', { message: 'Saved here', undoable: false, actions: [] });
  assert.equal(getToasts()[0]?.message, 'Saved here');
  assert.equal(getToasts()[0]?.undoable, true);
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

test('the store runs no timers: the Toast component owns the life and dismisses through dismissToast', () => {
  pushToast(plain('p'));
  pushToast(undo('u'));
  assert.deepEqual(ids(), ['p', 'u']);
  dismissToast('p');
  assert.deepEqual(ids(), ['u']);
});

test('the view marks any toast with an app.undo action undoable, so it gets the Undo life', () => {
  pushToast({ ...undo('u'), undoable: false });
  pushToast(plain('p'));
  assert.deepEqual(
    getToasts().map(t => t.undoable),
    [true, false],
  );
});

test('a persistent toast is never evicted: the oldest plain non-persistent one goes instead', () => {
  pushToast({ ...plain('e'), persistent: true });
  pushToast(plain('p1'));
  pushToast(plain('p2'));
  pushToast(plain('p3'));
  assert.deepEqual(ids(), ['e', 'p2', 'p3']);
});

test('with three undo toasts open a persistent newcomer stays, and the stack exceeds the cap', () => {
  pushToast(undo('u1'));
  pushToast(undo('u2'));
  pushToast(undo('u3'));
  pushToast({ ...plain('e'), persistent: true });
  assert.deepEqual(ids(), ['u1', 'u2', 'u3', 'e']);
  pushToast(plain('p'));
  assert.deepEqual(ids(), ['u1', 'u2', 'u3', 'e']);
});

test('runToastAction runs the command through the runner, or onAction, then closes the toast', () => {
  const ran: string[] = [];
  setToastCommandRunner(commandId => {
    ran.push(commandId);
    return { status: 'ran' };
  });
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

test('a command action keeps the toast unless the registry says the command ran', () => {
  for (const status of ['unhandled', 'disabled', 'unknown', 'failed']) {
    setToastCommandRunner(() => ({ status }));
    pushToast(undo('u'));
    runToastAction('u', 'undo');
    assert.deepEqual(ids(), ['u'], status);
  }
  setToastCommandRunner(() => undefined);
  runToastAction('u', 'undo');
  assert.deepEqual(ids(), ['u']);
  setToastCommandRunner(() => ({ status: 'ran' }));
  runToastAction('u', 'undo');
  assert.deepEqual(ids(), []);
});

test('an error toast is never evicted: the oldest plain one goes instead', () => {
  pushToast({ ...plain('e'), kind: 'error' });
  pushToast(plain('a'));
  pushToast(plain('b'));
  pushToast(plain('c'));
  assert.deepEqual(ids(), ['e', 'b', 'c']);
});
