/**
 * Whether a stored draft copy holds the content of an upload (used by the create lookup in `drafts.ts`). The engine
 * rebuilds the MIME on every attempt with fresh random multipart boundaries, so the same revision and Message-ID give
 * different bytes. Equal here means: line endings normalised, every multipart boundary (the `boundary` parameter of a
 * part's own Content-Type header and the `--<boundary>` / `--<boundary>--` delimiter lines that match it) replaced by a
 * fixed token per nesting depth, and the two IDENTITY headers of the top header block left out: `Message-ID` (Gmail
 * replaces it on every API save) and `X-Aplos-Draft` (the token the adapter adds to what it uploads, `draft-token.ts`).
 * Text that merely looks like a boundary is never touched, no other header is left out, and everything else is
 * compared byte for byte. The identity is compared on its own (`rawIdentity`): a caller that needs "this copy is
 * ours" checks the identity AND the content. A copy without a token (made before the token, or Gmail dropped it)
 * compares equal to the same bytes with one.
 */

import { createHash } from 'node:crypto';
import { DRAFT_TOKEN_HEADER, identityOf, type NamedHeader } from './draft-token';

const LINE_ENDINGS = /\r\n?|\n/g;
const IDENTITY_HEADERS: ReadonlySet<string> = new Set([
  'message-id',
  DRAFT_TOKEN_HEADER.toLowerCase(),
]);

/** Whether `a` and `b` hold the same content (identity headers left out, see the file header). */
export function sameDraftContent(a: Uint8Array, b: Uint8Array): boolean {
  return draftContent(a) === draftContent(b);
}

/** The canonical form with boundaries blanked; every header kept. */
export function canonicalMime(bytes: Uint8Array): string {
  return canonicalPart(normalised(bytes), 1);
}

/** The canonical form with boundaries blanked and the top-level identity headers left out. */
export function draftContent(bytes: Uint8Array): string {
  return canonicalPart(withoutIdentity(normalised(bytes)), 1);
}

const normalised = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('latin1').replace(LINE_ENDINGS, '\n');

/** The header block and the rest (the blank line and the body), of text with `\n` line ends. */
function splitHead(text: string): { head: string; rest: string } {
  if (text.startsWith('\n')) return { head: '', rest: text };
  const split = text.indexOf('\n\n');
  return split < 0
    ? { head: text, rest: '' }
    : { head: text.slice(0, split), rest: text.slice(split) };
}

/** The text without the top-level identity headers (folded continuation lines included). */
function withoutIdentity(text: string): string {
  const { head, rest } = splitHead(text);
  const kept: string[] = [];
  let dropping = false;
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line)) {
      if (!dropping) kept.push(line);
      continue;
    }
    const colon = line.indexOf(':');
    dropping = colon > 0 && IDENTITY_HEADERS.has(line.slice(0, colon).trim().toLowerCase());
    if (!dropping) kept.push(line);
  }
  return kept.join('\n') + rest;
}

/** The top header block of raw bytes as name/value pairs, unfolded. */
function rawHeaders(bytes: Uint8Array): NamedHeader[] {
  const head = splitHead(normalised(bytes)).head.replace(/\n[ \t]+/g, ' ');
  const headers: NamedHeader[] = [];
  for (const line of head.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1) });
  }
  return headers;
}

/** The identity of raw MIME bytes (`draft-token.ts` `identityOf`): the token, else the Message-ID header. */
export function rawIdentity(bytes: Uint8Array): string | undefined {
  return identityOf(rawHeaders(bytes));
}

const token = (depth: number): string => `=_boundary_${depth}`;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The boundary a part's own headers declare, or undefined when the part is not a multipart. */
function boundaryOf(head: string): string | undefined {
  const unfolded = head.replace(/\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\n')) {
    if (!/^content-type:\s*multipart\//i.test(line)) continue;
    const match = /;\s*boundary=(?:"([^"]*)"|([^\s;"]+))/i.exec(line);
    return match?.[1] ?? match?.[2];
  }
  return undefined;
}

/** One entity (headers, a blank line, a body) with the boundaries of it and of the parts below it blanked. */
function canonicalPart(text: string, depth: number): string {
  const split = text.startsWith('\n') ? 0 : text.indexOf('\n\n');
  if (split < 0) return text;
  const head = text.slice(0, split);
  const body = text.slice(split + 1 + (split === 0 ? 0 : 1));
  const boundary = boundaryOf(head);
  if (!boundary) return text;
  const declared = new RegExp(`(boundary=)("?)${escaped(boundary)}\\2`, 'i');
  const blankHead = head.replace(declared, `$1"${token(depth)}"`);
  return `${blankHead}\n${split === 0 ? '' : '\n'}${blankedBody(body, boundary, depth)}`;
}

