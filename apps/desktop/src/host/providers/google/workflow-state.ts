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
  compareRecord,
  floorTrusted,
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
import { digestCovers, digestOf, OwnDigests, type CopyDigest } from './workflow-digest';
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
 * refuses a view larger than readers accept, and opens and validates its own sealed copy before sending it. Before the
 * first `compact` against a written copy, it downloads that copy from Gmail (`readBack`) and opens it as a reader would;
 * only a copy that came back whole, with a floor readers will honour, supersedes the copies it covers, and `compact`
 * trashes only those, at most `COMPACT_BATCH` per call. Per copy it remembers one flag (superseded or not), for at most
 * `CAP_COPIES` copies.
 *
 * A copy's floor counts only when Gmail's receive time for it allows it (`floorTrusted`), so a device whose clock runs
 * months fast cannot hide everyone else's records; its own copies then never verify for a full compaction.
 * `compact(ctx, { ownOnly: true })` (a device the lease's clock gate blocks) trashes only copies this device wrote. It
 * may use a copy whose floor Gmail's time does not honour (a clock days fast), but then trashes an own copy only when
 * every record that copy holds is in the new copy, equal or with a later stamp: a fast floor leaves out settled
 * records honest readers still keep, and a copy still holding one is never trashed. Of its own copies it remembers a
 * digest only (per key the stamp and a value hash, `workflow-digest.ts`), for at most `CAP_OWN` copies and
 * `OWN_ENTRY_COPIES` full views' worth of records. Of an own copy pushed out of that memory it keeps the id only (at
 * most `CAP_COPIES`): with a floor readers honour, the id is enough to trash it once superseded; otherwise each own-only
 * compaction downloads and opens at most `OWN_REREADS` such copies again (60 units each, through the governor) to
 * match them. A forgotten copy is re-read once: trashed when the new copy covers it, else kept for good (it holds a
 * record the new copy lacks; a later full compaction may still trash it), so the re-reads cost at most 60 units per
 * forgotten copy, ever.
 *
 * Clock offset (the lease's clock gate): each write brackets Gmail's receive time for its copy with this device's
 * clock just before the insert went out and just after it returned (`WorkflowTransport.sentWindow`, so pacing waits
 * and sealing are outside the bracket; without it, the time around the whole `put`), and reports both ends. `probe`
 * checks the last copy put again (one 20-unit get, no new copy), for a gate whose checks kept failing.
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
  /**
   * This device's clock minus Gmail's receive time for the copy (ms), bracketed: `lowMs` from just before the insert,
   * `highMs` from just after it. Absent when it could not be measured (the check failed, or the put found a copy an
   * earlier insert made), which the gate treats as unmeasurable.
   */
  clockOffset?: { lowMs: number; highMs: number };
}

export interface WorkflowStateChannel {
  read(state: SyncState, ctx: AdapterContext): Promise<WorkflowRead>;
  ingest(copies: readonly WorkflowCopy[], log: Logger): Promise<WorkflowIngest>;
  write(entries: readonly WorkflowEntry[], ctx: AdapterContext): Promise<WorkflowWritten>;
  compact(ctx: AdapterContext, options?: CompactOptions): Promise<number>;
  /** The clock offset from the last copy this process put, measured again (no new copy); empty when none or failed. */
  probe(ctx: AdapterContext): Promise<{ clockOffset?: WorkflowWritten['clockOffset'] }>;
  view(): WorkflowRecord[];
}

export interface CompactOptions {
  /** Trash only copies this device wrote (a device the lease's clock gate blocks). */
  ownOnly?: boolean;
}

/** This device's clock just before an insert went out and just after it returned. */
export interface SentWindow {
  from: number;
  to: number;
}

/**
 * The port's channel plus one download by id, for checking a written copy before compacting against it, and the
 * server's receive time for a copy, for the lease's clock gate.
 */
