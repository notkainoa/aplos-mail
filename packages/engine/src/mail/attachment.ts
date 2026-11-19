import type { Input, Output } from '@aplos/contract';
import type { MethodContext } from '../methods/types';
import type { EngineServices } from '../runtime/services';
import { contractError } from '../runtime/errors';
import { cleanMime, cleanName } from '../runtime/blobs';
import { deadline, within, type Deadline } from './deadline';
import { requireMessage, type MessageRef } from './message';
import { StoreError } from '../store';

/**
 * `Attachment/get` (Blob package 6, blob-area.md decision 11): a stored attachment's bytes as a blob handle. A
 * `present` row whose cached file reads answers at once; anything else commits `fetching`, streams the part from the
 * provider under a 25 MB cap and a 120 s total / 30 s idle deadline tied to the caller's signal, writes it into the
 * `attachments/.noindex/` cache and commits `present` with the path. One fetch per part is in flight at a time (every
 * caller shares it and registers its own handle after) and at most three per account. The blob is an engine-side
 * `attachment` handle onto the cached file: `Blob/get` reads it, never a second copy.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const TOTAL_MS = 120_000;
const IDLE_MS = 30_000;
const PER_ACCOUNT = 3;
const GLOBAL = 4;

const unavailable = (message = "Couldn't download this attachment. Try again.") =>
  contractError({ type: 'unavailable', message });
const notFound = () =>
  contractError({ type: 'notFound', message: 'This attachment is no longer available.' });
const tooLarge = () =>
  contractError({ type: 'tooLarge', message: 'This attachment is too large to open in Aplos.' });
const busy = () =>
  contractError({
    type: 'unavailable',
    message: 'Aplos is already downloading several attachments. Try again in a moment.',
    retryAfterMs: 1000,
  });

const nonce = (services: EngineServices) =>
  [...services.randomBytes(8)].map(b => b.toString(16).padStart(2, '0')).join('');

interface PartRow {
  remote_part: string;
  name: string | null;
  mime: string | null;
  state: string;
  path: string | null;
  [k: string]: string | number | null;
}

function partRow(
  services: EngineServices,
  ref: MessageRef,
  remotePart: string,
): PartRow | undefined {
  return services.store.read(q =>
    q.get<PartRow>(
      'SELECT remote_part, name, mime, state, path FROM attachments WHERE message_id = ? AND remote_part = ?',
      ref.rowId,
      remotePart,
    ),
  );
}

function stateCommit(
  services: EngineServices,
  ref: MessageRef,
  remotePart: string,
  state: 'absent' | 'fetching' | 'present',
  path?: string,
): void {
  // Every transition needs its own opId: the commits table dedupes by opId forever, so a repeated
  // `fetching`/`present`/`absent` for the same part would be replayed as a no-op and the row could
  // never change state twice. The nonce makes each attempt distinct; the account keeps remote ids
  // that collide across accounts from poisoning each other.
  services.store.commit({
    opId: `attachment-${ref.accountId}-${ref.remoteId}-${remotePart}-${state}-${path ?? ''}-${nonce(services)}`,
    origin: 'local',
    writes: [
      {
        kind: 'attachmentState',
        accountId: ref.accountId,
        remoteId: ref.remoteId,
        remotePart,
        state,
        ...(path !== undefined ? { path } : {}),
      },
    ],
  });
}

/** The whole stream, or undefined once it exceeds 25 MB, is cancelled, or runs out of total or idle time. */
async function collect(
  services: EngineServices,
  chunks: AsyncIterable<Uint8Array>,
  total: Deadline,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const iterator = chunks[Symbol.asyncIterator]();
  const parts: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    for (;;) {
      const idle = deadline(services.clock, IDLE_MS, signal);
      let step: IteratorResult<Uint8Array> | undefined;
      try {
        step = await within(within(iterator.next(), idle), total);
      } finally {
        idle.end();
      }
      if (!step) return undefined;
      if (step.done) {
        done = true;
        const out = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          out.set(part, offset);
          offset += part.byteLength;
        }
        return out;
      }
      if (!(step.value instanceof Uint8Array)) return undefined;
      size += step.value.byteLength;
      if (size > MAX_BYTES) throw tooLarge();
      parts.push(step.value);
    }
  } finally {
    if (!done)
      try {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // A `return` that throws has stopped as far as we can tell.
      }
  }
}

