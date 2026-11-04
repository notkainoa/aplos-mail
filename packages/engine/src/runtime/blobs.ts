/**
 * The engine's blob runtime (plans/engine/blob-area.md decisions 3 to 9; lane eng-contract): the in-memory index of
 * which blobs exist, who made them (principal and connection) and what still needs them, over the host's durable
 * `BlobFiles`. Bytes never stay in engine memory.
 *
 * - A blob of another principal is exactly as unknown as an id that never existed (`notFound`, one sentence).
 * - **Held**: any draft row's `attachments[].blobId` names it (one store read). A held blob is never dropped by a
 *   disconnect, a sweep or a restart. A blob a draft with a live submission names cannot even be released (FR-7).
 * - Unheld blobs go when the connection that made them closes, at the 10-minute sweep (uploads 24 h after they were
 *   made, `original` handles 30 min after their last read), or at start (`original` at once, uploads after 24 h).
 * - TOCTOU: every index change and every held check runs synchronously in one engine turn, and a file is deleted only
 *   after its index entry is gone, so no call sees a blob half released.
 */
import { principalOf } from '@aplos/contract/access';
import {
  BLOB_FILE_LIMITS,
  BLOB_ID_PATTERN,
  BlobFilesError,
  type BlobFiles,
  type BlobHeader,
  type DeadlineSource,
  type Logger,
  type StorePort,
} from '../ports';
import type { Caller } from '../methods/types';
import type { StoreReader } from '../store/port';
import { contractError } from './errors';
import { isAbsent } from './engine';
import type { EngineServices, LaneModule, LaneModuleSource } from './services';

declare module './services' {
  interface EngineServices {
    /** The blob index and lifecycle (`Blob/*`; the outbox reads a draft's attachments through `load`). */
    blobs: BlobRuntime;
  }
}

const MB = 1024 * 1024;
const MINUTE = 60_000;

/** Per-principal caps (decision 4): the windows and main together, and each listener client. */
export const BLOB_QUOTAS = {
  app: { bytes: 512 * MB, count: 500 },
  client: { bytes: 100 * MB, count: 50 },
} as const;

export const BLOB_TIMES = {
  /** An unheld upload lives this long after it was made. */
  uploadMs: 24 * 60 * MINUTE,
  /** An unheld `original` (or attachment) handle lives this long after its last read. */
  handleMs: 30 * MINUTE,
  /** How often the sweep runs on the timer loop. */
  sweepMs: 10 * MINUTE,
} as const;

/**
 * `Blob/get` replies in flight. On the real path a reply is cloned once across the utility boundary (Electron's
 * `MessagePortMain` cannot move a buffer), so one read can hold 25 MB in the engine, 25 MB in flight and 25 MB in the
 * receiver: at most two per principal, and 64 MB of blobs being read in all (a single read always fits). More answer a
 * retryable `unavailable`.
 */
export const BLOB_READS = { perPrincipal: 2, totalBytes: 64 * MB } as const;

/** The copy every caller sees (decisions 3, 4 and 7, and the fixture's per-file sentence). */
export const BLOB_SENTENCES = {
  busy: 'Aplos is busy reading other files. Try again in a moment.',
  gone: 'This file is no longer available.',
  tooLarge: 'Files can be at most 25 MB.',
  quota: 'Aplos is holding too many files. Send or remove some attachments first.',
  waiting: 'This file is attached to a message waiting to send.',
} as const;

type Kind = BlobHeader['kind'];

interface Entry {
  principal: string;
  kind: Kind;
  mime: string;
  name?: string;
  size: number;
  createdAt: number;
  lastReadAt: number;
  /** The connection that made it, while it is open; none for a blob found at start. */
  creator?: string;
}

export interface BlobPut {
  caller: Caller;
  connectionId: string;
  kind: Kind;
  bytes: Uint8Array;
  mime: string;
  name?: string;
  /** The caller's signal: a put that finishes after its connection closed is undone. */
  signal?: AbortSignal;
}

