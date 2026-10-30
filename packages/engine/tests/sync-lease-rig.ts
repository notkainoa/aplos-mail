import type {
  AdapterContext,
  PlanInput,
  PlannedStep,
  SyncLane,
  SyncState,
  WorkflowChannel,
  WorkflowCopy,
} from '../src/ports';
import type { HostWorkflowChannel } from '../src/sync/host';
import type { ClockOffset, LeaseClaim, LeaseRecord } from '../src/sync/lease';
import { ACCOUNT, FakeAdapter, MINUTE, T0, settle, world, type disk } from './sync-actor-helpers';

/**
 * The lease-wiring tests' rig: a shared "mailbox" of workflow records two devices' fake channels read and write, the
 * timer loop's stand-in, and one-call device worlds. Holds no tests.
 */

/** The "mailbox" two devices' channels share: the merged workflow records, latest write per key. */
export interface Remote {
  records: Map<string, LeaseRecord>;
  gen: number;
}

export const remote = (): Remote => ({ records: new Map(), gen: 0 });

const byKey = (a: LeaseRecord, b: LeaseRecord) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const stampOf = (r: LeaseRecord) => `${r.stamp.at}:${r.stamp.gen}`;
export const claimOf = (remote: Remote, device: string) =>
  remote.records.get(`lease:${device}`)?.value as LeaseClaim | undefined;

/** What a `remoteChannel` saw: reads (and the most in flight at once), writes, and the states reads resumed on. */
export interface ChannelLog {
  reads: number;
  inFlight: number;
  maxInFlight: number;
  writes: number;
  /** Full compactions (a primary's) and own-only ones (a device the clock gate blocks). */
  compacts: number;
  ownCompacts: number;
  /** A compaction is running. */
  compacting: boolean;
  /**
   * Copies each compaction trashes, one governed `enrichment` request (20 units) at a time taking `trashMs` on the
   * wire, as the Gmail transport does; it stops between calls once the context's signal aborts. `trashedAt` lists when
   * each trash went out.
   */
  trashes?: number;
  trashMs?: number;
  trashedAt: number[];
  /** Writes go through the governor (one `enrichment` insert, 25 units, `writeMs` on the wire), as Gmail's do. */
  governed?: boolean;
  writeMs?: number;
  /** Write attempts, failed ones included; the next `failWrites` attempts throw. */
  attempts: number;
  failWrites?: number;
  states: SyncState[];
  /** What each write reports as this device's clock offset (undefined: not measured), when `serverNow` is absent. */
  clockOffsetMs?: number;
  /** The server's clock: each write then reports the writer's clock minus it, as Gmail's receive time shows it. */
  serverNow?: () => number;
  /** A bracket each write reports instead, when set. */
  offset?: ClockOffset;
  /** Called per write, ahead of everything above: its bracket, or undefined (the check failed). */
  nextOffset?: () => ClockOffset | undefined;
  /** Probes of the last copy's receive time (`HostWorkflowChannel.probe`); each reads the bracket as a write does. */
  probes: number;
}

export const channelLog = (): ChannelLog => ({
  reads: 0,
  inFlight: 0,
  maxInFlight: 0,
  writes: 0,
  compacts: 0,
  ownCompacts: 0,
  compacting: false,
  trashedAt: [],
  attempts: 0,
  states: [],
  clockOffsetMs: 0,
  probes: 0,
});

/**
 * A fake `WorkflowStateChannel` over the shared remote, stamped as `device`: `read` is one round (the whole view
 * plus the records this channel last reported as changed), `write` stamps and stores the entries.
 */
export function remoteChannel(
  remote: Remote,
  device: string,
  log: ChannelLog = channelLog(),
): HostWorkflowChannel {
  const seen = new Map<string, string>();
  return {
    async read(state, ctx) {
      log.reads++;
      log.states.push(state);
      log.inFlight++;
      log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
      await settle(2);
      log.inFlight--;
      const records = [...remote.records.values()].sort(byKey);
      const changed = records.filter(r => seen.get(r.key) !== stampOf(r));
      for (const r of records) seen.set(r.key, stampOf(r));
      return {
        records,
        changed,
        nextState: {
          scope: 'workflow',
          cursor: `wf-${ctx.generation}`,
          generation: ctx.generation,
          updatedAt: ctx.clock.now(),
        },
        costUnits: 2,
      };
    },
    async write(entries, ctx) {
      log.attempts++;
      if (log.failWrites) {
        log.failWrites--;
        throw new Error('injected write failure');
      }
      if (log.governed)
        await governed(ctx, 'fake.insert', 25, 'write', signal =>
          wireTime(ctx, log.writeMs, signal),
        );
      log.writes++;
      for (const e of entries) {
        remote.records.set(e.key, {
          key: e.key,
          stamp: { at: ctx.clock.now(), gen: ++remote.gen, device },
          value: e.value,
        });
      }
      const clockOffset = offsetOf(log, ctx);
      return { remoteId: `copy-${remote.gen}`, ...(clockOffset ? { clockOffset } : {}) };
    },
    async compact(ctx, options) {
      if (options?.ownOnly) log.ownCompacts++;
      else log.compacts++;
      log.compacting = true;
      try {
        for (let i = 0; i < (log.trashes ?? 0); i++) {
          ctx.signal.throwIfAborted();
          await governed(ctx, 'fake.trash', 20, 'idempotentWrite', async signal => {
            log.trashedAt.push(ctx.clock.now());
            await wireTime(ctx, log.trashMs, signal);
          });
        }
      } finally {
        log.compacting = false;
      }
      return log.trashes ?? 0;
    },
    async probe(ctx) {
      log.probes++;
      const clockOffset = offsetOf(log, ctx);
      return clockOffset ? { clockOffset } : {};
    },
  };
}

