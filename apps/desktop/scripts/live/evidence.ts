import { RunnerError } from './errors';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { GUARD_API_METHODS } from './guard';
import { applicationSupportDir } from './vault';
import type { LiveProvider, ProbeResult, ProbeStatus, Tier } from './types';

/**
 * The content-free evidence file (plan 20 section 5.4). It is written from an allowlist, not a
 * filter: a value reaches the file only if it is a number, one of the fixed names below, a probe id
 * the caller registered, an ISO date or a version. Everything else throws, so no text a probe
 * returns (a subject, address, id, query or token) can get into the file.
 *
 * Numbers are the one channel left, so each is capped (below). That does not make a deliberately
 * dishonest probe impossible, only small: it could encode a few dozen bytes across the allowed
 * names. Probes are code reviewed in this repository, and a probe never sees content it was not
 * asked to count; the cap exists to turn "an address in a float" into a visible diff, not a proof.
 */
export const RUNNER_VERSION = '0.1.0';

/** Number-valued names a probe may report. Add a name here on purpose when a probe needs one. */
export const COUNT_KEYS: readonly string[] = [
  'messagesTotal',
  'threadsTotal',
  'labels',
  'userLabels',
  'systemLabels',
  'threadsListed',
  'threadsFetched',
  'messagesInThreads',
  'pages',
  'filters',
  'drafts',
  // gmail.auth-results-shape: structure counts of recent Inbox Authentication-Results headers, never their text.
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
  // gmail.draft-message-id-after-edit: flags (0 or 1) and counts about one probe draft, never its text or ids.
  'created',
  'createKeptMessageId',
  'updatedDraftIdKept',
  'updatedMessageIdChanged',
  'updatedKeptMessageIdHeader',
  'draftsScanned',
  'draftsMatching',
  'draftFound',
  'messageIdIsOurs',
  'bodyUnchanged',
  'bodyEdited',
  'probeDraftsExisting',
  // gmail.draft-message-id-after-edit v2: shape codes (0 absent, 1 ours, 2 Gmail-style, 3 other), 0/1 stability and header
  // flags, and hit counts of the rfc822msgid: searches. Never a Message-ID value or a token.
  'messageIdShapeCreate',
  'messageIdShapeSave',
  'messageIdShapePhone',
  'messageIdStableAcrossApiSave',
  'messageIdStableAcrossPhoneEdit',
  'customHeaderKeptAfterCreate',
  'customHeaderKeptAfterApiSave',
  'customHeaderKeptAfterPhoneEdit',
  'engineHeaderKeptAfterCreate',
  'engineHeaderKeptAfterApiSave',
  'engineHeaderKeptAfterPhoneEdit',
  'stateMissing',
  'searchDraftsOursCreate',
  'searchDraftsReportedCreate',
  'searchMessagesOursCreate',
  'searchMessagesReportedCreate',
  'searchDraftsOursPhone',
  'searchDraftsReportedPhone',
  'searchMessagesOursPhone',
  'searchMessagesReportedPhone',
  // gmail.send-message-id (S-self): did messages.send keep our Message-ID on the Sent copy (0/1), its shape code, the header,
  // and how many Sent messages rfc822msgid: finds for our id and for the one Gmail shows. No ids, no text.
  'sent',
  'sentKeptMessageId',
  'sentMessageIdShape',
  'sentHeaderKept',
  'sentFoundByRfc822msgidOurs',
  'sentFoundByRfc822msgidGmails',
  'sentSearchTries',
  'probeMessagesExisting',
  // gmail.adapter-send-find: the adapter's own send and findSent on real Gmail (0/1).
  'sentHeaderTokenKept',
  'findSentByToken',
  // gmail.archive-delta-cost: the mark/measure phases — history pages walked (2 units each), the
  // records and distinct messages a delta touched, and 0/1 flags. Never an id or a cursor.
  'marked',
  'historyPages',
  'historyRecords',
  'messagesTouched',
  'historyExpired',
  'pagesCapped',
  'baselineUpdated',
  'unmeasured',
  'archivedThreads',
  // Answers that were 200 with an empty body (a list with no items): ok, not an error.
  'emptyAnswers',
];
export const TIMING_KEYS: readonly string[] = [
  'profile',
  'labels',
  'list',
  'fetchTotal',
  'fetchMax',
  'total',
];
export const ERROR_CLASSES: readonly string[] = [
  'auth',
  'rate-limit',
  'quota',
  'not-found',
  'server',
  'network',
  'bad-body',
  'guard',
  'other',
];
export const SKIP_REASONS = ['token-expiry', 'token-refused', 'no-probes'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

const STATUSES: readonly ProbeStatus[] = ['pass', 'fail', 'skip'];
const TIERS: readonly Tier[] = ['R', 'M', 'S-self'];
const PROVIDERS: readonly LiveProvider[] = ['gmail', 'gcal'];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface EvidenceResult extends ProbeResult {
  id: string;
}

export interface RunEvidence {
  provider: LiveProvider;
  tier: Tier;
  /** YYYY-MM-DD, also the file name. */
  date: string;
  /** ISO date and time. */
  startedAt: string;
  node: string;
  /** Whole days until the test account's token expires; null when the run did not check one. */
  daysToExpiry: number | null;
  /** The commit the run was made from (checked against --expect-sha on a clean tree), when known. */
  commit?: string;
  skipReason?: SkipReason;
  results: EvidenceResult[];
  /** The run's units per clock minute. */
  unitsPerMinute: number[];
  /** The highest total any 60 s window held. */
  peakUnitsPerWindow: number;
}

class EvidenceRejected extends RunnerError {
  constructor(where: string) {
    // Names the field, never the value that was refused.
    super(`Evidence rejected: ${where} is not on the allowlist`);
    this.name = 'EvidenceRejected';
  }
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const oneOf = (list: readonly string[], value: unknown, where: string): string => {
  if (typeof value !== 'string' || !list.includes(value)) throw new EvidenceRejected(where);
  return value;
};
/** Caps that keep a number a number: a mailbox total, a request count or a per-minute unit count fits; a payload does not. */
const MAX_COUNT = 1_000_000;
/** One hour. */
const MAX_MS = 3_600_000;
const count = (value: unknown, where: string): number => {
  if (!isNumber(value) || !Number.isInteger(value) || value < 0 || value > MAX_COUNT)
    throw new EvidenceRejected(where);
  return value;
};
const amount = (value: unknown, where: string): number => {
  if (!isNumber(value) || value < 0 || value > MAX_MS) throw new EvidenceRejected(where);
  return value;
};
function onlyKeys(
  value: unknown,
  allowed: readonly string[],
  where: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new EvidenceRejected(where);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new EvidenceRejected(where);
  return value as Record<string, unknown>;
}
function isoDay(value: unknown, where: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    throw new EvidenceRejected(where);
  return value;
}
function isoTime(value: unknown, where: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    throw new EvidenceRejected(where);
  return value;
}
function commitSha(value: unknown, where: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new EvidenceRejected(where);
  return value;
}
function version(value: unknown, where: string): string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value))
    throw new EvidenceRejected(where);
  return value;
}
function numberMap(
  value: unknown,
  keys: readonly string[],
  where: string,
  integer: boolean,
): [string, number][] {
  const map = onlyKeys(value, keys, where);
  return Object.entries(map).map(([key, inner]) => [
    key,
    integer ? count(inner, `${where}.${key}`) : amount(inner, `${where}.${key}`),
  ]);
}
const series = (value: unknown, where: string): number[] => {
  if (!Array.isArray(value)) throw new EvidenceRejected(where);
  return value.map((entry, index) => count(entry, `${where}[${index}]`));
};

