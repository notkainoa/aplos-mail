// Quoted history in a plain-text body (DESIGN 7.5: O also shows quoted text). The engine marks the quoted ranges
// (`MessageBody.quoted`); a body it sent without any falls back to the mail convention, runs of lines that start with
// `>`. The body splits into the sender's own parts and the quoted parts, so the host can hide the quotes behind "Show
// quoted text" or draw them as a quiet block without the `>` marks. Pure: no DOM, no React.

/** A character range of quoted history in a body's text, `end` exclusive (the contract's shape). */
export interface QuotedRange {
  readonly start: number;
  readonly end: number;
}

/** One run of a body: the sender's own words, or quoted history with its `>` marks taken off. */
export interface BodyPart {
  readonly kind: 'own' | 'quoted';
  readonly text: string;
}

const QUOTE_LINE = /^[ \t]*>/;
const QUOTE_MARK = /^[ \t]*> ?/;

/** The runs of consecutive lines that start with `>`, each from its first line's start to its last line's end. */
export function quotedRangesOf(text: string): QuotedRange[] {
  const ranges: QuotedRange[] = [];
  let at = 0;
  let open: number | null = null;
  let lastEnd = 0;
  for (const line of text.split('\n')) {
    const quoted = QUOTE_LINE.test(line);
    if (quoted && open === null) open = at;
    if (!quoted && open !== null) {
      ranges.push({ start: open, end: lastEnd });
      open = null;
    }
    lastEnd = at + line.length;
    at = lastEnd + 1;
  }
  if (open !== null) ranges.push({ start: open, end: lastEnd });
  return ranges;
}

/** The engine's ranges when it gave any, else the `>` convention's. */
export function quotedRangesFor(text: string, engine: readonly QuotedRange[]): QuotedRange[] {
  return engine.length > 0 ? [...engine] : quotedRangesOf(text);
}

/** Valid, in order and not overlapping, clamped to the text. */
function cleanRanges(ranges: readonly QuotedRange[], length: number): QuotedRange[] {
  const sorted = [...ranges]
    .map(r => ({ start: Math.max(0, r.start), end: Math.min(length, r.end) }))
    .filter(r => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: QuotedRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end)
      out[out.length - 1] = { ...last, end: Math.max(last.end, range.end) };
    else out.push(range);
  }
  return out;
}

/** The quoted text without its first `>` mark on each line. */
function unmarked(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(QUOTE_MARK, ''))
    .join('\n');
}

/** A part without the blank lines around it; null when nothing is left. */
function part(kind: BodyPart['kind'], raw: string): BodyPart | null {
  const text = (kind === 'quoted' ? unmarked(raw) : raw).replace(/^\s*\n/, '').trimEnd();
  return text.trim() === '' ? null : { kind, text };
}

/** The body as own and quoted parts, in order; blank lines between parts are dropped (the host spaces the blocks). */
export function quotedParts(text: string, ranges: readonly QuotedRange[]): BodyPart[] {
  const parts: Array<BodyPart | null> = [];
  let at = 0;
  for (const range of cleanRanges(ranges, text.length)) {
    parts.push(part('own', text.slice(at, range.start)));
    parts.push(part('quoted', text.slice(range.start, range.end)));
    at = range.end;
  }
  parts.push(part('own', text.slice(at)));
  return parts.filter((p): p is BodyPart => p !== null);
}

/** Whether any of the body is the sender's own words. A body that is all quote (a forward) has nothing to fold it under. */
export function hasOwnText(parts: readonly BodyPart[]): boolean {
  return parts.some(part => part.kind === 'own');
}

/** Whether quoted history follows words of the sender's own, so it may be folded away behind "Show quoted text". */
export function foldsQuoted(text: string, ranges: readonly QuotedRange[]): boolean {
  return hasOwnText(quotedParts(text, ranges)) && ranges.length > 0;
}
