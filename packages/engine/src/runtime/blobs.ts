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
import { LIVE_SQL } from '../outbox/draft-state';
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
 * Concurrent `Blob/get` reads in the engine (from the check until the handler returns its bytes). It bounds the engine's
 * own read buffers; the clone in flight across the utility boundary and the receiver's copy are not counted (the slot is
 * given back before the reply is serialized). At most two reads per principal; listener clients together hold at most
 * `clientBytes` (one read always fits), and the owner's windows (`app`) have their own two, so a client cannot starve
 * them. Worst case about 2 x 25 MB for `app` plus 32 MB for clients. More answer a retryable `unavailable`.
 */
export const BLOB_READS = { perPrincipal: 2, clientBytes: 32 * MB } as const;

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
  kind: Kind | 'attachment';
  mime: string;
  name?: string;
  size: number;
  /** `attachment` handles only: the `AttachmentFiles` path the bytes are read from (never copied into BlobFiles). */
  path?: string;
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

export interface BlobAttach {
  caller: Caller;
  connectionId: string;
  /** The `AttachmentFiles`-relative path the handle reads through. */
  path: string;
  /** Cleaned with `cleanMime`/`cleanName` by the caller. */
  mime: string;
  name?: string;
  size: number;
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
  /** Would `bytes` more fit the caller's quota? Checked BEFORE a paid provider fetch (Message/original). */
  fits(caller: Caller, bytes: number): boolean;
  /** Bumps a live owned handle's last-read clock without reading its bytes (Message/original reuse). */
  touch(caller: Caller, blobId: string): boolean;
  /**
   * The bytes of a draft's own attachments for the outbox (package 4), ignoring principal (checked at `Draft/set`).
   * A missing blob is left out of the map. Each value is a fresh buffer.
   */
  load(blobIds: readonly string[]): Promise<Map<string, Uint8Array>>;
  /**
   * A read handle onto an attachment already in the store's file cache (`Attachment/get`, package 6): in memory
   * only, never a second copy in `BlobFiles`. Lives like an `original` handle (30 min after its last read) and
   * `Blob/get` resolves its bytes through `AttachmentFiles`; an evicted file reads as `notFound`.
   */
  attach(input: BlobAttach): { blobId: string };
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

/**
 * Path separators and every Unicode control (Cc: C0, DEL, C1), format character (Cf: the bidi controls that can
 * disguise an extension, zero-width characters, U+FEFF) and line or paragraph separator (Zl, Zp), so nothing that could
 * break a MIME `filename=` or mislead the owner survives.
 */
const UNSAFE_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\]/u;
const unsafeChar = (c: string) => UNSAFE_CHAR.test(c);

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

/**
 * Every blob id a draft row names, and the ones a draft with a live submission names. A hidden row
 * (`_sync.removing`: a discarded or sent draft kept until the provider confirms its copy is gone) does not
 * hold its blobs unless a submission is still live; the bytes a dead send referenced may be swept while the
 * row itself waits on the provider.
 */
function references(q: StoreReader): { held: Set<string>; live: Set<string> } {
  const held = new Set<string>();
  const live = new Set<string>();
  const rows = q.all<{ data: string; live: number }>(
    `SELECT d.data AS data, EXISTS(SELECT 1 FROM submissions s WHERE s.draft_id = d.id
       AND s.state IN (${LIVE_SQL})) AS live FROM drafts d`,
  );
  for (const row of rows) {
    const { ids, removing } = attachmentsOf(row.data);
    if (removing && !row.live) continue;
    for (const id of ids) {
      held.add(id);
      if (row.live) live.add(id);
    }
  }
  return { held, live };
}

/**
 * The blob ids a draft row's attachments name, and whether it is hidden (`_sync.removing`). Read JS-side,
 * never in SQL: a row whose `data` is not JSON must not abort the whole query (`parseData`'s rule — an
 * unreadable row reads as empty and keeps holding), and a falsy-but-present `removing` is not hidden, the
 * same truthiness `parseData` reports.
 */
function attachmentsOf(data: string): { ids: string[]; removing: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ids: [], removing: false };
  }
  const draft = parsed as { attachments?: unknown; _sync?: unknown } | null;
  const sync = typeof draft?._sync === 'object' ? draft._sync : null;
  const list = draft?.attachments;
  const ids = Array.isArray(list)
    ? list
        .map(a => (a as { blobId?: unknown } | null)?.blobId)
        .filter((id): id is string => typeof id === 'string')
    : [];
  return {
    ids,
    removing: !!(sync as { removing?: unknown } | null)?.removing,
  };
}