export interface BlobRuntime {
  put(input: BlobPut): Promise<{ blobId: string; size: number }>;
  get(
    caller: Caller,
    blobId: string,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string; name?: string; size: number }>;
  release(caller: Caller, blobId: string): Promise<void>;
  /**
   * True when `blobId` is in the index and `caller`'s principal made it: `Draft/set`'s check for every new attachment
   * (package 4), synchronous so the check and the commit share one turn.
   */
  owns(caller: Caller, blobId: string): boolean;
  /**
   * The bytes of a draft's own attachments for the outbox (package 4), ignoring principal (checked at `Draft/set`).
   * A missing blob is left out of the map. Each value is a fresh buffer.
   */
  load(blobIds: readonly string[]): Promise<Map<string, Uint8Array>>;
  /** The timer loop's sweep source; registered by the module. */
  readonly source: DeadlineSource;
  /** Drops the unheld blobs `connectionId` made. Never throws. */
  connectionClosed(connectionId: string): void;
  /** Rebuilds the index from `BlobFiles.list()` and applies the start rules. */
  start(): Promise<void>;
}

const unavailable = () =>
  contractError({ type: 'unavailable', message: 'This part of Aplos is not running yet.' });
const notFound = () => contractError({ type: 'notFound', message: BLOB_SENTENCES.gone });
const quota = () => contractError({ type: 'tooLarge', message: BLOB_SENTENCES.quota });
const busy = () =>
  contractError({ type: 'unavailable', message: BLOB_SENTENCES.busy, retryAfterMs: 1000 });

/** `type/subtype` in lower case, parameters dropped; anything else is `application/octet-stream`. */
export function cleanMime(raw: unknown): string {
  if (typeof raw !== 'string') return 'application/octet-stream';
  const value = raw.split(';')[0].trim().toLowerCase();
  const token = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,99}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,99}$/;
  return token.test(value) ? value : 'application/octet-stream';
}

/** Control characters (C0, DEL, C1), path separators, and the bidi controls that can disguise an extension. */
function unsafeChar(c: string): boolean {
  const n = c.codePointAt(0) ?? 0;
  if (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || c === '/' || c === '\\') return true;
  if (n === 0x61c || n === 0x200e || n === 0x200f) return true;
  return (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069);
}

/** A file name with no separator, NUL, control or bidi character, at most 255 characters; undefined when nothing is left. */
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const kept = [...raw].filter(c => !unsafeChar(c));
  const name = [...kept.join('').trim()].slice(0, 255).join('').trim();
  return name && name !== '.' && name !== '..' ? name : undefined;
}

const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

/** A 128-bit random id, `b_` and 32 hex digits. */
function mintId(randomBytes: (n: number) => Uint8Array): string {
  const id = `b_${hex(randomBytes(16))}`;
  if (!BLOB_ID_PATTERN.test(id)) throw new Error('randomBytes gave the wrong length');
  return id;
}

/**
 * The reply's bytes as a view over a whole, unshared `ArrayBuffer`, which a DOM or Node port end moves instead of copying
 * (the real path's `MessagePortMain` clones it once). `BlobFiles.get` already hands out one fresh buffer per call, so a
 * move never detaches anything the engine keeps; a view onto anything else is copied once here.
 */
function movable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = bytes.buffer;
  if (
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
  )
    return bytes as Uint8Array<ArrayBuffer>;
  return new Uint8Array(bytes);
}

const quotaOf = (principal: string) => (principal === 'app' ? BLOB_QUOTAS.app : BLOB_QUOTAS.client);

/** Every blob id a draft row names, and the ones a draft with a live submission names. */
function references(q: StoreReader): { held: Set<string>; live: Set<string> } {
  const held = new Set<string>();
  const live = new Set<string>();
  const rows = q.all<{ data: string; live: number }>(
    `SELECT d.data AS data, EXISTS(SELECT 1 FROM submissions s WHERE s.draft_id = d.id
       AND s.state NOT IN ('sent', 'cancelled')) AS live FROM drafts d`,
  );
  for (const row of rows) {
    for (const id of attachmentIds(row.data)) {
      held.add(id);
      if (row.live) live.add(id);
    }
  }
  return { held, live };
}

function attachmentIds(data: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  const list = (parsed as { attachments?: unknown } | null)?.attachments;
  if (!Array.isArray(list)) return [];
  return list
    .map(a => (a as { blobId?: unknown } | null)?.blobId)
    .filter((id): id is string => typeof id === 'string');
}

