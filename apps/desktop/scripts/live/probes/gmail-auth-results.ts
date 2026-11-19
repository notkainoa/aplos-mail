import { parseAddresses } from '../../../src/host/providers/google/facts';
import {
  fromDomain,
  GOOGLE_AUTHSERV_ID,
  googleResults,
  listAuthenticated,
  tokenize,
} from '../../../src/host/providers/google/list-auth';
import type { GmailHeader } from '../../../src/host/providers/google/mime';
import { emptyResult, type ProbeContext, type ProbeResult, type SmokeProbe } from '../types';
import { getJson, ProbeHttpError } from './http';

/**
 * Tier R probe `gmail.auth-results-shape`: does real Gmail write `Authentication-Results` the way the #180 parser
 * assumes (assumption (c): one unbroken dkim run first, then arc, spf, dmarc; no quotes; `header.b` of 8 characters)?
 * It reads up to 200 recent Inbox messages as metadata and keeps ONLY structure counts, never a header value, an address
 * or an id. The verdict counts come from the real `list-auth.ts`, fed the same headers the app's sync would see.
 */

const SAMPLE = 200;
const MESSAGE_ID = /^[0-9a-f]{1,16}$/i;
/** The headers the app's own `listAuthenticated` reads. */
const HEADERS = [
  'Authentication-Results',
  'DKIM-Signature',
  'List-Unsubscribe',
  'List-Unsubscribe-Post',
  'From',
];
/** Google writes its results in this order: dkim run, then arc, spf, dmarc. */
const EXPECTED_ORDER = ['dkim', 'arc', 'spf', 'dmarc'];

/** Evidence count names this probe uses (each must also be in `COUNT_KEYS`). */
export const AUTH_SHAPE_KEYS = [
  'messagesSampled',
  'withAuthResults',
  'withoutAuthResults',
  'severalAuthResults',
  'googleParsed',
  'notGoogleOrMalformed',
  'notTokenizable',
  'foreignAuthservId',
  'shapeExpected',
  'shapeUnexpected',
  'arcBeforeDkim',
  'spfBeforeDkim',
  'dmarcBeforeSpf',
  'withDara',
  'withUnknownMethod',
  'noDkimResult',
  'severalDkimResults',
  'dkimResultsMax',
  'headerBMin',
  'headerBMax',
  'headerBNotEight',
  'dkimNoHeaderB',
  'withQuote',
  'withNestedParens',
  'commentsMax',
  'withListUnsubscribe',
  'withListUnsubscribePost',
  'authTrue',
  'authFalse',
  'authUnknown',
  'authNotJudged',
  'falseNotGoogle',
  'falseNoListPair',
  'falseNoFromDomain',
  'falseOther',
] as const;

type Shape = Record<(typeof AUTH_SHAPE_KEYS)[number], number>;

export function emptyShape(): Shape {
  return Object.fromEntries(AUTH_SHAPE_KEYS.map(key => [key, 0])) as Shape;
}

const named = (headers: readonly GmailHeader[], name: string): GmailHeader[] =>
  headers.filter(h => h.name.toLowerCase() === name);

/** Parenthesis groups and their deepest nesting in a header value; a backslash escapes the next character. */
function commentShape(value: string): { groups: number; depth: number } {
  let depth = 0;
  let deepest = 0;
  let groups = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\') i++;
    else if (c === '(') {
      if (depth === 0) groups++;
      depth++;
      deepest = Math.max(deepest, depth);
    } else if (c === ')' && depth > 0) depth--;
  }
  return { groups, depth: deepest };
}

/** Collapses a method list to the order of its kinds: dkim, dkim, spf -> dkim, spf. */
function kindsInOrder(methods: readonly string[]): string[] {
  return methods.filter((method, i) => i === 0 || methods[i - 1] !== method);
}