export function createBlobRuntime(deps: {
  files: BlobFiles;
  store: StorePort;
  clock: { now(): number };
  log: Logger;
  randomBytes(n: number): Uint8Array;
  /** The attachment cache `attachment` handles read through; absent, `attach` is `unavailable`. */
  attachment?: { read(path: string): Promise<Uint8Array | undefined> };
}): BlobRuntime {
  const { files, store, clock, log } = deps;
  const index = new Map<string, Entry>();
  /** Bytes and count of puts in flight, per principal, so concurrent puts cannot pass a cap together. */
  const pending = new Map<string, { bytes: number; count: number }>();
  /** `Blob/get` reads in progress, per principal, and the bytes listener clients' reads hold together. */
  const reading = new Map<string, number>();
  let clientBytes = 0;
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
    const entry = index.get(id);
    index.delete(id);
    if (entry?.kind !== 'attachment')
      files.remove(id).catch(() => log.event('rpc.failed', { method: 'Blob/remove', reason }));
  };

  function usage(principal: string) {
    let bytes = pending.get(principal)?.bytes ?? 0;
    let count = pending.get(principal)?.count ?? 0;
    for (const entry of index.values()) {
      // An `attachment` handle owns no BlobFiles bytes — it reads through the shared cache — so it
      // does not spend the caller's upload quota (Blob/get on it is bounded by the file cap).
      if (entry.principal !== principal || entry.kind === 'attachment') continue;
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

  /** Takes a read slot (`BLOB_READS`): two per principal, and a shared byte budget for listener clients only. */
  function readSlot(principal: string, size: number): () => void {
    const mine = reading.get(principal) ?? 0;
    const counted = principal === 'app' ? 0 : size;
    const crowded =
      counted > 0 && clientBytes > 0 && clientBytes + counted > BLOB_READS.clientBytes;
    if (mine >= BLOB_READS.perPrincipal || crowded) throw busy();
    reading.set(principal, mine + 1);
    clientBytes += counted;
    return () => {
      const left = (reading.get(principal) ?? 1) - 1;
      if (left) reading.set(principal, left);
      else reading.delete(principal);
      clientBytes -= counted;
    };
  }

  /** An attachment handle's bytes: through the file cache, never a copy of its own. */
  const attachmentBytes = (entry: Entry) =>
    deps.attachment && entry.path !== undefined ? deps.attachment.read(entry.path) : undefined;

  function attach(input: BlobAttach) {
    if (!ready || !deps.attachment) throw unavailable();
    const principal = principalOf(input.caller);
    // The same principal asking for the same cached file gets the live handle back — a
    // `Blob/get` reads the path's current bytes either way — and a per-principal cap keeps a loop
    // from minting one fresh handle per call (they live 30 min and own no bytes, so bytes exempt
    // is not enough).
    let held = 0;
    for (const [id, entry] of index) {
      if (entry.kind !== 'attachment' || entry.principal !== principal) continue;
      if (entry.path === input.path) {
        entry.lastReadAt = clock.now();
        return { blobId: id };
      }
      held += 1;
    }
    if (held >= 200) throw busy();
    const now = clock.now();
    const id = mintId(deps.randomBytes);
    index.set(id, {
      principal,
      kind: 'attachment',
      path: input.path,
      mime: input.mime,
      name: input.name,
      size: input.size,
      createdAt: now,
      lastReadAt: now,
      creator: input.connectionId,
    });
    return { blobId: id };
  }

  async function get(caller: Caller, blobId: string) {
    if (!ready) throw unavailable();
    const found = own(caller, blobId);
    if (!found) throw notFound();
    const done = readSlot(found.principal, found.size);
    try {
      const read =
        found.kind === 'attachment'
          ? await attachmentBytes(found)
          : (await files.get(blobId))?.bytes;
      const entry = own(caller, blobId);
      // Released (or swept) while the file was read, or unreadable on the disk: not available, in both cases. The
      // index keeps an unreadable one (the host may read it again later); its lifecycle ends it.
      if (!entry || !read) throw notFound();
      entry.lastReadAt = clock.now();
      const bytes = movable(read);
      const out = { bytes, mime: entry.mime, size: bytes.byteLength };
      return entry.name === undefined ? out : { ...out, name: entry.name };
    } finally {
      done();
    }
  }

  async function release(caller: Caller, blobId: string) {
    if (!ready) throw unavailable();
    const entry = own(caller, blobId);
    if (!entry) throw notFound();
    if (refs().live.has(blobId))
      throw contractError({ type: 'stateMismatch', message: BLOB_SENTENCES.waiting });
    index.delete(blobId);
    // An attachment handle owns no file of its own; the cache's lifecycle ends it.
    if (entry.kind !== 'attachment')
      // Released already: a failed delete is logged, never reported (the next start cleans the file).
      await files
        .remove(blobId)
        .catch(() => log.event('rpc.failed', { method: 'Blob/remove', reason: 'release' }));
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
      // A time ahead of now (the clock moved back) would keep an upload forever: it counts from now at most.
      const createdAt = Math.min(header.createdAt, now);
      const entry: Entry = { ...header, createdAt, lastReadAt: createdAt };
      const stale = header.kind === 'original' || now >= createdAt + BLOB_TIMES.uploadMs;
      if (!held.has(id) && stale) void files.remove(id).catch(() => undefined);
      else index.set(id, entry);
    }
    lastSweep = now;
    ready = true;
  }

  async function load(blobIds: readonly string[]) {
    const out = new Map<string, Uint8Array>();
    for (const id of new Set(blobIds)) {
      const entry = index.get(id);
      if (!entry) continue;
      const read =
        entry.kind === 'attachment' ? await attachmentBytes(entry) : (await files.get(id))?.bytes;
      if (read && index.has(id)) out.set(id, read);
    }
    return out;
  }

  const owns = (caller: Caller, blobId: string) => ready && own(caller, blobId) !== undefined;

  const fits = (caller: Caller, bytes: number) => {
    if (!ready) return false;
    const principal = principalOf(caller);
    const used = usage(principal);
    const cap = quotaOf(principal);
    return used.bytes + bytes <= cap.bytes && used.count + 1 <= cap.count;
  };

  const touch = (caller: Caller, blobId: string) => {
    const entry = ready ? own(caller, blobId) : undefined;
    if (!entry) return false;
    entry.lastReadAt = clock.now();
    return true;
  };

  return { put, get, release, owns, fits, touch, load, attach, source, connectionClosed, start };
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
    attachment: services.attachmentFiles,
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
