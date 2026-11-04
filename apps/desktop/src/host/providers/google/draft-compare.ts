/**
 * Whether two draft MIME byte strings are the same message (used by the create lookup in `drafts.ts`). The engine
 * rebuilds the MIME on every attempt with fresh random multipart boundaries, so the same revision and Message-ID give
 * different bytes. Equal here means: line endings normalised, and every multipart boundary (the `boundary` parameter of
 * a part's own Content-Type header and the `--<boundary>` / `--<boundary>--` delimiter lines that match it) replaced by
 * a fixed token per nesting depth. Text that merely looks like a boundary is never touched. Everything else is compared
 * byte for byte.
 */

import { createHash } from 'node:crypto';

const LINE_ENDINGS = /\r\n?|\n/g;

export function sameDraftBytes(a: Uint8Array, b: Uint8Array): boolean {
  return canonicalMime(a) === canonicalMime(b);
}

export function canonicalMime(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('latin1').replace(LINE_ENDINGS, '\n');
  return canonicalPart(text, 1);
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

/** The Message-ID header of raw MIME bytes (unfolded, trimmed), or undefined when the header block has none. */
export function rawMessageId(bytes: Uint8Array): string | undefined {
  const text = Buffer.from(bytes).toString('latin1').replace(LINE_ENDINGS, '\n');
  const split = text.indexOf('\n\n');
  const head = (split < 0 ? text : text.slice(0, split)).replace(/\n[ \t]+/g, ' ');
  for (const line of head.split('\n')) {
    const match = /^message-id:\s*(.*)$/i.exec(line);
    if (match) return match[1].trim() || undefined;
  }
  return undefined;
}

/** SHA-256 of the canonical form (`canonicalMime`): equal for the same upload under fresh boundaries. */
export function draftHash(bytes: Uint8Array): string {
  return createHash('sha256').update(canonicalMime(bytes), 'latin1').digest('hex');
}

const bare = (id: string): string => id.trim().replace(/^<|>$/g, '').toLowerCase();
/** Uploads remembered per draft. */
const PER_DRAFT = 5;
/** Drafts remembered; the least recently written is forgotten first. */
const DRAFTS = 100;

/**
 * What this adapter itself uploaded (or is about to upload) for a draft, in process memory: the Message-ID and the
 * canonical hash of each attempt, the last `PER_DRAFT` per draft. It is how a create that is offered earlier Message-IDs
 * (`DraftUpload.supersedes`) can prove that a copy it finds holds exactly the bytes we wrote and nobody edited since.
 * `saveDraft` has no way to write `provider_memory`, so this is lost on a restart; with nothing remembered, no copy is
 * ever provably ours and the create answers `conflict` and writes nothing (safe, never a replace).
 */
export class DraftAttempts {
  private readonly byDraft = new Map<string, { internetId: string; hash: string }[]>();

  /** Remember an attempt. Call it BEFORE the request that may write these bytes goes out. */
  record(draftId: string, internetId: string, bytes: Uint8Array): void {
    const entry = { internetId: bare(internetId), hash: draftHash(bytes) };
    const known = (this.byDraft.get(draftId) ?? []).filter(
      e => e.internetId !== entry.internetId || e.hash !== entry.hash,
    );
    this.byDraft.delete(draftId);
    this.byDraft.set(draftId, [...known, entry].slice(-PER_DRAFT));
    for (const oldest of [...this.byDraft.keys()].slice(0, Math.max(0, this.byDraft.size - DRAFTS)))
      this.byDraft.delete(oldest);
  }

  /** Whether `bytes` canonicalise to an attempt recorded for `draftId` under exactly this Message-ID. */
  wrote(draftId: string, internetId: string, bytes: Uint8Array): boolean {
    const hash = draftHash(bytes);
    const id = bare(internetId);
    return (this.byDraft.get(draftId) ?? []).some(e => e.internetId === id && e.hash === hash);
  }
}
