import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAppRegistry } from '../commands';
import type { CommandContext } from '../commands';
import { pushToast, runToastAction, setToastCommandRunner } from './index';
import { getToasts, resetToasts } from './store-toast';
import { toastCommandRunner, toastContext } from './toast-runner';

beforeEach(() => resetToasts());

const undoToast = {
  id: 'u',
  kind: 'done',
  message: 'Archived',
  undoable: true,
  actions: [{ id: 'undo', label: 'Undo', commandId: 'app.undo' }],
} as const;

test('toastContext puts the normalised stack and the target in the context', () => {
  const target = { kind: 'thread', id: 't1', title: 'Drew' } as const;
  const ctx = toastContext(['global', 'list', 'sheet'], target);
  assert.deepEqual(ctx.stack, ['global', 'list', 'sheet']);
  assert.equal(ctx.target, target);
  assert.deepEqual(ctx.selection, []);
});

test('an Undo action reaches the registry through the runner, then the toast closes', () => {
  const ran: Array<[string, CommandContext]> = [];
  const registry = {
    run: (id: string, ctx: CommandContext) => {
      ran.push([id, ctx]);
      return { status: 'ran', done: Promise.resolve() } as never;
    },
  };
  setToastCommandRunner(toastCommandRunner(registry, () => toastContext(['global', 'home'], null)));
  pushToast(undoToast);
  runToastAction('u', 'undo');
  assert.equal(ran.length, 1);
  assert.equal(ran[0]?.[0], 'app.undo');
  assert.deepEqual(ran[0]?.[1].stack, ['global', 'list', 'home']);
  assert.deepEqual(getToasts(), []);
});

test('the real app registry accepts the runner call without throwing', () => {
  const run = toastCommandRunner(createAppRegistry(), () => toastContext(['global'], null));
  assert.doesNotThrow(() => run('app.undo'));
});
