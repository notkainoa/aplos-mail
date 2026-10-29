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
import {
  highWater,
  isDeviceId,
  MAX_RECORDS,
  mergeInto,
  nextStamp,
  parsePayload,
  RETENTION_MS,
  settled,
  supersededBy,
  type JsonValue,
  type Stamp,
  type WorkflowPayload,
  type WorkflowRecord,
} from './workflow-merge';
import { logSkipped, remember } from './workflow-message';
import { channelKey, open, seal, type ChannelKey } from './workflow-seal';

/**
 * `WorkflowStateChannel`: the workflow channel as the engine side sees it (API in `workflow.ts`'s header). It opens the
 * transport's sealed copies with the data key, merges them into one view per process, and publishes this device's
 * records as a new sealed copy of the whole view. A copy that is not an Aplos copy, was sealed under another key or for
 * another account, is damaged or does not validate is skipped and logged by reason only; it never stops the round and
 * is never compacted away. When the data key is unavailable, copies are held and opened on a later call.
 *
 * Safety of the only readable copy: `write` leaves out settled records past the retention floor (`workflow-merge.ts`),
 * refuses a view larger than readers accept, and opens and validates its own sealed copy before sending it; only a copy
 * that passed that check can supersede others, and `compact` trashes only copies it supersedes. Per copy it remembers
 * one flag (superseded or not), for at most `CAP_COPIES` copies.
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
  /** Readers' record cap; tests lower it. */
  maxRecords?: number;
}

const ZERO: Stamp = { at: 0, gen: 0, device: '' };
const CAP_COPIES = 10_000;
const CAP_REJECTED = 10_000;
const byKey = (a: WorkflowRecord, b: WorkflowRecord) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/** A stable id for a copy with no remote id yet (never the case from Gmail, but the port allows it). */
const copyId = (copy: WorkflowCopy) =>
  copy.remoteId ?? `sealed:${createHash('sha256').update(copy.data).digest('base64url')}`;

export function createWorkflowStateChannel(options: WorkflowStateOptions): WorkflowStateChannel {
  if (!isDeviceId(options.device)) throw new Error('The workflow channel needs a valid device id');
  return new StateChannel(options);
}

interface Published {
  remoteId: string;
  records: Map<string, WorkflowRecord>;
  floor: number;
}

class StateChannel implements WorkflowStateChannel {
  /** Every key's winner over every copy read, before retention filtering. */
  private readonly winners = new Map<string, WorkflowRecord>();
  /** The highest floor seen, and the keys carried by copies written at that floor. */
  private floor = 0;
  private floorKeys = new Set<string>();
  /** Opened copies by remote id: whether the last validated write supersedes it. */
  private readonly opened = new Map<string, boolean>();
  private readonly rejected = new Map<string, true>();
  private readonly waiting = new Map<string, WorkflowCopy>();
  private high: Stamp = ZERO;
  private published?: Published;
  private readonly maxRecords: number;

  constructor(private readonly options: WorkflowStateOptions) {
    this.maxRecords = options.maxRecords ?? MAX_RECORDS;
  }

  view(): WorkflowRecord[] {
    return this.viewOf(this.winners);
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
    const before = new Map(this.view().map(r => [r.key, r]));
    let skipped = 0;
    for (const [id, copy] of this.waiting) {
      this.waiting.delete(id);
      if (!this.take(id, copy, key, log)) skipped++;
    }
    const changed = this.view().filter(r => before.get(r.key) !== r);
    return { changed, skipped, waiting: 0 };
  }