/** Checks every field of a run and renders it. Throws EvidenceRejected on the first value that is not allowed. */
export function renderEvidence(run: RunEvidence, allowedProbeIds: Iterable<string>): string {
  const probeIds = [...allowedProbeIds];
  const top = onlyKeys(
    run,
    [
      'provider',
      'tier',
      'date',
      'startedAt',
      'node',
      'daysToExpiry',
      'commit',
      'skipReason',
      'results',
      'unitsPerMinute',
      'peakUnitsPerWindow',
    ],
    'run',
  );
  const provider = oneOf(PROVIDERS, top.provider, 'provider');
  const tier = oneOf(TIERS, top.tier, 'tier');
  const startedAt = isoTime(top.startedAt, 'startedAt');
  const node = version(top.node, 'node');
  const days =
    top.daysToExpiry === null
      ? null
      : isNumber(top.daysToExpiry) && Number.isInteger(top.daysToExpiry)
        ? top.daysToExpiry
        : (() => {
            throw new EvidenceRejected('daysToExpiry');
          })();
  const commit = top.commit === undefined ? undefined : commitSha(top.commit, 'commit');
  const skip =
    top.skipReason === undefined ? undefined : oneOf(SKIP_REASONS, top.skipReason, 'skipReason');
  const perMinute = series(top.unitsPerMinute, 'unitsPerMinute');
  const peak = count(top.peakUnitsPerWindow, 'peakUnitsPerWindow');
  isoDay(top.date, 'date');
  if (!Array.isArray(top.results)) throw new EvidenceRejected('results');

  const lines = [
    `## ${startedAt}, ${provider}, tier ${tier}`,
    '',
    `- Runner ${RUNNER_VERSION}, Node ${node}`,
    `- Commit: ${commit ?? 'not checked'}`,
    `- Days left before the test account must be reconnected: ${days === null ? 'not checked' : days}`,
    ...(skip ? [`- Skipped: ${skip}`] : []),
    `- Units per minute (minute 0 first): ${perMinute.length ? perMinute.join(', ') : 'none'}`,
    `- Peak units in any 60 s window: ${peak}`,
    `- Peak units in one clock minute: ${perMinute.length ? Math.max(...perMinute) : 0}`,
    '',
  ];

  for (const [index, entry] of top.results.entries()) {
    const where = `results[${index}]`;
    const result = onlyKeys(
      entry,
      ['id', 'status', 'counts', 'timingsMs', 'errorClasses', 'requests', 'unitsPerMinute'],
      where,
    );
    const id = oneOf(probeIds, result.id, `${where}.id`);
    const status = oneOf(STATUSES, result.status, `${where}.status`);
    const counts = numberMap(result.counts, COUNT_KEYS, `${where}.counts`, true);
    const timings = numberMap(result.timingsMs, TIMING_KEYS, `${where}.timingsMs`, false);
    const errors = numberMap(result.errorClasses, ERROR_CLASSES, `${where}.errorClasses`, true);
    const probeSeries = series(result.unitsPerMinute, `${where}.unitsPerMinute`);
    if (!Array.isArray(result.requests)) throw new EvidenceRejected(`${where}.requests`);
    const requests = result.requests.map((request, i) => {
      const fields = onlyKeys(
        request,
        ['method', 'httpMethod', 'count'],
        `${where}.requests[${i}]`,
      );
      return `${oneOf(GUARD_API_METHODS, fields.method, `${where}.requests[${i}].method`)} ${oneOf(HTTP_METHODS, fields.httpMethod, `${where}.requests[${i}].httpMethod`)} x${count(fields.count, `${where}.requests[${i}].count`)}`;
    });
    const join = (pairs: [string, number][], unit = ''): string =>
      pairs.length
        ? pairs.map(([k, v]) => `${k}=${Math.round(v * 10) / 10}${unit}`).join(', ')
        : 'none';
    lines.push(
      `### ${id}: ${status}`,
      '',
      `- Counts: ${join(counts)}`,
      `- Timings: ${join(timings, ' ms')}`,
      `- Error classes: ${join(errors)}`,
      `- Requests: ${requests.length ? requests.join('; ') : 'none'}`,
      `- Units per minute during this probe: ${probeSeries.length ? probeSeries.join(', ') : 'none'}`,
      '',
    );
  }

  const text = `${lines.join('\n')}\n`;
  // Belt and braces: the allowlist cannot let these through, so seeing one means a bug in it.
  if (/[@]|:\/\/|[^\x20-\x7e\n]/.test(text)) throw new EvidenceRejected('rendered text');
  return text;
}

/**
 * `~/Library/Application Support/Aplos Mail Review/live/<date>/`, outside the repository
 * (plans/LIVE-RUNS.md). A caller may still pass its own folder to `writeEvidence` (tests do).
 */
export function defaultEvidenceDir(date: string): string {
  return applicationSupportDir('Aplos Mail Review', 'live', isoDay(date, 'date'));
}

/**
 * Appends a run to `<dir>/<date>-<provider>.md`. Several runs on one day (tier R in the morning,
 * tier M later) share the file, each under its own heading.
 */
export async function writeEvidence(
  dir: string,
  run: RunEvidence,
  allowedProbeIds: Iterable<string>,
): Promise<string> {
  const body = renderEvidence(run, allowedProbeIds);
  const file = join(
    dir,
    `${isoDay(run.date, 'date')}-${oneOf(PROVIDERS, run.provider, 'provider')}.md`,
  );
  await mkdir(dir, { recursive: true });
  const exists = await stat(file).then(
    () => true,
    () => false,
  );
  const heading = `# Live check evidence, ${run.provider}, ${run.date}\n\nContent-free: counts, timings, error classes and request counts only.\n\n`;
  await appendFile(file, (exists ? '' : heading) + body);
  return file;
}