function orderShape(kinds: readonly string[], into: Shape): void {
  const known = kinds.filter(kind => EXPECTED_ORDER.includes(kind));
  const ranks = known.map(kind => EXPECTED_ORDER.indexOf(kind));
  const inOrder = ranks.every((rank, i) => i === 0 || ranks[i - 1] < rank);
  if (inOrder) into.shapeExpected++;
  else into.shapeUnexpected++;
  const first = (kind: string) => kinds.indexOf(kind);
  const before = (a: string, b: string) =>
    first(a) !== -1 && first(b) !== -1 && first(a) < first(b);
  if (before('arc', 'dkim')) into.arcBeforeDkim++;
  if (before('spf', 'dkim')) into.spfBeforeDkim++;
  if (before('dmarc', 'spf')) into.dmarcBeforeSpf++;
  if (kinds.includes('dara')) into.withDara++;
  if (kinds.some(kind => kind !== 'dara' && !EXPECTED_ORDER.includes(kind)))
    into.withUnknownMethod++;
}

interface LooseResult {
  method: string;
  props: Map<string, string>;
}

/**
 * Method kinds and properties of a header read as loosely as possible (no Google check, no refusal of an odd order), so
 * the order Google really writes is seen even where the strict parser would refuse the header. Undefined when the value
 * cannot be tokenized or its authserv-id is not Google's.
 */
function looseResults(value: string, into: Shape): LooseResult[] | undefined {
  const tokens = tokenize(value);
  if (!tokens) {
    into.notTokenizable++;
    return undefined;
  }
  const segments: (typeof tokens)[] = [[]];
  for (const token of tokens) {
    if (token.kind === 'semi') segments.push([]);
    else segments[segments.length - 1].push(token);
  }
  const head = segments[0][0];
  if (head?.kind !== 'word' || head.text.toLowerCase() !== GOOGLE_AUTHSERV_ID) {
    into.foreignAuthservId++;
    return undefined;
  }
  return segments
    .slice(1)
    .filter(segment => segment.length > 0)
    .map(segment => {
      const words = segment.filter(t => t.kind === 'word').map(t => (t as { text: string }).text);
      const props = new Map<string, string>();
      // `method=result prop=value prop=value`: words alternate key, value around the `=` tokens.
      for (let i = 2; i + 1 < words.length; i += 2) props.set(words[i].toLowerCase(), words[i + 1]);
      return { method: (words[0] ?? '').toLowerCase().split('/')[0], props };
    });
}

function parsedShape(value: string, into: Shape): void {
  if (googleResults(value)) into.googleParsed++;
  else into.notGoogleOrMalformed++;
  const results = looseResults(value, into);
  if (!results) return;
  orderShape(kindsInOrder(results.map(r => r.method)), into);
  const dkim = results.filter(r => r.method === 'dkim');
  if (dkim.length === 0) into.noDkimResult++;
  if (dkim.length > 1) into.severalDkimResults++;
  into.dkimResultsMax = Math.max(into.dkimResultsMax, dkim.length);
  const lengths = dkim.map(r => r.props.get('header.b')?.length);
  if (lengths.some(length => length === undefined)) into.dkimNoHeaderB++;
  const seen = lengths.filter((length): length is number => length !== undefined);
  if (seen.some(length => length !== 8)) into.headerBNotEight++;
  for (const length of seen) {
    into.headerBMax = Math.max(into.headerBMax, length);
    into.headerBMin = into.headerBMin === 0 ? length : Math.min(into.headerBMin, length);
  }
}