/** The provider fetch shared by every concurrent `Attachment/get` for this part: fetch, cache, commit `present`. */
async function fetchPart(
  services: EngineServices,
  files: NonNullable<EngineServices['attachmentFiles']>,
  ref: MessageRef,
  row: PartRow,
  signal: AbortSignal,
): Promise<{ path: string; size: number }> {
  stateCommit(services, ref, row.remote_part, 'fetching');
  // One budget for the whole fetch — open, collect and cache-write share the same 120 s total.
  const total = deadline(services.clock, TOTAL_MS, signal);
  try {
    const chunks = await within(
      services.accounts.attachment(ref.accountId, {
        remoteMessageId: ref.remoteId,
        part: row.remote_part,
      }),
      total,
    );
    if (!chunks) throw unavailable();
    const bytes = await collect(services, chunks, total, signal);
    if (!bytes) throw unavailable();
    const path = await within(
      files.write(ref.accountId, ref.remoteId, row.remote_part, bytes),
      total,
    );
    if (!path) throw unavailable();
    try {
      stateCommit(services, ref, row.remote_part, 'present', path);
    } catch (error) {
      // The row went away under us (message deleted or the parts re-listed): nothing may name the
      // fresh file, so it is removed rather than orphaned, and the caller sees notFound, not a raw
      // store error.
      // Only a row that is genuinely gone (message deleted, parts re-listed) maps to notFound and
      // un-orphans the file; any other store error propagates as what it is.
      if (error instanceof StoreError && error.code === 'notFound') {
        await files.remove(path).catch(() => undefined);
        throw notFound();
      }
      throw error;
    }
    return { path, size: bytes.byteLength };
  } catch (error) {
    try {
      stateCommit(services, ref, row.remote_part, 'absent');
    } catch {
      // The row may be gone itself; either way nothing sticks `fetching`.
    }
    throw error;
  } finally {
    total.end();
  }
}

/** The caller's own blob handle onto the cached file, with the sender's declared (cleaned) type and name. */
function handle(
  ctx: MethodContext,
  row: PartRow,
  path: string,
  size: number,
): Output<'Attachment/get'> {
  const mime = cleanMime(row.mime ?? undefined);
  const name = cleanName(row.name ?? undefined) ?? 'attachment';
  const { blobId } = ctx.services.blobs.attach({
    caller: ctx.caller,
    connectionId: ctx.connectionId,
    path,
    mime,
    name,
    size,
  });
  return { blobId, name, mime, size };
}

export async function attachmentGet(
  args: Input<'Attachment/get'>,
  ctx: MethodContext,
): Promise<Output<'Attachment/get'>> {
  const { services } = ctx;
  const files = services.attachmentFiles;
  if (!files) throw unavailable('This part of Aplos is not running yet.');
  const ref = requireMessage(services, args.messageId);
  const row = partRow(services, ref, args.attachmentId);
  if (!row) throw notFound();

  // Cache hit: the file behind a `present` row answers without a provider round-trip (a file that was
  // evicted behind our back falls through and is fetched again).
  if (row.state === 'present' && row.path !== null) {
    const bytes = await files.read(row.path);
    if (bytes) return handle(ctx, row, row.path, bytes.byteLength);
  }

  // Ids are opaque (a remote id or part may itself hold ':'): JSON keeps the shared-fetch key unambiguous.
  const key = JSON.stringify([ref.accountId, ref.remoteId, row.remote_part]);
  const shared = services.mailFrames.parts.get(key);
  if (shared === undefined) {
    const count = services.mailFrames.fetching.get(ref.accountId) ?? 0;
    const global = [...services.mailFrames.fetching.values()].reduce((a, b) => a + b, 0);
    if (count >= PER_ACCOUNT || global >= GLOBAL) throw busy();
    services.mailFrames.fetching.set(ref.accountId, count + 1);
    // The shared fetch answers to the lane's signal: no caller can kill it for joined callers, and
    // `stop()` aborts + awaits it while the store is still open, so its `absent` revert always
    // commits. Each caller's own signal governs only its wait below.
    const work = fetchPart(services, files, ref, row, services.mailFrames.aborter.signal).finally(
      () => {
        services.mailFrames.parts.delete(key);
        const left = (services.mailFrames.fetching.get(ref.accountId) ?? 1) - 1;
        if (left > 0) services.mailFrames.fetching.set(ref.accountId, left);
        else services.mailFrames.fetching.delete(ref.accountId);
      },
    );
    services.mailFrames.parts.set(key, work);
  }
  const mine = deadline(services.clock, TOTAL_MS + 1000, ctx.signal);
  let done: { path: string; size: number } | undefined;
  try {
    done = await within(services.mailFrames.parts.get(key)!, mine);
  } finally {
    mine.end();
  }
  if (!done) throw unavailable();
  return handle(ctx, row, done.path, done.size);
}
