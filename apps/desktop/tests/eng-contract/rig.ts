/**
 * Fakes for the contract-4 tests: real MessagePorts (Node's `MessageChannel`, the same structured clone and transfer
 * rules as Electron's), an in-process "utility process" that runs `runEngineUtility` over the real composed engine, and
 * windows that hold a preload-side `createPortClient`. No Electron starts.
 */
import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { Frame } from '@aplos/contract';
import { fakeClock, type FakeClock } from '../../../../packages/engine/src/clock/fake';
import { composeEngineHost, type ComposedHost, type ComposeOptions } from '../../src/host/compose';
import { createProcessState } from '../../src/host/lifecycle';
import type { GoogleTokenBundle } from '../../src/host/providers/oauth/token-source';
import {
  createEngineLink,
  createEngineSupervisor,
  createPortBroker,
  createPortClient,
  type DesktopFrame,
  type EngineLink,
  type EnginePortEnd,
  type PortWindow,
  type Timers,
  type UtilityChild,
  type UtilityRequest,
  type WindowPortEnd,
} from '../../src/host/transports/port';
import { runEngineUtility, type HostBridge } from '../../src/main/engine-utility';

export const T0 = Date.UTC(2026, 9, 31, 9, 0, 0);

/** The engine's end of a Node port, as the utility process wraps Electron's `MessagePortMain`. */
export function engineEndOf(port: MessagePort): EnginePortEnd {
  return {
    post: (message, transfer) => port.postMessage(message, transfer),
    onMessage: handler => void port.on('message', handler),
    onClose: handler => void port.on('close', handler),
    close: () => port.close(),
  };
}

/** The window's end of a Node port, as preload wraps the DOM `MessagePort` it receives. */
export function windowEndOf(port: MessagePort): WindowPortEnd {
  return {
    post: (message, transfer) => port.postMessage(message, transfer),
    onMessage: handler => void port.on('message', handler),
    onClose: handler => void port.on('close', handler),
    close: () => port.close(),
  };
}

/** Every Node port a test opened, closed at the end so the test process can exit. */
export function portTracker(t: TestContext) {
  const open: MessagePort[] = [];
  t.after(() => {
    for (const port of open) port.close();
  });
  return {
    channel() {
      const { port1, port2 } = new MessageChannel();
      open.push(port1, port2);
      return { engineEnd: port1 as unknown, windowEnd: port2 as unknown };
    },
  };
}

/** A window as the broker sees it, with a preload-side client attached to whatever port it was handed. */
export function fakeWindow(id: number) {
  const client = createPortClient();
  const frames: (Frame | DesktopFrame)[] = [];
  client.subscribe(frame => frames.push(frame));
  const state = { destroyed: false, url: 'file:///app/renderer/index.html', deliveries: 0 };
  const win: PortWindow = {
    id,
    isDestroyed: () => state.destroyed,
    trusted: () => state.url === 'file:///app/renderer/index.html',
    deliver: port => {
      state.deliveries++;
      client.attach(windowEndOf(port as MessagePort));
    },
    desktop: frame => client.desktop(frame),
  };
  return { win, client, frames, state };
}

/** A token vault in memory (production uses the keychain-sealed file vault). */
export function memoryVault() {
  const entries = new Map<string, GoogleTokenBundle>();
  return {
    get: (ref: string) => entries.get(ref),
    set: async (ref: string, value: GoogleTokenBundle) => void entries.set(ref, value),
    delete: async (ref: string) => void entries.delete(ref),
  };
}

/** A fresh data folder, removed after the test. */
export function dataDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-contract4-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Compose options with no network, a fake clock and an in-memory vault; banners and links go through the bridge. */
export function testOptions(dir: string, clock: FakeClock, ports?: ComposeOptions['ports']) {
  return async (_init: unknown, bridge: HostBridge): Promise<ComposeOptions> => ({
    dataDir: dir,
    fetch: async () => {
      throw new Error('no network in this test');
    },
    clock,
    logSink: { write: () => undefined },
    deviceId: 'mac-contract4',
    power: bridge.power,
    vault: memoryVault(),
    openExternal: async url => void (await bridge.request({ op: 'openExternal', url })),
    googleClient: () => ({ env: {}, bundled: {} }),
    postNotification: async item =>
      (await bridge.request({ op: 'notify', item })) === 'posted' ? 'posted' : 'dropped',
    ...(ports ? { ports } : {}),
  });
}