export function createBlobRuntime(deps: {
  files: BlobFiles;
  store: StorePort;
  clock: { now(): number };
  log: Logger;
  randomBytes(n: number): Uint8Array;
}): BlobRuntime {
  const { files, store, clock, log } = deps;
  const index = new Map<string, Entry>();
  /** Bytes and count of puts in flight, per principal, so concurrent puts cannot pass a cap together. */
  const pending = new Map<string, { bytes: number; count: number }>();
  /** `Blob/get` reads in progress, per principal, and the bytes they hold. */
  const reading = new Map<string, number>();
  let readingBytes = 0;
  let ready = false;
  let lastSweep = clock.now();

  const refs = () => store.read(references);
  const own = (caller: Caller, id: unknown): Entry | undefined => {
    if (typeof id !== 'string' || !BLOB_ID_PATTERN.test(id)) return undefined;
    const entry = index.get(id);
    return entry && entry.principal === principalOf(caller) ? entry : undefined;
  };
  /** Takes it out of the index now; the file goes after (a failed delete is the next start's job). */
  const drop = (id: string, reason: string) => {
    index.delete(id);
    files.remove(id).catch(() => log.event('rpc.failed', { method: 'Blob/remove', reason }));
  };

  function usage(principal: string) {
    let bytes = pending.get(principal)?.bytes ?? 0;
    let count = pending.get(principal)?.count ?? 0;
    for (const entry of index.values()) {
      if (entry.principal !== principal) continue;
      bytes += entry.size;
      count += 1;
    }
    return { bytes, count };
  }

  function reserve(principal: string, size: number): () => void {
    const used = usage(principal);
    const cap = quotaOf(principal);
    if (used.bytes + size > cap.bytes || used.count + 1 > cap.count) throw quota();
    const slot = pending.get(principal) ?? { bytes: 0, count: 0 };
    slot.bytes += size;
    slot.count += 1;
    pending.set(principal, slot);
    return () => {
      slot.bytes -= size;
      slot.count -= 1;
      if (!slot.count) pending.delete(principal);
    };
  }

  async function store1(id: string, header: BlobHeader, bytes: Uint8Array) {
    try {
      await files.put(id, header, bytes);
    } catch (error) {
      if (!(error instanceof BlobFilesError)) throw error;
      log.event('rpc.failed', { method: 'Blob/put', reason: error.reason });
      if (['tooLarge', 'folderFull', 'diskFull'].includes(error.reason)) throw quota();
      throw error;
    }
  }

  async function put(input: BlobPut) {
    if (!ready) throw unavailable();
    const bytes = input.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > BLOB_FILE_LIMITS.maxBytes)
      throw contractError({ type: 'tooLarge', message: BLOB_SENTENCES.tooLarge });
    const principal = principalOf(input.caller);
    const header: BlobHeader = {
      principal,
      kind: input.kind,
      mime: cleanMime(input.mime),
      size: bytes.byteLength,
      createdAt: clock.now(),
    };
    const name = cleanName(input.name);
    if (name) header.name = name;
    const id = mintId(deps.randomBytes);
    const release = reserve(principal, header.size);
    try {
      await store1(id, header, bytes);
    } finally {
      release();
    }
    // The window went away while the bytes were written: nobody can name this blob.
    if (input.signal?.aborted) {
      void files.remove(id).catch(() => undefined);
      throw contractError({ type: 'unavailable', message: 'This connection is closed.' });
    }
    index.set(id, { ...header, lastReadAt: header.createdAt, creator: input.connectionId });
    return { blobId: id, size: header.size };
  }

  /**
   * Takes a read slot: at most `BLOB_READS.perPrincipal` reads per principal and `BLOB_READS.totalBytes` of blobs
   * being read at once (one read always fits). Each costs up to 25 MB here, 25 MB in the clone and 25 MB in the receiver.
   */
  function readSlot(principal: string, size: number): () => void {
    const mine = reading.get(principal) ?? 0;
    const crowded = readingBytes > 0 && readingBytes + size > BLOB_READS.totalBytes;
    if (mine >= BLOB_READS.perPrincipal || crowded) throw busy();
    reading.set(principal, mine + 1);
    readingBytes += size;
    return () => {
      const left = (reading.get(principal) ?? 1) - 1;
      if (left) reading.set(principal, left);
      else reading.delete(principal);
      readingBytes -= size;
    };
  }

  async function get(caller: Caller, blobId: string) {
    if (!ready) throw unavailable();
    const found = own(caller, blobId);
    if (!found) throw notFound();
    const done = readSlot(found.principal, found.size);
    try {
      const read = await files.get(blobId);
      const entry = own(caller, blobId);
      // Released (or swept) while the file was read, or unreadable on the disk: not available, in both cases. The
      // index keeps an unreadable one (the host may read it again later); its lifecycle ends it.
      if (!entry || !read) throw notFound();
      entry.lastReadAt = clock.now();
      const bytes = movable(read.bytes);
      const out = { bytes, mime: entry.mime, size: bytes.byteLength };
      return entry.name === undefined ? out : { ...out, name: entry.name };
    } finally {
      done();
    }
  }

  async function release(caller: Caller, blobId: string) {
    if (!ready) throw unavailable();
    if (!own(caller, blobId)) throw notFound();
    if (refs().live.has(blobId))
      throw contractError({ type: 'stateMismatch', message: BLOB_SENTENCES.waiting });
    index.delete(blobId);
    await files.remove(blobId);
  }

  /** Unheld blobs past their time: uploads 24 h after they were made, handles 30 min after their last read. */
  function expired(now: number, held: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const [id, entry] of index) {
      if (held.has(id)) continue;
      const due =
        entry.kind === 'upload'
          ? entry.createdAt + BLOB_TIMES.uploadMs
          : entry.lastReadAt + BLOB_TIMES.handleMs;
      if (now >= due) out.push(id);
    }
    return out;
  }

  const source: DeadlineSource = {
    id: 'blobs',
    next: async () => (ready ? lastSweep + BLOB_TIMES.sweepMs : undefined),
    fire: async now => {
      lastSweep = now;
      const held = refs().held;
      for (const id of expired(now, held)) drop(id, 'sweep');
    },
  };

  function connectionClosed(connectionId: string) {
    try {
      const mine = [...index].filter(([, entry]) => entry.creator === connectionId);
      if (!mine.length) return;
      const held = refs().held;
      for (const [id, entry] of mine) {
        if (held.has(id)) delete entry.creator;
        else drop(id, 'closed');
      }
    } catch {
      // A store that is closing: the sweep or the next start ends these blobs.
    }
  }

  async function start() {
    const listed = await files.list();
    const now = clock.now();
    const held = refs().held;
    for (const { id, header } of listed) {
      if (!BLOB_ID_PATTERN.test(id)) continue;
      const entry: Entry = { ...header, lastReadAt: header.createdAt };
      const stale = header.kind === 'original' || now >= header.createdAt + BLOB_TIMES.uploadMs;
      if (!held.has(id) && stale) void files.remove(id).catch(() => undefined);
      else index.set(id, entry);
    }
    lastSweep = now;
    ready = true;
  }

  async function load(blobIds: readonly string[]) {
    const out = new Map<string, Uint8Array>();
    for (const id of new Set(blobIds)) {
      if (!index.has(id)) continue;
      const read = await files.get(id);
      if (read && index.has(id)) out.set(id, read.bytes);
    }
    return out;
  }

  const owns = (caller: Caller, blobId: string) => ready && own(caller, blobId) !== undefined;

  return { put, get, release, owns, load, source, connectionClosed, start };
}

/** Seam 1: the blob runtime as a module of the composition root, after `clock` (it registers the sweep source). */
export const lane = 'eng-contract';
export const extensions = [] as const;

export function createModule(services: EngineServices): LaneModule {
  const absent = isAbsent(services.blobFiles);
  const blobs = createBlobRuntime({
    files: services.blobFiles,
    store: services.store,
    clock: services.clock,
    log: services.log,
    randomBytes: n => services.randomBytes(n),
  });
  const unregister = absent ? undefined : services.deadlines.register(blobs.source);
  return {
    services: { blobs },
    async start() {
      if (absent) return;
      try {
        await blobs.start();
        services.deadlines.changed('blobs');
      } catch {
        // The folder could not be read: `Blob/*` stays unavailable, the rest of the engine runs.
        services.log.event('rpc.failed', { method: 'Blob/start', reason: 'list' });
      }
    },
    stop() {
      unregister?.();
    },
    onConnectionClose: connectionId => blobs.connectionClosed(connectionId),
  };
}

export const blobModule: LaneModuleSource = { lane, extensions, createModule };
