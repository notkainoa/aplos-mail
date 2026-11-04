import { ProviderError, type DraftUpload } from '@aplos/engine/ports';

/**
 * The checks on a draft copy's bytes before anything is uploaded (plan 20 PV4, ARCH 7.4). The draft MIME is the
 * engine's `buildMime` output; it is never rewritten here, only refused. A refusal is a `permanent` `ProviderError`
 * thrown before any request, so the draft stays local with a problem and nothing is wasted on a retry.
 *
 * Same discipline as the send transport: the top header block may hold only the headers the writer produces, each at
 * most once, with CRLF line ends and no control bytes. A CR or LF that slipped into a value would show up exactly as a
 * new header line (`Bcc:`, `Reply-To:`), and nothing here could tell that from a real one. `Bcc` is refused by name:
 * a draft copy never carries it (the engine keeps it out, and a provider that sends the copy itself would put it on the
 * wire for every recipient to read). `In-Reply-To` and `References` pass through untouched so replies thread.
 */

/** Gmail's media limit for draft uploads (35 MB). Larger is refused before a request is made. */
export const MAX_DRAFT_BYTES = 35 * 1024 * 1024;

/**
 * The header names the engine's `buildMime` writes at the top of a message (Bcc deliberately absent), plus
 * `x-aplos-draft`, the identity token this adapter adds to every draft it uploads (`draft-token.ts`). The engine's draft
 * MIME and the pinned send MIME never carry it; `send.ts` has its own list without it.
 */
const DRAFT_HEADERS: ReadonlySet<string> = new Set([
  'x-aplos-draft',
  'date',
  'from',
  'to',
  'cc',
  'subject',
  'message-id',
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
]);

function refuse(method: string, reason: string): ProviderError {
  return new ProviderError({
    class: 'permanent',
    provider: 'gmail',
    method,
    reason,
    uncertain: false,
  });
}

/** Offset of the CRLF CRLF that ends the header block, or -1. */
function headerEnd(mime: Uint8Array): number {
  for (let i = 0; i + 3 < mime.length; i++) {
    if (mime[i] === 13 && mime[i + 1] === 10 && mime[i + 2] === 13 && mime[i + 3] === 10) return i;
  }
  return -1;
}

/** C0 controls and DEL, except the tab a folded line may start with. */
function isControl(c: string): boolean {
  const code = c.charCodeAt(0);
  return (code < 0x20 && code !== 0x09) || code === 0x7f;
}

interface HeaderField {
  name: string;
  value: string;
}

function checkBytes(method: string, head: string): void {
  const joined = head.replace(/\r\n/g, '');
  if (/[\r\n]/.test(joined)) throw refuse(method, 'bareLineBreak');
  if ([...joined].some(isControl)) throw refuse(method, 'controlCharacter');
}

/** Unfolds the header block; a line that is neither `Name: value` nor a continuation is refused. */
function headerFields(method: string, head: string): HeaderField[] {
  checkBytes(method, head);
  const fields: HeaderField[] = [];
  for (const line of head.split('\r\n')) {
    const last = fields[fields.length - 1];
    if (/^[ \t]/.test(line)) {
      if (!last) throw refuse(method, 'malformedHeader');
      last.value += line;
      continue;
    }
    const match = /^([\x21-\x39\x3b-\x7e]+):(.*)$/.exec(line);
    if (!match) throw refuse(method, 'malformedHeader');
    fields.push({ name: match[1].toLowerCase(), value: match[2] });
  }
  return fields;
}

/** Each allowed header at most once; Bcc and anything the writer does not produce are refused. */
function singleFields(method: string, fields: HeaderField[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const field of fields) {
    if (field.name === 'bcc') throw refuse(method, 'bccInDraft');
    if (!DRAFT_HEADERS.has(field.name)) throw refuse(method, 'unexpectedHeader');
    if (byName.has(field.name)) throw refuse(method, 'duplicateHeader');
    byName.set(field.name, field.value.trim());
  }
  return byName;
}

/**
 * Throws a `permanent` `ProviderError` (no request made) when the draft's bytes may not be uploaded: over the media
 * limit, a malformed or injected header, Bcc present, a Message-ID that is not the per-revision one the engine named,
 * or an `X-Aplos-Draft` token that is not that same id (an uncertain create is recognised by them). `mime` is what will
 * be uploaded (`withDraftToken`), so the token is checked once, with the size cap on the real upload.
 */
export function checkDraftMime(
  method: string,
  draft: DraftUpload,
  mime: Uint8Array = draft.mime,
): void {
  if (mime.length > MAX_DRAFT_BYTES) throw refuse(method, 'messageTooLarge');
  const end = headerEnd(mime);
  if (end < 0) throw refuse(method, 'noHeaderBlock');
  const head = Buffer.from(mime.subarray(0, end)).toString('latin1');
  const byName = singleFields(method, headerFields(method, head));
  if (byName.get('message-id') !== draft.internetId) throw refuse(method, 'messageIdMismatch');
  const token = byName.get('x-aplos-draft');
  if (token !== undefined && token !== draft.internetId) throw refuse(method, 'draftTokenMismatch');
}
