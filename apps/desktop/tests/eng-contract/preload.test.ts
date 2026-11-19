import { desktopFailure } from '../../src/shared/desktop-error';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { EngineSession } from '@aplos/contract/client';
import {
  ENGINE_PORT_ARG,
  engineWindowArguments,
  exposeEngineBridge,
  serveWindowPort,
  type PreloadElectron,
} from '../../src/host/transports/port';
import { engineEndOf, until } from './rig';

type Listener = Parameters<PreloadElectron['ipcRenderer']['on']>[1];
type EngineBridge = {
  call(method: unknown, args?: unknown, transfer?: unknown): Promise<unknown>;
  subscribe(listener: (frame: unknown) => void): () => void;
  position(): { dbEpoch?: string; seq?: number };
};

const echo: EngineSession = {
  call: async (method, args) => ({ method, args }),
  subscribe: () => () => undefined,
  close: () => undefined,
};

/** Electron's preload half in memory; `aplos:engine-connect` serves a real Node port and delivers its other end. */
function fakeElectron(t: test.TestContext) {
  const exposed = new Map<string, unknown>();
  const listeners = new Map<string, Listener>();
  const invoked: unknown[][] = [];
  const open: MessagePort[] = [];
  t.after(() => open.forEach(port => port.close()));
  const electron: PreloadElectron = {
    contextBridge: { exposeInMainWorld: (key, api) => void exposed.set(key, api) },
    ipcRenderer: {
      invoke: async (channel, ...args) => {
        invoked.push([channel, ...args]);
        if (channel !== 'aplos:engine-connect') return { ok: true };
        const { port1, port2 } = new MessageChannel();
        open.push(port1, port2);
        serveWindowPort(() => echo, engineEndOf(port1), {
          position: () => ({ dbEpoch: 'e1', seq: 1 }),
        });
        listeners.get('aplos:engine-port')?.({ ports: [port2] });
        return { ok: true };
      },
      on: (channel, listener) => void listeners.set(channel, listener),
    },
  };
  return { electron, exposed, listeners, invoked };
}

test('LOW-1: without the engine argument preload exposes nothing and listens on no engine channel', t => {
  const fake = fakeElectron(t);
  assert.equal(exposeEngineBridge(fake.electron, ['electron', '--type=renderer']), false);
  assert.deepEqual([...fake.exposed.keys()], []);
  assert.deepEqual([...fake.listeners.keys()], []);
  assert.deepEqual(fake.invoked, []);
});

test('LOW-1: with the engine argument the bridge works over its port', async t => {
  const fake = fakeElectron(t);
  assert.equal(exposeEngineBridge(fake.electron, ['electron', ENGINE_PORT_ARG]), true);
  assert.deepEqual([...fake.exposed.keys()], ['aplosEngine']);
  assert.deepEqual([...fake.listeners.keys()].sort(), ['aplos:desktop', 'aplos:engine-port']);
  const bridge = fake.exposed.get('aplosEngine') as EngineBridge;
  assert.deepEqual(Object.keys(bridge).sort(), ['call', 'position', 'subscribe']);
  const frames: unknown[] = [];
  bridge.subscribe(frame => frames.push(frame));
  assert.deepEqual(await bridge.call('Counts/get', {}), { method: 'Counts/get', args: {} });
  assert.equal(bridge.position().dbEpoch, 'e1');
  // A desktop method goes to main, never down the port; a desktop frame from main reaches the page.
  await bridge.call('Window/compose', { draftId: 'd1' });
  assert.deepEqual(fake.invoked.at(-1), ['aplos:desktop', 'Window/compose', { draftId: 'd1' }]);
  const frame = { frame: 'desktop', event: { type: 'engine', state: 'ready', at: 1 } };
  fake.listeners.get('aplos:desktop')?.({ ports: [] }, frame);
  await until(() => frames.length === 1, 'the desktop frame');
  assert.deepEqual(frames, [frame]);
  assert.equal(
    fake.invoked.filter(([channel]) => channel === 'aplos:engine-connect').length,
    1,
    'one port asked for',
  );
});

test('LOW-1: main passes the argument only on the real path, and preload never exposes the bridge itself', () => {
  assert.deepEqual(engineWindowArguments(false), []);
  assert.deepEqual(engineWindowArguments(true), [ENGINE_PORT_ARG]);
  const source = readFileSync(join(import.meta.dirname, '../../src/main/preload.ts'), 'utf8');
  assert.equal(source.match(/aplosEngine|aplos:engine-port|aplos:desktop/g), null);
  assert.match(source, /exposeEngineBridge\(\{ contextBridge, ipcRenderer \}, process\.argv\)/);
  const windows = readFileSync(join(import.meta.dirname, '../../src/main/windows.ts'), 'utf8');
  assert.match(windows, /additionalArguments: engineWindowArguments\(realPath\)/);
});

test('a failed desktop method rejects with the plain error body; a result passes; a refused caller gets no reason', async t => {
  const fake = fakeElectron(t);
  const answers: unknown[] = [
    desktopFailure(new Error('Save this draft before opening a separate window.')),
    { canceled: false, path: '/tmp/x' },
    'refused',
  ];
  const original = fake.electron.ipcRenderer.invoke;
  fake.electron.ipcRenderer.invoke = async (channel, ...args) => {
    if (channel !== 'aplos:desktop') return original(channel, ...args);
    const answer = answers.shift();
    if (answer === 'refused')
      throw new Error("Error invoking remote method 'aplos:desktop': Error: Untrusted");
    return answer;
  };
  exposeEngineBridge(fake.electron, ['electron', ENGINE_PORT_ARG]);
  const bridge = fake.exposed.get('aplosEngine') as EngineBridge;
  await assert.rejects(bridge.call('Window/compose', { draftId: 'd1' }), {
    type: 'unavailable',
    message: 'Save this draft before opening a separate window.',
  });
  assert.deepEqual(await bridge.call('File/save', { blobId: 'b', name: 'a.txt' }), {
    canceled: false,
    path: '/tmp/x',
  });
  await assert.rejects(bridge.call('Shell/open', { url: 'https://x.example' }), {
    type: 'unavailable',
    message: 'That did not work. Try again.',
  });
});
