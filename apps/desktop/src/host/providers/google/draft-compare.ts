/**
 * Whether two draft MIME byte strings are the same message (used by the create lookup in `drafts.ts`). The engine
 * rebuilds the MIME on every attempt with fresh random multipart boundaries, so the same revision and Message-ID give
 * different bytes. Equal here means: line endings normalised, and every multipart boundary (the `boundary` parameter of
 * a part's own Content-Type header and the `--<boundary>` / `--<boundary>--` delimiter lines that match it) replaced by
 * a fixed token per nesting depth. Text that merely looks like a boundary is never touched. Everything else is compared
 * byte for byte.
 */

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
