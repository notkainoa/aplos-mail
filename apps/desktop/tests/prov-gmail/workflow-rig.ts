/**
 * Simulated devices for the workflow channel tests: each device is its own `GmailWorkflowTransport` (its own skip
 * list), its own governor stub (so units are counted per device), log and logical clock offset, all on the one
 * emulated account of a `harness.ts` rig. Holds no tests.
 */
import { createHash } from 'node:crypto';
import type { AdapterContext, KeyProvider, SyncState } from '@aplos/engine/ports';
import { GMAIL_COSTS } from '../../src/host/providers/google/costs';
import {
  GmailWorkflowTransport,
  type TransportLimits,
} from '../../src/host/providers/google/workflow';
import { APP_LABEL, buildCopyMessage } from '../../src/host/providers/google/workflow-message';
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
  /** Rewrites the RFC 822 text of every `messages.insert` before Gmail stores it (a copy that lands damaged). */
  mangleInsert?: (raw: string) => string;
  /** Holds every `messages.insert` this long (fake clock) before Gmail receives it: a slow upload. */
  slowInsertMs?: number;
  /** Fails the response of the next `messages.insert` after Gmail applied it (an uncertain write). */
  dropNextInsert?: boolean;
  /** Answers this many raw message downloads with `status` instead of passing them on, after `skip` that pass. */
  failGets?: { status: number; times: number; skip?: number };
  /** Answers the next `history.list` / `messages.insert` with 404 without passing it on. */
  history404?: boolean;
  insert404?: boolean;
  /** The governor's batch size (1 sends every download as its own request). */
  batch?: number;
  limits?: Partial<TransportLimits>;
  maxRecords?: number;
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

const errorReply = (status: number) =>
  new Response(
    JSON.stringify({
      error: {
        code: status,
        message: 'injected',
        errors: [{ reason: status === 404 ? 'notFound' : 'invalid' }],
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );

/** A fault the options inject for this request, consumed as it is used. */
function injected(url: URL, options: DeviceOptions): Response | undefined {
  if (options.history404 && url.pathname.endsWith('/history')) {
    options.history404 = false;
    return errorReply(404);
  }
  if (options.insert404 && url.pathname.endsWith('/messages/insert')) {
    options.insert404 = false;
    return errorReply(404);
  }
  const raw = /\/messages\/[^/]+$/.test(url.pathname) && url.searchParams.get('format') === 'raw';
  if (raw && options.failGets?.skip) {
    options.failGets.skip--;
    return undefined;
  }
  if (raw && options.failGets && options.failGets.times > 0) {
    options.failGets.times--;
    return errorReply(options.failGets.status);
  }
  return undefined;
}

/** The insert request with its message passed through `mangle`. */
function mangled(init: RequestInit | undefined, mangle: (raw: string) => string): RequestInit {
  const body = JSON.parse(String(init?.body)) as { raw: string };
  const raw = mangle(Buffer.from(body.raw, 'base64url').toString('latin1'));
  return {
    ...init,
    body: JSON.stringify({ ...body, raw: Buffer.from(raw, 'latin1').toString('base64url') }),
  };
}

function deviceFetch(r: Rig, options: DeviceOptions): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const fault = injected(url, options);
    if (fault) return fault;
    const insert = url.pathname.endsWith('/messages/insert');
    const sent = insert && options.mangleInsert ? mangled(init, options.mangleInsert) : init;
    if (insert && options.slowInsertMs) await r.clock.sleep(options.slowInsertMs);
    const response = await r.emu.fetch(input, sent);
    if (insert && options.dropNextInsert) {
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
  const governor = new StubGovernor(r.clock, r.tokens, 3_000, options.batch ?? 10);
  const log = new CaptureLog();
  const transport = new GmailWorkflowTransport(
    {
      fetch: deviceFetch(r, options),
      costs: GMAIL_COSTS,
      userAgent: 'AplosMail-test (gzip)',
      closed: new AbortController().signal,
    },
    r.account.address,
    options.limits,
  );
  const keys = keysOf(options.keySeed ?? 'shared');
  const channel = createWorkflowStateChannel({
    transport,
    keys,
    device: id,
    address: r.account.address,
    ...(options.maxRecords ? { maxRecords: options.maxRecords } : {}),
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
  const address = options.address ?? r.account.address;
  const data = seal(payload, channelKey(testKey(options.keySeed ?? 'shared'), address), address);
  const raw = buildCopyMessage(
    { deviceId: payload.device, writtenAt: payload.writtenAt, data },
    r.account.address,
  );
  return { raw, data };
}
