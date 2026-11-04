/**
 * The header-block parsing behind the upload guards (`send.ts` `pinnedMime`, `draft-mime.ts` `checkDraftMime`). The
 * top header block may hold only the headers the writer produces, each at most once, with CRLF line ends and no
 * control bytes: a CR or LF that slipped into a value would show up exactly as a new header line (`Bcc:`, `Reply-To:`),
 * and nothing here could tell that from a real one. Every refusal goes through the caller's `refuse`, so each guard
 * keeps its own error type and method name.
 */

/** One header line of the top block, unfolded: lower-cased name and the raw value after the colon. */
export interface HeaderField {
  name: string;
  value: string;
}

/** Builds the caller's refusal for a reason string; the guard throws what it returns. */
export type Refuse = (reason: string) => Error;

/** Offset of the CRLF CRLF that ends the header block, or -1. */
export function headerEnd(mime: Uint8Array): number {
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

/** Every line ends in CRLF; a lone CR or LF, NUL or another control byte is a header the writer never made. */
function checkBytes(head: string, refuse: Refuse): void {
  const joined = head.replace(/\r\n/g, '');
  if (/[\r\n]/.test(joined)) throw refuse('bareLineBreak');
  if ([...joined].some(isControl)) throw refuse('controlCharacter');
}

/** Unfolds the header block into fields; a line that is neither `Name: value` nor a continuation is refused. */
export function headerFields(head: string, refuse: Refuse): HeaderField[] {
  checkBytes(head, refuse);
  const fields: HeaderField[] = [];
  for (const line of head.split('\r\n')) {
    const last = fields[fields.length - 1];
    if (/^[ \t]/.test(line)) {
      if (!last) throw refuse('malformedHeader');
      last.value += line;
      continue;
    }
    const match = /^([\x21-\x39\x3b-\x7e]+):(.*)$/.exec(line);
    if (!match) throw refuse('malformedHeader');
    fields.push({ name: match[1].toLowerCase(), value: match[2] });
  }
  return fields;
}

/**
 * Each allowed header at most once (RFC 5322 3.6): a second `To:` or `From:` is an injected one. `named` gives a name
 * its own refusal reason before the allow-list is asked (the draft guard refuses `Bcc` as `bccInDraft`), in field
 * order.
 */
export function singleFields(
  fields: HeaderField[],
  allowed: ReadonlySet<string>,
  refuse: Refuse,
  named?: ReadonlyMap<string, string>,
): Map<string, string> {
  const byName = new Map<string, string>();
  for (const field of fields) {
    const reason = named?.get(field.name);
    if (reason !== undefined) throw refuse(reason);
    if (!allowed.has(field.name)) throw refuse('unexpectedHeader');
    if (byName.has(field.name)) throw refuse('duplicateHeader');
    byName.set(field.name, field.value.trim());
  }
  return byName;
}