  async write(entries: readonly WorkflowEntry[], ctx: AdapterContext): Promise<WorkflowWritten> {
    const key = await this.key();
    if (!key)
      throw new Error('The data key is unavailable, so workflow changes cannot be shared yet');
    const now = ctx.clock.now();
    const records = this.stampAll(entries, now);
    // Staged: nothing reaches the view until the copy is sent, so a failed put leaves no local-only record.
    const staged = new Map(this.winners);
    mergeInto(staged, records);
    const floor = Math.max(this.floor, now - RETENTION_MS);
    const payload: WorkflowPayload = {
      v: 2,
      device: this.options.device,
      writtenAt: now,
      floor,
      records: this.viewOf(staged).filter(r => !(r.stamp.at <= floor && settled(r))),
    };
    const data = this.sealChecked(payload, key);
    const covered = [...this.opened.keys()];
    const remoteId = await this.options.transport.put(
      { deviceId: this.options.device, writtenAt: now, data },
      ctx,
    );
    mergeInto(this.winners, records);
    this.adopt(payload);
    for (const id of covered) if (this.opened.has(id)) this.opened.set(id, true);
    remember(this.opened, remoteId, false, CAP_COPIES);
    this.published = {
      remoteId,
      records: new Map(payload.records.map(r => [r.key, r])),
      floor,
    };
    return { remoteId, records };
  }

  async compact(ctx: AdapterContext): Promise<number> {
    const published = this.published;
    if (!published || this.view().length > this.maxRecords) return 0;
    const superseded = [...this.opened.entries()]
      .filter(([id, flag]) => flag && id !== published.remoteId)
      .map(([id]) => id);
    if (!superseded.length) return 0;
    await this.options.transport.compact(superseded, ctx);
    for (const id of superseded) this.opened.delete(id);
    return superseded.length;
  }

  /** Retention (`RETENTION_MS`): what a reader keeps given the highest floor it has seen. */
  private visible(r: WorkflowRecord): boolean {
    if (r.stamp.at > this.floor) return true;
    return !settled(r) && this.floorKeys.has(r.key);
  }

  /** Records a copy's floor and keys, so every device filters by the same rule. */
  private adopt(payload: WorkflowPayload): void {
    const floor = payload.floor ?? 0;
    if (floor < this.floor || floor === 0) return;
    if (floor > this.floor) {
      this.floor = floor;
      this.floorKeys = new Set();
    }
    for (const r of payload.records) this.floorKeys.add(r.key);
  }

  /**
   * Seals and then opens and validates the result exactly as a reader would; a copy that would not come back whole
   * is never sent, so it can never supersede (and get compacted against) the copies that are readable.
   */
  private sealChecked(payload: WorkflowPayload, key: ChannelKey): string {
    if (payload.records.length > this.maxRecords)
      throw new Error('Too much workflow data to share; older entries must expire first');
    const data = seal(payload, key, this.options.address);
    const back = open(data, key, this.options.address);
    const parsed = back.ok ? parsePayload(back.plain, this.maxRecords) : undefined;
    if (parsed?.records.length !== payload.records.length)
      throw new Error('The sealed workflow copy did not read back');
    return data;
  }

  /** Opens and merges one copy; false when it was skipped. */
  private take(id: string, copy: WorkflowCopy, key: ChannelKey, log: Logger): boolean {
    const payload = this.openCopy(copy, key, log);
    if (!payload) {
      remember(this.rejected, id, true, CAP_REJECTED);
      return false;
    }
    mergeInto(this.winners, payload.records);
    this.high = highWater(payload.records, this.high);
    this.adopt(payload);
    const published = this.published;
    remember(
      this.opened,
      id,
      published ? supersededBy(payload.records, published) : false,
      CAP_COPIES,
    );
    return true;
  }

  private viewOf(winners: ReadonlyMap<string, WorkflowRecord>): WorkflowRecord[] {
    return [...winners.values()].filter(r => this.visible(r)).sort(byKey);
  }

  /**
   * Stamps a write's entries above everything seen. The clock moves on even if the put then fails (it only ever rises,
   * and two writes in flight never share a stamp); the records themselves wait for the put.
   */
  private stampAll(entries: readonly WorkflowEntry[], now: number): WorkflowRecord[] {
    return entries.map(entry => {
      this.high = nextStamp(this.high, now, this.options.device);
      return { key: entry.key, stamp: this.high, value: entry.value };
    });
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
    const payload = parsePayload(opened.plain, this.maxRecords);
    if (!payload) logSkipped(log, 'invalid');
    return payload;
  }
}
