/**
 * Simulated devices for the workflow channel tests: each device is its own `GmailWorkflowTransport` (its own skip
 * list), its own governor stub (so units are counted per device), log and logical clock offset, all on the one
 * emulated account of a `harness.ts` rig. Holds no tests.
 */
import { createHash } from 'node:crypto';
import type { AdapterContext, KeyProvider, SyncState } from '@aplos/engine/ports';
import { GMAIL_COSTS } from '../../src/host/providers/google/costs';
import {
  APP_LABEL,
  buildCopyMessage,
  GmailWorkflowTransport,
} from '../../src/host/providers/google/workflow';
import type { WorkflowPayload } from '../../src/host/providers/google/workflow-merge';
import { channelKey, seal } from '../../src/host/providers/google/workflow-seal';
import {
  createWorkflowStateChannel,
  type WorkflowRead,
  type WorkflowStateChannel,
} from '../../src/host/providers/google/workflow-state';
import { CaptureLog, StubGovernor, type Rig } from './harness';

/** A deterministic 32-byte data key; tests never use real key material. */
export const testKey = (seed: string): Uint8Array =>
  createHash('sha256').update(`aplos-test-key:${seed}`).digest();

export function keysOf(seed: string): KeyProvider & { off: boolean } {
  const provider = {
    off: false,
    async dataKey() {
      return provider.off
        ? ({ kind: 'unavailable', reason: 'locked' } as const)
        : ({ kind: 'key', key: testKey(seed) } as const);
    },
  };
  return provider;
}

export interface DeviceOptions {
  keySeed?: string;
  /** Wall-clock offset of this device, ms. */
  skewMs?: number;
  /** Reverse every `messages.list` page, so this device downloads copies in the opposite order. */
  reverseLists?: boolean;
  /** Fails the response of the next `messages.insert` after Gmail applied it (an uncertain write). */
  dropNextInsert?: boolean;
}

export interface Device {
  id: string;
  transport: GmailWorkflowTransport;
  governor: StubGovernor;
  log: CaptureLog;
  keys: KeyProvider & { off: boolean };
  channel: WorkflowStateChannel;
  syncState: SyncState;
  options: DeviceOptions;
  ctx(): AdapterContext;
  /** One workflow round, committing its state the way the actor does. */
  round(): Promise<WorkflowRead>;
  /** Units this device's sent calls cost since `since` (an index into `governor.calls`). */
  units(since?: number): number;
  methods(since?: number): string[];
}

function reversedList(text: string): string {
  const json = JSON.parse(text) as { messages?: unknown[] };
  if (Array.isArray(json.messages)) json.messages.reverse();
  return JSON.stringify(json);
}

function deviceFetch(r: Rig, options: DeviceOptions): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const response = await r.emu.fetch(input, init);
    if (url.pathname.endsWith('/messages/insert') && options.dropNextInsert) {
      options.dropNextInsert = false;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }
    const isList = (init?.method ?? 'GET') === 'GET' && url.pathname.endsWith('/messages');
    if (!options.reverseLists || !isList || !response.ok) return response;
    return new Response(reversedList(await response.text()), {
      status: response.status,
      headers: response.headers,
    });
  };
}

export function device(r: Rig, id: string, options: DeviceOptions = {}): Device {
  const governor = new StubGovernor(r.clock, r.tokens);
  const log = new CaptureLog();
  const transport = new GmailWorkflowTransport(
    {
      fetch: deviceFetch(r, options),
      costs: GMAIL_COSTS,
      userAgent: 'AplosMail-test (gzip)',
      closed: new AbortController().signal,
    },
    r.account.address,
  );
  const keys = keysOf(options.keySeed ?? 'shared');
  const channel = createWorkflowStateChannel({
    transport,
    keys,
    device: id,
    address: r.account.address,
  });
  const ctx = (): AdapterContext => ({
    ...r.ctx(),
    governor,
    log: log.with({ account: r.account.id }),
    clock: {
      now: () => r.clock.now() + (options.skewMs ?? 0),
      sleep: (ms, s) => r.clock.sleep(ms, s),
      timer: () => ({ cancel() {} }),
    },
  });
  const sent = (since: number) => governor.calls.slice(since).filter(c => c.outcome === 'sent');
  const d: Device = {
    id,
    transport,
    governor,
    log,
    keys,
    channel,
    options,
    syncState: { scope: 'workflow', generation: 0, updatedAt: 0 },
    ctx,
    async round() {
      const read = await channel.read(d.syncState, ctx());
      d.syncState = read.nextState;
      return read;
    },
    units: (since = 0) => sent(since).reduce((sum, c) => sum + c.cost, 0),
    methods: (since = 0) => sent(since).map(c => c.method),
  };
  return d;
}

/** The app label's id in the emulated mailbox, created hidden when missing (as another device would). */
export function appLabel(r: Rig): string {
  const mailbox = r.emu.mailbox;
  const found = mailbox
    .listLabels()
    .find(l => l.type === 'user' && l.name.toLowerCase() === APP_LABEL.toLowerCase());
  if (found) return found.id;
  return mailbox.createLabel(APP_LABEL, {
    labelListVisibility: 'labelHide',
    messageListVisibility: 'hide',
  }).id;
}

/** Plants a raw message under the app label directly in the mailbox (a copy written elsewhere, or user mail). */
export function plant(r: Rig, raw: string): string {
  return r.emu.mailbox.addRaw(Buffer.from(raw), { labelIds: [appLabel(r)] }).id;
}

/** Seals `payload` with `keySeed` for `address` and wraps it as a copy message. */
export function sealedCopy(
  r: Rig,
  payload: WorkflowPayload,
  options: { keySeed?: string; address?: string } = {},
): { raw: string; data: string } {
  const data = seal(
    payload,
    channelKey(testKey(options.keySeed ?? 'shared')),
    options.address ?? r.account.address,
  );
  const raw = buildCopyMessage(
    { deviceId: payload.device, writtenAt: payload.writtenAt, data },
    r.account.address,
  );
  return { raw, data };
}