/** Runs after the current turn, as a message between processes would. */
const later = (run: () => void) => void setImmediate(run);

/**
 * One engine "process": `runEngineUtility` over the real composed engine, behind a `UtilityChild` for main's
 * `createEngineLink`. `crash()` stops it the way a killed process does (no quit, every engine port end goes away);
 * the composed host is closed only to release the database file, as the OS would.
 */
export function inProcessUtility(options: {
  dir: string;
  clock: FakeClock;
  hosts?: ComposedHost[];
  /** Extra host ports the compose injects (`send`, `html`, ...), as `ComposeOptions.ports`. */
  ports?: ComposeOptions['ports'];
}) {
  const toMain: ((message: unknown) => void)[] = [];
  const exits: ((code: number) => void)[] = [];
  const ends: MessagePort[] = [];
  let toUtility: ((data: unknown, ports: readonly unknown[]) => void) | undefined;
  let host: ComposedHost | undefined;
  let dead = false;
  const exit = (code: number) => {
    if (dead) return;
    dead = true;
    for (const port of ends) port.close();
    later(() => exits.forEach(handler => handler(code)));
  };
  runEngineUtility(
    {
      post: message => {
        const copy = structuredClone(message);
        later(() => !dead && toMain.forEach(handler => handler(copy)));
      },
      onMessage: handler => {
        toUtility = handler;
      },
    },
    {
      options: testOptions(options.dir, options.clock, options.ports),
      compose: async compose => {
        host = await composeEngineHost(compose);
        options.hosts?.push(host);
        return host;
      },
      wrapPort: raw => {
        ends.push(raw as MessagePort);
        return engineEndOf(raw as MessagePort);
      },
      exit,
    },
  );
  const child: UtilityChild = {
    post: (message, ports = []) => {
      const copy = structuredClone(message);
      later(() => !dead && toUtility?.(copy, ports));
    },
    onMessage: handler => void toMain.push(handler),
    onExit: handler => void exits.push(handler),
    kill: () => void crash(),
  };
  async function crash() {
    if (dead) return;
    dead = true;
    for (const port of ends) port.close();
    await host?.close();
    exits.forEach(handler => handler(137));
  }
  return { child, crash, host: () => host, isDead: () => dead };
}

export { fakeClock };

const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

/** Main's side over in-process engine "processes" on one data folder: supervisor, broker, link, host-channel log. */
export function mainSide(t: TestContext, options: { now?: () => number } = {}) {
  const dir = dataDir(t);
  const clock = fakeClock(T0);
  const hosts: ComposedHost[] = [];
  const utilities: ReturnType<typeof inProcessUtility>[] = [];
  const requests: UtilityRequest[] = [];
  const desktop: DesktopFrame[] = [];
  const hostEvents: unknown[] = [];
  const ups: boolean[] = [];
  const processState = createProcessState();
  const ports = portTracker(t);
  // The broker reads the supervisor's current engine, and the supervisor's hooks use the broker.
  const box: { supervisor?: ReturnType<typeof createEngineSupervisor> } = {};
  const broker = createPortBroker({
    channel: ports.channel,
    link: () => box.supervisor?.current(),
  });
  const supervisor = createEngineSupervisor({
    spawn: (): EngineLink => {
      const utility = inProcessUtility({ dir, clock, hosts });
      utilities.push(utility);
      return createEngineLink(
        utility.child,
        { dataDir: dir, appVersion: '0.3.0-test' },
        {
          hostEvent: event => hostEvents.push(event),
          request: async request => (requests.push(request), 'posted'),
        },
        realTimers,
      );
    },
    noteExit: () => processState.noteEngineExit((options.now ?? Date.now)()),
    onUp: (_link, restarted) => {
      ups.push(restarted);
      if (restarted) broker.reissue();
    },
    onDown: parked => {
      const frame: DesktopFrame = {
        frame: 'desktop',
        event: { type: 'engine', state: parked ? 'parked' : 'connecting', at: Date.now() },
      };
      desktop.push(frame);
      broker.desktop(frame);
    },
    timers: realTimers,
    restartDelayMs: 10,
  });
  box.supervisor = supervisor;
  t.after(() => supervisor.close());
  return {
    dir,
    clock,
    hosts,
    utilities,
    requests,
    desktop,
    hostEvents,
    ups,
    broker,
    supervisor,
    processState,
  };
}

/** Waits until `done` holds, letting messages and timers run; fails after `ms` of real time. */
export async function until(done: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
