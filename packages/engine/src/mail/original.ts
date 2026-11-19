import type { Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { principalOf } from '@aplos/contract/access';
import type { MethodContext } from '../methods/types';
import type { EngineServices } from '../runtime/services';
import { contractError } from '../runtime/errors';
import { BLOB_SENTENCES, cleanName } from '../runtime/blobs';
import { deadline, within } from './deadline';
import { requireMessage } from './message';
import { closeIterator, collectBytes } from './stream';

/**
 * `Message/original` (Blob package 7, blob-area.md decision 13): the message's raw RFC822 for "Show original"
 * and `.eml` export, fetched live through `ProviderPort.original` — never from a store copy, never cached.
 * The optional port is absent until the prov-gov routes it to an adapter that has it (`unavailable` then).
 * The stream is capped at 25 MB under a 120 s total / 30 s idle deadline, then stored as an `original`
 * blob (`message/rfc822`, name = cleaned subject + `.eml`) the caller owns. One fetch serves every joined
 * caller for the same (principal, message), caps run like `Attachment/get`'s, the quota is checked BEFORE
 * the paid provider read, and a repeat opens the live blob it made instead of fetching again.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const TOTAL_MS = 120_000;
const IDLE_MS = 30_000;
const PER_ACCOUNT = 3;
const GLOBAL = 4;

type OriginalResult = { blobId: string; name: string; size: number };

const unavailable = (message = "Couldn't get this message's original. Try again.") =>
  contractError({ type: 'unavailable', message });
const tooLarge = () =>
  contractError({
    type: 'tooLarge',
    message: "This message's original is too large to open in Aplos.",
  });
const busy = () =>
  contractError({
    type: 'unavailable',
    message: 'Aplos is already downloading several originals. Try again in a moment.',
    retryAfterMs: 1000,
  });
const quota = () => contractError({ type: 'tooLarge', message: BLOB_SENTENCES.quota });

/** The one shared fetch for a (principal, message): lane signal only, so no caller's cancel kills it. */
async function fetchOriginal(
  services: EngineServices,
  ctx: MethodContext,
  ref: { accountId: string; remoteId: string; rowId: number },
): Promise<OriginalResult> {
  const lane = services.mailFrames.aborter.signal;
  const total = deadline(services.clock, TOTAL_MS, lane);
  try {
    // The fetch signal is the port's own view of the deadline: the lane's stop or the 120 s total,
    // whichever is first, aborts the adapter's HTTP read rather than leaving it to resolve late.
    const fetchAbort = new AbortController();
    void total.stopped.then(() => fetchAbort.abort());
    let opening: Promise<AsyncIterable<Uint8Array>> | undefined;
    let chunks: AsyncIterable<Uint8Array> | undefined;
    try {
      opening = services.accounts.original!(ref.accountId, ref.remoteId, {
        signal: fetchAbort.signal,
      });
      chunks = await within(opening, total);
    } catch (error) {
      // A provider failure is never the caller's internal: the adapter's own reason stays in the log.
      if (error instanceof ContractError) {
        // A routed port that answers `unavailable` is the same not-wired-yet state as an absent one.
        if (error.type === 'unavailable')
          throw unavailable('This part of Aplos is not running yet.');
        throw error;
      }
      throw unavailable();
    }
    if (!chunks) {
      // The deadline won but the provider may still answer: close its stream the moment it does.
      void opening
        ?.then(c => {
          if (c) closeIterator(c[Symbol.asyncIterator]());
        })
        .catch(() => undefined);
      throw unavailable();
    }
    const bytes = await collectBytes(chunks, MAX_BYTES, total, {
      idle: () => deadline(services.clock, IDLE_MS, lane),
      overLimit: tooLarge,
    }).catch(error => {
      if (error instanceof ContractError) throw error;
      throw unavailable();
    });
    if (!bytes || !bytes.byteLength) throw unavailable();
    const subject = services.store.read(q =>
      q.get<{ subject: string | null }>('SELECT subject FROM messages WHERE id = ?', ref.rowId),
    )?.subject;
    // `line(500)` counts UTF-16 units and `put` re-cleans names to 255 code points: bound both, so
    // the returned name is exactly the stored one and always keeps the `.eml`. A leading-dot base
    // would export a hidden file, so dots are stripped before the bound.
    const base = (cleanName(subject) ?? 'message').replace(/^\.+/, '') || 'message';
    const cps = [...base].slice(0, 251);
    while (cps.join('').length > 496) cps.pop();
    const name = `${cps.join('')}.eml`;
    const { blobId, size } = await services.blobs.put({
      caller: ctx.caller,
      connectionId: ctx.connectionId,
      kind: 'original',
      bytes,
      mime: 'message/rfc822',
      name,
      signal: ctx.signal,
    });
    return { blobId, name, size };
  } finally {
    total.end();
  }
}

export async function messageOriginal(
  args: Input<'Message/original'>,
  ctx: MethodContext,
): Promise<Output<'Message/original'>> {
  const { services } = ctx;
  if (!services.accounts.original) throw unavailable('This part of Aplos is not running yet.');
  const ref = requireMessage(services, args.messageId);
  const key = `${principalOf(ctx.caller)}|${args.messageId}`;
  // A repeat opens the live blob this principal already fetched — a swept or released id refetches.
  const held = services.mailFrames.originalBlobs.get(key);
  if (held) {
    if (services.blobs.touch(ctx.caller, held.blobId)) return held;
    services.mailFrames.originalBlobs.delete(key);
  }
  // A fetch already running for this (principal, message): wait on it with the caller's own timer.
  let work = services.mailFrames.originals.get(key);
  if (!work) {
    // Starters only: concurrency caps, then the quota pre-check so a refusal wastes no provider read.
    const count = services.mailFrames.fetching.get(ref.accountId) ?? 0;
    const global = [...services.mailFrames.fetching.values()].reduce((a, b) => a + b, 0);
    if (count >= PER_ACCOUNT || global >= GLOBAL) throw busy();
    if (!services.blobs.fits(ctx.caller, MAX_BYTES)) throw quota();
    services.mailFrames.fetching.set(ref.accountId, count + 1);
    work = fetchOriginal(services, ctx, ref)
      .then(done => {
        services.mailFrames.originalBlobs.set(key, done);
        return done;
      })
      .finally(() => {
        services.mailFrames.originals.delete(key);
        const now = (services.mailFrames.fetching.get(ref.accountId) ?? 1) - 1;
        if (now <= 0) services.mailFrames.fetching.delete(ref.accountId);
        else services.mailFrames.fetching.set(ref.accountId, now);
      });
    services.mailFrames.originals.set(key, work);
  }
  const mine = deadline(services.clock, TOTAL_MS + 1000, ctx.signal);
  try {
    const done = await within(work, mine);
    if (!done) throw unavailable();
    return done;
  } finally {
    mine.end();
  }
}