function verdictShape(headers: readonly GmailHeader[], into: Shape): void {
  const unsubscribe = named(headers, 'list-unsubscribe').length;
  const post = named(headers, 'list-unsubscribe-post').length;
  if (unsubscribe > 0) into.withListUnsubscribe++;
  if (post > 0) into.withListUnsubscribePost++;
  // The app judges only mail that carries List-Unsubscribe (facts.ts).
  if (unsubscribe === 0) {
    into.authNotJudged++;
    return;
  }
  const from = parseAddresses(named(headers, 'from')[0]?.value);
  const verdict = listAuthenticated(headers, from);
  if (verdict === undefined) into.authUnknown++;
  else if (verdict) into.authTrue++;
  else {
    into.authFalse++;
    const top = named(headers, 'authentication-results')[0];
    if (top && googleResults(top.value) === null) into.falseNotGoogle++;
    else if (unsubscribe !== 1 || post !== 1) into.falseNoListPair++;
    else if (fromDomain(headers, from) === undefined) into.falseNoFromDomain++;
    else into.falseOther++;
  }
}

/** Adds one message's headers to `into`. Values are read here and dropped; only counts leave. */
export function addMessageShape(headers: readonly GmailHeader[], into: Shape): void {
  into.messagesSampled++;
  const results = named(headers, 'authentication-results');
  if (results.length === 0) into.withoutAuthResults++;
  else {
    into.withAuthResults++;
    if (results.length > 1) into.severalAuthResults++;
    const top = results[0].value;
    if (top.includes('"')) into.withQuote++;
    const comments = commentShape(top);
    if (comments.depth > 1) into.withNestedParens++;
    into.commentsMax = Math.max(into.commentsMax, comments.groups);
    parsedShape(top, into);
  }
  verdictShape(headers, into);
}

function failed(error: unknown, result: ProbeResult): void {
  const errorClass = error instanceof ProbeHttpError ? error.errorClass : 'other';
  result.status = 'fail';
  result.errorClasses[errorClass] = (result.errorClasses[errorClass] ?? 0) + 1;
}

const STOPPING = new Set(['rate-limit', 'quota', 'auth']);

/** The headers of a metadata reply, or undefined when it is not shaped like one. */
function headersOf(json: Record<string, unknown>): GmailHeader[] | undefined {
  const payload = json.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const list = (payload as { headers?: unknown }).headers;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (h): h is GmailHeader =>
      typeof h === 'object' &&
      h !== null &&
      typeof (h as GmailHeader).name === 'string' &&
      typeof (h as GmailHeader).value === 'string',
  );
}

export const authResultsShape: SmokeProbe = {
  id: 'gmail.auth-results-shape',
  provider: 'gmail',
  tier: 'R',
  async run(ctx: ProbeContext): Promise<ProbeResult> {
    const result = emptyResult();
    const started = ctx.now();
    const shape = emptyShape();
    let fetchTotal = 0;
    let slowest = 0;
    try {
      const list = await getJson(ctx, '/messages', {
        labelIds: 'INBOX',
        maxResults: String(SAMPLE),
        fields: 'messages(id)',
      });
      result.timingsMs.list = list.ms;
      result.counts.emptyAnswers = list.empty ? 1 : 0;
      const ids = (Array.isArray(list.json.messages) ? list.json.messages : [])
        .map((m: { id?: unknown }) => String(m.id))
        .slice(0, SAMPLE);
      for (const id of ids) {
        if (!MESSAGE_ID.test(id)) {
          failed(new Error('id'), result);
          continue;
        }
        try {
          const reply = await getJson(ctx, `/messages/${id}`, {
            format: 'metadata',
            metadataHeaders: HEADERS,
            fields: 'payload(headers(name,value))',
          });
          fetchTotal += reply.ms;
          slowest = Math.max(slowest, reply.ms);
          addMessageShape(headersOf(reply.json) ?? [], shape);
        } catch (error) {
          failed(error, result);
          if (error instanceof ProbeHttpError && STOPPING.has(error.errorClass)) break;
        }
      }
    } catch (error) {
      failed(error, result);
    }
    for (const key of AUTH_SHAPE_KEYS) result.counts[key] = shape[key];
    result.timingsMs.fetchTotal = fetchTotal;
    result.timingsMs.fetchMax = slowest;
    result.timingsMs.total = ctx.now() - started;
    return result;
  },
};