export interface WorkflowTransport extends WorkflowChannel {
  readBack(remoteId: string, ctx: AdapterContext): Promise<WorkflowCopy | undefined>;
  receivedAt(remoteId: string, ctx: AdapterContext): Promise<number | undefined>;
  /**
   * The bracket of the insert that made `remoteId` in this process; undefined when the last `put` found the copy
   * instead of inserting it. Absent: the channel brackets the whole `put`.
   */
  sentWindow?(remoteId: string): SentWindow | undefined;
}

export interface WorkflowStateOptions {
  transport: WorkflowTransport;
  keys: KeyProvider;
  device: DeviceId;
  /** The account's address: sealed copies are bound to it. */
  address: string;
  /** Readers' record cap; tests lower it. */
  maxRecords?: number;
}

const ZERO: Stamp = { at: 0, gen: 0, device: '' };
/** Copies one `compact` trashes at most (20 units each); the rest go on later calls. */
export const COMPACT_BATCH = 25;
const CAP_COPIES = 10_000;
/** Own copies remembered by digest; one past this is kept by id and re-read to match (`OWN_REREADS`). */
const CAP_OWN = 256;
/** The records the own digests hold at most, in full views (`maxRecords`): the newest two copies always fit. */
const OWN_ENTRY_COPIES = 2;
const CAP_REJECTED = 10_000;
/** Forgotten own copies one own-only compaction downloads again to match (`reread`). */
export const OWN_REREADS = 3;
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
  /** The same records as a digest, for matching own copies (`ownTrashable`). */
  digest: CopyDigest;
  floor: number;
  /** Copies opened before the write: superseded once the written copy has been read back from Gmail. */
  covered: string[];
  verified: boolean;
  /**
   * Gmail's receive time for the read-back copy honours its floor. False only when an own-only compaction accepted
   * the copy anyway (a clock days off: the floor check fails, yet the copy is provably this device's own and whole).
   */
  floorTrusted?: boolean;
}

/** True when an opened copy is exactly what was written: this device's, same floor, same records. */
function sameAsPublished(
  payload: WorkflowPayload,
  published: Published,
  device: DeviceId,
): boolean {
  if (payload.device !== device || (payload.floor ?? 0) !== published.floor) return false;
  if (payload.records.length !== published.records.size) return false;
  return payload.records.every(r => {
    const held = published.records.get(r.key);
    return held !== undefined && compareRecord(held, r) === 0;
  });
}

class StateChannel implements WorkflowStateChannel {
  /** Every key's winner over every copy read, before retention filtering. */
  private readonly winners = new Map<string, WorkflowRecord>();
  /** The highest floor seen, and the keys carried by copies written at that floor. */
  private floor = 0;
  private floorKeys = new Set<string>();
  /** Opened copies by remote id: whether the last validated write supersedes it. */
  private readonly opened = new Map<string, boolean>();
  /** Opened copies this device wrote (this process or an earlier one), by digest: what `ownOnly` may trash. */
  private readonly own: OwnDigests;
  /** Opened copies this device wrote whose digest `own` no longer holds: re-read to match (`ownTrashable`). */
  private readonly forgotten = new Map<string, true>();
  private readonly rejected = new Map<string, true>();
  private readonly waiting = new Map<string, WorkflowCopy>();
  private high: Stamp = ZERO;
  private published?: Published;
  /** The last copy put and the bracket around it, kept even when it did not verify (`probe`). */
  private lastPut?: { remoteId: string; window: SentWindow };
  private readonly maxRecords: number;