/** What a write reports as the clock bracket (see `ChannelLog`). */
function offsetOf(log: ChannelLog, ctx: AdapterContext): ClockOffset | undefined {
  if (log.nextOffset) return log.nextOffset();
  if (log.offset) return log.offset;
  const point = log.serverNow ? ctx.clock.now() - log.serverNow() : log.clockOffsetMs;
  return point !== undefined ? { lowMs: point, highMs: point } : undefined;
}

/** Time on the wire; none at all for 0 (a zero sleep on the manual fake clock would wait for the next advance). */
async function wireTime(ctx: AdapterContext, ms: number | undefined, signal: AbortSignal) {
  if (ms) await ctx.clock.sleep(ms, signal);
}

/** One governed `enrichment` request on the Gmail budget, with the context's signal (a quit aborts it). */
async function governed(
  ctx: AdapterContext,
  method: string,
  cost: number,
  kind: 'write' | 'idempotentWrite',
  wire: (signal: AbortSignal) => Promise<void> = async () => {},
): Promise<void> {
  await ctx.governor.run(
    { budget: 'gmail', lane: 'enrichment', kind, method, cost, signal: ctx.signal },
    io => wire(io.signal),
  );
}

/** The account's baseline sync is done, as the account row records it (the lease rounds wait for it). */
export function baselineDone(w: ReturnType<typeof world>): void {
  w.store.commit({
    opId: `baseline-${w.clock.now()}`,
    origin: 'system',
    writes: [{ kind: 'account', id: ACCOUNT, baselineDoneAt: T0 }],
  });
}

/**
 * The timer loop's stand-in: moves the shared clock `stepMs` (a second) at a time and fires each world's `lease:`
 * source when its `next()` is due by that world's own clock.
 */
export async function pump(
  w: ReturnType<typeof world> | ReturnType<typeof world>[],
  ms: number,
  stepMs = 1_000,
) {
  const worlds = Array.isArray(w) ? w : [w];
  const clock = worlds[0].clock;
  const end = clock.now() + ms;
  while (clock.now() < end) {
    await clock.advance(stepMs);
    await settle(2);
    for (const v of worlds) {
      const source = v.deadlines.sources.get(`lease:${ACCOUNT}`);
      const next = await source?.next();
      if (source && next !== undefined && next <= v.now()) await source.fire(v.now());
    }
  }
}

/** The `workflow` step as the Gmail adapter plans it: at most once a minute after the committed row. */
export const workflowStep = (input: PlanInput): PlannedStep => {
  const last = input.states.find(s => s.scope === 'workflow')?.updatedAt;
  return step(
    'workflow',
    'enrichment',
    'workflow',
    input.trigger,
    last ? last + MINUTE : undefined,
  );
};

/** One device with a channel on `rem`, its baseline done; the adapter's port round is counted in `rounds`. */
export function channelWorld(
  d: ReturnType<typeof disk>,
  rem: Remote,
  log: ChannelLog,
  rounds: string[],
  options: {
    deviceId?: string;
    clock?: ReturnType<typeof world>['clock'];
    skewMs?: number;
    skew?: () => number;
  } = {},
) {
  const w = world(
    d,
    () => {
      const adapter = new FakeAdapter(input => [workflowStep(input)], {});
      adapter.workflow = portChannel(rounds);
      return adapter;
    },
    {
      ...options,
      host: { workflowChannel: () => remoteChannel(rem, options.deviceId ?? 'device-a', log) },
    },
  );
  baselineDone(w);
  return w;
}

/** The port's `WorkflowChannel` (the adapter's transport); `round` is governed and counts its calls. */
export function portChannel(
  rounds: string[],
  copies: () => WorkflowCopy[] = () => [],
): WorkflowChannel {
  return {
    async round(state, ctx) {
      await ctx.governor.run(
        { budget: 'gmail', lane: 'enrichment', kind: 'read', method: 'fake.workflow', cost: 2 },
        async () => {},
      );
      rounds.push(state.scope);
      return {
        copies: copies(),
        nextState: {
          scope: 'workflow',
          generation: ctx.generation,
          updatedAt: ctx.clock.now(),
        },
        costUnits: 2,
      };
    },
    put: async () => 'copy-1',
    compact: async () => {},
  };
}

export const step = (
  scope: PlannedStep['scope'],
  lane: SyncLane,
  origin: PlannedStep['origin'],
  trigger: PlannedStep['trigger'],
  notBefore?: number,
): PlannedStep => ({
  scope,
  lane,
  origin,
  trigger,
  ...(notBefore !== undefined ? { notBefore } : {}),
});

export const fire = (w: ReturnType<typeof world>, id = `lease:${ACCOUNT}`) =>
  w.deadlines.sources.get(id)!.fire(w.now());

/** Every role the host reported for the account, in order. */
export function roles(w: ReturnType<typeof world>): string[] {
  const seen: string[] = [];
  w.host.subscribe((_account, status) => {
    const role = status.lease?.role;
    if (role && seen.at(-1) !== role) seen.push(role);
  });
  return seen;
}
