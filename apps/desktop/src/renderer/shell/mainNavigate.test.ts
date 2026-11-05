import assert from 'node:assert/strict';
import test from 'node:test';
import { listenMainNavigate, type NavigateBridge } from './mainNavigate';

function bridge() {
  const calls: Array<{ only?: readonly string[] | undefined }> = [];
  let listener: Parameters<NavigateBridge['subscribe']>[0] | undefined;
  let off = 0;
  const api: NavigateBridge = {
    subscribe(l, options) {
      calls.push({ only: options?.only });
      listener = l;
      return () => void (off += 1);
    },
  };
  return {
    api,
    calls,
    send: (e: { type: string; payload?: unknown }) => listener?.(e),
    off: () => off,
  };
}

test('a navigate to settings.ai opens the Settings AI route, once per event', () => {
  const b = bridge();
  const opened: string[] = [];
  const stop = listenMainNavigate(b.api, route => void opened.push(route));
  b.send({ type: 'navigate', payload: { to: 'settings.ai' } });
  assert.deepEqual(opened, ['settings/ai']);
  stop();
  assert.equal(b.off(), 1);
});

test('it subscribes typed, so it never takes the events held for the app', () => {
  const b = bridge();
  listenMainNavigate(b.api, () => undefined);
  assert.deepEqual(b.calls, [{ only: ['navigate'] }]);
});

test('anything but a known destination is ignored', () => {
  const b = bridge();
  const opened: string[] = [];
  listenMainNavigate(b.api, route => void opened.push(route));
  for (const payload of [
    undefined,
    null,
    {},
    { to: 'inbox' },
    { to: 3 },
    { to: '__proto__' },
    'settings.ai',
  ])
    b.send({ type: 'navigate', payload });
  b.send({ type: 'command', payload: { to: 'settings.ai' } });
  assert.deepEqual(opened, []);
});

test('no bridge (the browser preview) is a no-op', () => {
  assert.doesNotThrow(() => listenMainNavigate(undefined, () => undefined)());
});