  constructor(private readonly options: WorkflowStateOptions) {
    this.maxRecords = options.maxRecords ?? MAX_RECORDS;
    this.own = new OwnDigests(CAP_OWN, OWN_ENTRY_COPIES * this.maxRecords);
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
    // A copy leaves `waiting` only once taken: a throw part way keeps the rest for the next call (the transport
    // has already marked them seen, so no later round downloads them again).
    for (const [id, copy] of this.waiting) {
      if (!this.take(id, copy, key, log)) skipped++;
      this.waiting.delete(id);
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
    const before = ctx.clock.now();
    const remoteId = await this.options.transport.put(
      { deviceId: this.options.device, writtenAt: now, data },
      ctx,
    );
    const after = ctx.clock.now();
    const digest = digestOf(payload.records);
    this.rememberOwn(remoteId, digest);
    mergeInto(this.winners, records);
    this.adopt(payload, true);
    // Nothing counts as superseded until this copy has been read back (`verify`).
    for (const id of this.opened.keys()) this.opened.set(id, false);
    remember(this.opened, remoteId, false, CAP_COPIES);
    this.published = {
      remoteId,
      records: new Map(payload.records.map(r => [r.key, r])),
      digest,
      floor,
      covered,
      verified: false,
    };
    this.lastPut = { remoteId, window: { from: before, to: after } };
    const clockOffset = await this.clockOffset(remoteId, this.lastPut.window, ctx);
    return { remoteId, records, ...(clockOffset ? { clockOffset } : {}) };
  }

  async probe(ctx: AdapterContext): Promise<{ clockOffset?: WorkflowWritten['clockOffset'] }> {
    const last = this.lastPut;
    if (!last) return {};
    const clockOffset = await this.clockOffset(last.remoteId, last.window, ctx);
    return clockOffset ? { clockOffset } : {};
  }

  /**
   * The insert's bracket minus Gmail's receive time for the copy just put; undefined when the copy was not inserted
   * by this put or the check fails (never throws).
   */
  private async clockOffset(
    remoteId: string,
    put: SentWindow,
    ctx: AdapterContext,
  ): Promise<WorkflowWritten['clockOffset']> {
    const transport = this.options.transport;
    const window = transport.sentWindow ? transport.sentWindow(remoteId) : put;
    if (!window) return undefined;
    try {
      const received = await transport.receivedAt(remoteId, ctx);
      if (received === undefined) return undefined;
      return { lowMs: window.from - received, highMs: window.to - received };
    } catch {
      return undefined;
    }
  }

  async compact(ctx: AdapterContext, options: CompactOptions = {}): Promise<number> {
    const published = this.published;
    if (!published || this.view().length > this.maxRecords) return 0;
    const ownOnly = options.ownOnly === true;
    if (!published.verified && !(await this.verify(published, ctx, ownOnly))) return 0;
    if (!ownOnly && published.floorTrusted === false) return 0;
    const superseded: string[] = [];
    const rereads = { left: OWN_REREADS };
    for (const [id, flag] of [...this.opened]) {
      if (superseded.length >= COMPACT_BATCH) break;
      if (!flag || id === published.remoteId) continue;
      if (ownOnly && !(await this.ownTrashable(id, published, rereads, ctx))) continue;
      superseded.push(id);
    }
    // A re-read waited on Gmail: a write since then judged every copy afresh.
    if (!superseded.length || this.published !== published) return 0;
    await this.options.transport.compact(superseded, ctx);
    for (const id of superseded) {
      this.opened.delete(id);
      this.own.delete(id);
      this.forgotten.delete(id);
    }
    return superseded.length;
  }

  /**
   * An own copy an own-only compaction may trash: one this device wrote, and, when the new copy's floor is not one
   * readers honour, only if the new copy holds every record it holds, equal or with a later stamp (nothing it alone
   * still carries is lost). A forgotten own copy is matched by downloading it again, `rereads.left` at most per call.
   */
  private async ownTrashable(
    id: string,
    published: Published,
    rereads: { left: number },
    ctx: AdapterContext,
  ): Promise<boolean> {
    const digest = this.own.get(id);
    if (!digest && !this.forgotten.has(id)) return false;
    if (published.floorTrusted !== false) return true;
    if (digest) return digestCovers(published.digest, digest);
    if (rereads.left <= 0) return false;
    rereads.left--;
    const again = await this.tryReread(id, ctx);
    if (again === 'unread') return false;
    const covered = again !== undefined && digestCovers(published.digest, again);
    // Re-read once: one the new copy does not cover stays on the label for good (it leaves `forgotten` when trashed).
    if (!covered) this.forgotten.delete(id);
    return covered;
  }

  /** `reread`, but a failed download skips this copy (it stays forgotten, tried again next call), never the batch. */
  private async tryReread(
    id: string,
    ctx: AdapterContext,
  ): Promise<CopyDigest | 'unread' | undefined> {
    try {
      return await this.reread(id, ctx);
    } catch {
      return 'unread';
    }
  }

  /**
   * A forgotten own copy downloaded and opened again, as its digest (never kept); undefined when it is gone or does not
   * open as this device's, `unread` when the data key is unavailable. A failed download throws (`tryReread` keeps the copy for the next call).
   */
  private async reread(
    id: string,
    ctx: AdapterContext,
  ): Promise<CopyDigest | 'unread' | undefined> {
    const key = await this.key();
    if (!key) return 'unread';
    const copy = await this.options.transport.readBack(id, ctx);
    const payload = copy ? this.openCopy(copy, key, ctx.log) : undefined;
    if (payload?.device !== this.options.device) return undefined;
    return digestOf(payload.records);
  }

  /** Remembers an own copy's digest; the copies that pushes out of `own` are kept as forgotten ids. */
  private rememberOwn(id: string, digest: CopyDigest): void {
    this.forgotten.delete(id);
    for (const old of this.own.remember(id, digest))
      remember(this.forgotten, old, true, CAP_COPIES);
  }

  /**
   * Downloads the written copy and opens it as another device would. Only when it comes back exactly as written, with
   * a floor readers honour, do the copies it covers count as superseded; otherwise nothing is compacted against it.
   * For an own-only compaction a floor Gmail's time does not honour is no bar (the copy is this device's own, sealed
   * and read back whole), but the copy stays unusable for a full compaction (`floorTrusted: false`), and each own copy
   * it would trash must be matched record by record (`ownTrashable`).
   */
  private async verify(
    published: Published,
    ctx: AdapterContext,
    ownOnly: boolean,
  ): Promise<boolean> {
    const key = await this.key();
    if (!key) return false;
    const copy = await this.options.transport.readBack(published.remoteId, ctx);
    if (this.published !== published) return false;
    const reason = copy ? this.readBackFailure(copy, published, key, ctx.log) : 'readBack';
    const ownDespiteClock = reason === 'clock' && ownOnly;
    if (reason && !ownDespiteClock) {
      if (reason !== 'logged') logSkipped(ctx.log, reason);
      this.distrust();
      return false;
    }
    published.verified = true;
    published.floorTrusted = !ownDespiteClock;
    for (const id of published.covered) if (this.opened.has(id)) this.opened.set(id, true);
    return true;
  }

  /** Why a read-back copy cannot be trusted (`logged` when `openCopy` already logged it), or undefined. */
  private readBackFailure(
    copy: WorkflowCopy,
    published: Published,
    key: ChannelKey,
    log: Logger,
  ): string | undefined {
    const payload = this.openCopy(copy, key, log);
    if (!payload) return 'logged';
    if (!sameAsPublished(payload, published, this.options.device)) return 'readBack';
    if (published.floor && !floorTrusted(published.floor, copy.writtenAt)) return 'clock';
    return undefined;
  }

  /** The written copy did not verify: compact nothing against it, and forget what was judged against it. */
  private distrust(): void {
    this.published = undefined;
    for (const id of this.opened.keys()) this.opened.set(id, false);
  }

  /** Retention (`RETENTION_MS`): what a reader keeps given the highest floor it has seen. */
  private visible(r: WorkflowRecord): boolean {
    if (r.stamp.at > this.floor) return true;
    return !settled(r) && this.floorKeys.has(r.key);
  }

  /** Records a copy's floor and keys, so every device filters by the same rule; an untrusted floor counts as none. */
  private adopt(payload: WorkflowPayload, trusted: boolean): void {
    const floor = trusted ? (payload.floor ?? 0) : 0;
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
    if (payload.device === this.options.device) this.rememberOwn(id, digestOf(payload.records));
    this.high = highWater(payload.records, this.high);
    this.adopt(payload, floorTrusted(payload.floor ?? 0, copy.writtenAt));
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
    return data.kind === 'key' ? channelKey(data.key, this.options.address) : undefined;
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
