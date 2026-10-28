import { createHash } from 'node:crypto';
import type {
  AdapterContext,
  DeviceId,
  KeyProvider,
  Logger,
  SyncState,
  WorkflowChannel,
  WorkflowCopy,
} from '@aplos/engine/ports';
import { logSkipped } from './workflow';
import {
  dominated,
  highWater,
  isDeviceId,
  mergeInto,
  nextStamp,
  parsePayload,
  type JsonValue,
  type Stamp,
  type WorkflowPayload,
  type WorkflowRecord,
} from './workflow-merge';
import { channelKey, open, seal, type ChannelKey } from './workflow-seal';

/**
 * `WorkflowStateChannel`: the workflow channel as the engine side sees it (API in `workflow.ts`'s header). It opens the
 * transport's sealed copies with the data key, merges them into one view per process, and publishes this device's
 * records as a new sealed copy of the whole view. A copy that is not an Aplos copy, was sealed under another key or for
 * another account, is damaged or does not validate is skipped and logged by reason only; it never stops the round and
 * is never compacted away. When the data key is unavailable, copies are held and opened on a later call.
 */

export interface WorkflowEntry {
  key: string;
  value: JsonValue;
}

export interface WorkflowIngest {
  /** Keys whose winner changed, with the new winner, sorted by key. */
  changed: WorkflowRecord[];
  /** Copies that were not usable this call (logged). */
  skipped: number;
  /** Copies held because the data key is unavailable. */
  waiting: number;
}

export interface WorkflowRead extends WorkflowIngest {
  /** The whole merged view, sorted by key: the lease module's input. */
  records: WorkflowRecord[];
  nextState: SyncState;
  costUnits: number;
}

export interface WorkflowWritten {
  remoteId: string;
  /** The records this write stamped. */
  records: WorkflowRecord[];
}

export interface WorkflowStateChannel {
  read(state: SyncState, ctx: AdapterContext): Promise<WorkflowRead>;
  ingest(copies: readonly WorkflowCopy[], log: Logger): Promise<WorkflowIngest>;
  write(entries: readonly WorkflowEntry[], ctx: AdapterContext): Promise<WorkflowWritten>;
  compact(ctx: AdapterContext): Promise<number>;
  view(): WorkflowRecord[];
}

export interface WorkflowStateOptions {
  transport: WorkflowChannel;
  keys: KeyProvider;
  device: DeviceId;
  /** The account's address: sealed copies are bound to it. */
  address: string;
}

const ZERO: Stamp = { at: 0, gen: 0, device: '' };
const byKey = (a: WorkflowRecord, b: WorkflowRecord) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/** A stable id for a copy with no remote id yet (never the case from Gmail, but the port allows it). */
const copyId = (copy: WorkflowCopy) =>
  copy.remoteId ?? `sealed:${createHash('sha256').update(copy.data).digest('base64url')}`;

export function createWorkflowStateChannel(options: WorkflowStateOptions): WorkflowStateChannel {
  if (!isDeviceId(options.device)) throw new Error('The workflow channel needs a valid device id');
  return new StateChannel(options);
}

class StateChannel implements WorkflowStateChannel {
  private readonly merged = new Map<string, WorkflowRecord>();
  /** Opened copies by remote id: their records, for compaction. */
  private readonly opened = new Map<string, WorkflowRecord[]>();
  private readonly rejected = new Set<string>();
  private readonly waiting = new Map<string, WorkflowCopy>();
  private high: Stamp = ZERO;
  private published?: { remoteId: string; view: Map<string, WorkflowRecord> };

  constructor(private readonly options: WorkflowStateOptions) {}

  view(): WorkflowRecord[] {
    return [...this.merged.values()].sort(byKey);
  }

  async read(state: SyncState, ctx: AdapterContext): Promise<WorkflowRead> {
    const round = await this.options.transport.round(state, ctx);
    const ingest = await this.ingest(round.copies, ctx.log);
    return {
      ...ingest,
      records: this.view(),
      nextState: round.nextState,
      costUnits: round.costUnits,
    };
  }

  async ingest(copies: readonly WorkflowCopy[], log: Logger): Promise<WorkflowIngest> {
    for (const copy of copies) {
      const id = copyId(copy);
      if (!this.opened.has(id) && !this.rejected.has(id)) this.waiting.set(id, copy);
    }
    const key = await this.key();
    if (!key) return { changed: [], skipped: 0, waiting: this.waiting.size };
    const records: WorkflowRecord[] = [];
    let skipped = 0;
    for (const [id, copy] of this.waiting) {
      this.waiting.delete(id);
      const payload = this.openCopy(copy, key, log);
      if (!payload) {
        this.rejected.add(id);
        skipped++;
        continue;
      }
      this.opened.set(id, payload.records);
      records.push(...payload.records);
    }
    const changed = mergeInto(this.merged, records).sort(byKey);
    this.high = highWater(records, this.high);
    return { changed, skipped, waiting: 0 };
  }

  async write(entries: readonly WorkflowEntry[], ctx: AdapterContext): Promise<WorkflowWritten> {
    const key = await this.key();
    if (!key)
      throw new Error('The data key is unavailable, so workflow changes cannot be shared yet');
    const now = ctx.clock.now();
    const records = entries.map(entry => this.stamp(entry, now));
    mergeInto(this.merged, records);
    const payload: WorkflowPayload = {
      v: 2,
      device: this.options.device,
      writtenAt: now,
      records: this.view(),
    };
    const data = seal(payload, key, this.options.address);
    const remoteId = await this.options.transport.put(
      { deviceId: this.options.device, writtenAt: now, data },
      ctx,
    );
    this.opened.set(remoteId, payload.records);
    this.published = { remoteId, view: new Map(payload.records.map(r => [r.key, r])) };
    return { remoteId, records };
  }

  async compact(ctx: AdapterContext): Promise<number> {
    const published = this.published;
    if (!published) return 0;
    const superseded = [...this.opened.entries()]
      .filter(([id, records]) => id !== published.remoteId && dominated(records, published.view))
      .map(([id]) => id);
    if (!superseded.length) return 0;
    await this.options.transport.compact(superseded, ctx);
    for (const id of superseded) this.opened.delete(id);
    return superseded.length;
  }

  private stamp(entry: WorkflowEntry, now: number): WorkflowRecord {
    const stamp = nextStamp(this.high, now, this.options.device);
    this.high = stamp;
    return { key: entry.key, stamp, value: entry.value };
  }

  private async key(): Promise<ChannelKey | undefined> {
    const data = await this.options.keys.dataKey();
    return data.kind === 'key' ? channelKey(data.key) : undefined;
  }

  private openCopy(copy: WorkflowCopy, key: ChannelKey, log: Logger): WorkflowPayload | undefined {
    const opened = open(copy.data, key, this.options.address);
    if (!opened.ok) {
      logSkipped(log, opened.reason);
      return undefined;
    }
    const payload = parsePayload(opened.plain);
    if (!payload) logSkipped(log, 'invalid');
    return payload;
  }
}
