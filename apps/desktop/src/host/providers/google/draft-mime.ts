import { ProviderError, type DraftUpload } from '@aplos/engine/ports';
import { headerEnd, headerFields, singleFields } from './mime-headers';

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

/** Names refused with their own reason before the allow-list is asked (`singleFields`, field order). */
const DRAFT_NAMED: ReadonlyMap<string, string> = new Map([['bcc', 'bccInDraft']]);

function refuse(method: string, reason: string): ProviderError {
  return new ProviderError({
    class: 'permanent',
    provider: 'gmail',
    method,
    reason,
    uncertain: false,
  });
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
  const deny = (reason: string) => refuse(method, reason);
  const byName = singleFields(headerFields(head, deny), DRAFT_HEADERS, deny, DRAFT_NAMED);
  if (byName.get('message-id') !== draft.internetId) throw refuse(method, 'messageIdMismatch');
  const token = byName.get('x-aplos-draft');
  if (token !== undefined && token !== draft.internetId) throw refuse(method, 'draftTokenMismatch');
}