function blankedBody(body: string, boundary: string, depth: number): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let part: string[] | undefined;
  const flush = (): void => {
    if (part) out.push(canonicalPart(part.join('\n'), depth + 1));
    part = undefined;
  };
  for (const line of lines) {
    const delimiter = line.replace(/[ \t]+$/, '');
    if (delimiter === `--${boundary}`) {
      flush();
      out.push(`--${token(depth)}`);
      part = [];
    } else if (delimiter === `--${boundary}--`) {
      flush();
      out.push(`--${token(depth)}--`);
    } else if (part) {
      part.push(line);
    } else {
      out.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/** SHA-256 of the content (`draftContent`): equal for the same upload under fresh boundaries, with or without a token. */
export function draftHash(bytes: Uint8Array): string {
  return createHash('sha256').update(draftContent(bytes), 'latin1').digest('hex');
}

const bare = (id: string): string => id.trim().replace(/^<|>$/g, '').toLowerCase();
/** Uploads remembered per draft. */
const PER_DRAFT = 5;
/** Drafts remembered; the least recently written is forgotten first. */
const DRAFTS = 100;

/**
 * What this adapter itself uploaded (or is about to upload) for a draft, in process memory: the Message-ID and the
 * content hash (`draftHash`, identity headers left out, so the key IS the identity) of each attempt, the last `PER_DRAFT` per draft. It is how a create that is offered earlier Message-IDs
 * (`DraftUpload.supersedes`) can prove that a copy it finds holds exactly the bytes we wrote and nobody edited since.
 * `saveDraft` has no way to write `provider_memory`, so this is lost on a restart; with nothing remembered, no copy is
 * ever provably ours and the create answers `conflict` and writes nothing (safe, never a replace).
 */
export class DraftAttempts {
  private readonly byDraft = new Map<
    string,
    { internetId: string; hash: string; landed: boolean }[]
  >();

  /**
   * Remember an attempt. Call it BEFORE the request that may write these bytes goes out: the bytes are the proof an
   * earlier copy needs (`wrote`), whether or not the request lands. It says nothing yet about whether it did: see
   * `markMayHaveLanded`.
   */
  record(draftId: string, internetId: string, bytes: Uint8Array): void {
    const entry = { internetId: bare(internetId), hash: draftHash(bytes), landed: false };
    const same = (this.byDraft.get(draftId) ?? []).filter(
      e => e.internetId === entry.internetId && e.hash === entry.hash,
    );
    // Recording the same attempt again must not forget that an earlier request of it may have landed.
    entry.landed = same.some(e => e.landed);
    const known = (this.byDraft.get(draftId) ?? []).filter(e => !same.includes(e));
    this.byDraft.delete(draftId);
    this.byDraft.set(draftId, [...known, entry].slice(-PER_DRAFT));
    for (const oldest of [...this.byDraft.keys()].slice(0, Math.max(0, this.byDraft.size - DRAFTS)))
      this.byDraft.delete(oldest);
  }

  /**
   * The request of an attempt under this Message-ID ended in a way that leaves a copy behind or leaves it unknown: it
   * was answered (the copy exists), or it failed uncertainly (it may have landed). A definite refusal (429, 503 before
   * anything was written) does NOT call this, so a retry of that revision stays on the cheap lookups.
   */
  markMayHaveLanded(draftId: string, internetId: string): void {
    const id = bare(internetId);
    for (const e of this.byDraft.get(draftId) ?? []) if (e.internetId === id) e.landed = true;
  }

  /** Whether a request recorded for `draftId` under this Message-ID may have landed (`markMayHaveLanded`). */
  mayHaveLanded(draftId: string, internetId: string): boolean {
    const id = bare(internetId);
    return (this.byDraft.get(draftId) ?? []).some(e => e.internetId === id && e.landed);
  }

  /** Whether `bytes` canonicalise to an attempt recorded for `draftId` under exactly this Message-ID. */
  wrote(draftId: string, internetId: string, bytes: Uint8Array): boolean {
    const hash = draftHash(bytes);
    const id = bare(internetId);
    return (this.byDraft.get(draftId) ?? []).some(e => e.internetId === id && e.hash === hash);
  }
}
