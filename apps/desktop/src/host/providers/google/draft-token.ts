/**
 * The identity a Gmail draft copy carries (live finding 2026-11-04, plans/engine/draft-identity.md item 3). Gmail gives
 * every draft it saves through the API its own `<...@mail.gmail.com>` Message-ID, so the per-revision Message-ID the
 * engine writes (`DraftUpload.internetId`) does not survive on a draft. A custom header does: the adapter writes
 * `X-Aplos-Draft: <DraftUpload.internetId>` into every draft it uploads, and every read of a draft reports the copy's
 * identity as that header's value when it is present exactly once and well-formed, else as the Message-ID header the
 * copy shows (as before). The engine treats the identity as opaque, so its keyed paths work unchanged.
 *
 * The header is only a way to FIND a copy and to name it: it proves nothing alone. A phone can copy it, anyone with the
 * mailbox can forge it. Every adoption or replace still needs the content proof (`draft-compare.ts`, `drafts.ts`).
 */

/** The header name, as written. */
export const DRAFT_TOKEN_HEADER = 'X-Aplos-Draft';

/**
 * A well-formed token: exactly one `<local@domain>` Message-ID-shaped value with no space, quote, bracket or other
 * character that Gmail search or a header parser could read differently. Anything else is ignored (not an identity).
 */
const TOKEN_SHAPE = /^<[A-Za-z0-9.!#$%&'*+/=?^_`~-]{1,256}@[A-Za-z0-9.-]{1,253}>$/;

export const isDraftToken = (value: string): boolean => TOKEN_SHAPE.test(value);

/** A header as Gmail's JSON lists it (`payload.headers`), or as parsed from raw bytes. */
export interface NamedHeader {
  name?: unknown;
  value?: unknown;
}

function valuesOf(headers: readonly NamedHeader[] | undefined, name: string): string[] {
  const wanted = name.toLowerCase();
  return (headers ?? [])
    .filter(h => typeof h.name === 'string' && h.name.toLowerCase() === wanted)
    .map(h => (typeof h.value === 'string' ? h.value.trim() : ''));
}

/** The token when the headers carry exactly one well-formed `X-Aplos-Draft`; otherwise undefined. */
export function tokenOf(headers: readonly NamedHeader[] | undefined): string | undefined {
  const tokens = valuesOf(headers, DRAFT_TOKEN_HEADER);
  return tokens.length === 1 && isDraftToken(tokens[0]) ? tokens[0] : undefined;
}

/** The first Message-ID header, trimmed; undefined when there is none or it is empty. */
export function shownMessageId(headers: readonly NamedHeader[] | undefined): string | undefined {
  return valuesOf(headers, 'Message-ID')[0] || undefined;
}

/** The copy's identity: the token when there is a well-formed one, else the Message-ID it shows. */
export function identityOf(headers: readonly NamedHeader[] | undefined): string | undefined {
  return tokenOf(headers) ?? shownMessageId(headers);
}

/**
 * The bytes the adapter uploads for a draft: the engine's MIME with `X-Aplos-Draft: <internetId>` as the first header.
 * Nothing else changes. An `internetId` that is not a well-formed token is uploaded without one (it could never be
 * read back as an identity); the engine always writes `<hex@domain>`.
 */
export function withDraftToken(draft: { internetId: string; mime: Uint8Array }): Uint8Array {
  if (!isDraftToken(draft.internetId)) return draft.mime;
  const line = Buffer.from(`${DRAFT_TOKEN_HEADER}: ${draft.internetId}\r\n`, 'latin1');
  return Buffer.concat([line, draft.mime]);
}
