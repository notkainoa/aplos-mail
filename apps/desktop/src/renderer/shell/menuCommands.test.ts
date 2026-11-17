import assert from 'node:assert/strict';
import test from 'node:test';
import { listenMenuCommands, type MenuBridge } from './menuCommands';

function bridge() {
  const calls: Array<{ only?: readonly string[] | undefined }> = [];
  let listener: Parameters<MenuBridge['subscribe']>[0] | undefined;
  const api: MenuBridge = {
    subscribe(l, options) {
      calls.push({ only: options?.only });
      listener = l;
      return () => undefined;
    },
  };
  return { api, calls, send: (e: { type: string; payload?: unknown }) => listener?.(e) };
}

test('Edit → Undo Mail Action runs the registry’s undo, once per event', () => {
  const b = bridge();
  const ran: string[] = [];
  listenMenuCommands(b.api, id => void ran.push(id));
  b.send({ type: 'command', payload: 'undo' });
  assert.deepEqual(ran, ['app.undo']);
});

test('it subscribes typed, and ignores other events and unknown or hostile payloads', () => {
  const b = bridge();
  const ran: string[] = [];
  listenMenuCommands(b.api, id => void ran.push(id));
  assert.deepEqual(b.calls, [{ only: ['command'] }]);
  b.send({ type: 'update', payload: 'undo' });
  b.send({ type: 'command', payload: 'toString' });
  b.send({ type: 'command', payload: 7 });
  b.send({ type: 'command' });
  assert.deepEqual(ran, []);
});

test('no bridge is no listener', () => {
  assert.equal(typeof listenMenuCommands(undefined, () => undefined), 'function');
});
