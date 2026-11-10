import { emptyResult, type ProbeContext, type ProbeResult, type SmokeProbe } from '../types';
import { getJson, ProbeHttpError } from './http';

/**
 * Tier R probe `gmail.archive-delta-cost`, in two phases (`--phase mark`, then `--phase measure`):
 * what a change made OUTSIDE the app costs the next incremental sync — the budgets.json row
 * `sync.archive-2000-units`, "a 2,000-thread archive made in Gmail web" for 100 units. `mark`
 * stores the profile historyId in the probe's state file (a decimal cursor is the one non-hash
 * value state.ts allows). The owner then archives threads in Gmail web on the spare account.
 * `measure` walks `users.history.list` from the stored cursor with the same `historyTypes` and
 * `fields` mask the adapter's incremental step sends (google/history.ts), and counts pages,
 * records and the distinct messages touched, never an id. The run's pacer prices every page
 * (history.list is 2 units a call) in its own evidence, so `historyPages` is the number the
 * budget row records. A walk with under ARCHIVE_MIN_THREADS archived threads — distinct
 * threadIds of `labelsRemoved` entries that took off INBOX — fails `unmeasured`: a skipped,
 * half-done or merely relabelled mailbox must never read as a pass, and the cursor is kept so
 * the rest of the archive still counts. A walk stopped by the page cap is a partial cost and also fails, and
 * only a pass stores the fresh profile historyId as the baseline for the next delta. A cursor
 * Gmail has forgotten answers 404: the probe reports `historyExpired`, fails, and a fresh `mark`
 * is needed.
 */

/** The limit of the row being measured, budgets.json `sync.archive-2000-units` (a test pins it). */
export const ARCHIVE_ROW_LIMIT_UNITS = 100;
/**
 * A pass needs at least this many distinct ARCHIVED threads: the row measures a 2,000-thread
 * archive, so label churn or other noise that never removes INBOX can never reach the floor.
 */
export const ARCHIVE_MIN_THREADS = 2000;
const PAGE = 500;
/** history.list costs 2 units a page; the re-mark's getProfile costs 1 (both pinned by a test). */
export const HISTORY_PAGE_UNITS = 2;
export const PROFILE_UNITS = 1;
/** The walk alone cannot pass the row's limit: 49 pages x 2 + 1 profile = 99 of 100 units. */
export const MAX_PAGES = Math.floor((ARCHIVE_ROW_LIMIT_UNITS - PROFILE_UNITS) / HISTORY_PAGE_UNITS);
const HISTORY_ID = /^\d{1,25}$/;

/** The exact call shape of the adapter's incremental step (google/history.ts): all four types. */
const HISTORY_TYPES = ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'];
const HISTORY_FIELDS =
  'history(id,messagesAdded(message(id,threadId,labelIds)),' +
  'messagesDeleted(message(id,threadId,labelIds)),' +
  'labelsAdded(message(id,threadId,labelIds),labelIds),' +
  'labelsRemoved(message(id,threadId,labelIds),labelIds)),nextPageToken,historyId';

function failed(error: unknown, result: ProbeResult): ProbeResult {
  const errorClass = error instanceof ProbeHttpError ? error.errorClass : 'other';
  result.status = 'fail';
  result.errorClasses[errorClass] = (result.errorClasses[errorClass] ?? 0) + 1;
  return result;
}

/**
 * Every message id one history record names folds into `touched`; a `labelsRemoved` entry that
 * takes INBOX off a message also names an ARCHIVED thread — the signal the row actually measures.
 */
function collectMessages(
  record: unknown,
  touched: Set<string>,
  archivedThreads: Set<string>,
): void {
  if (typeof record !== 'object' || record === null) return;
  const lists = record as Record<string, unknown>;
  for (const key of ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) {
    const list = lists[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const id = (entry as { message?: { id?: unknown } }).message?.id;
      if (typeof id === 'string') touched.add(id);
    }
  }
  const removed = lists.labelsRemoved;
  if (!Array.isArray(removed)) return;
  for (const entry of removed) {
    const stub = entry as { labelIds?: unknown; message?: { threadId?: unknown } };
    const labels = Array.isArray(stub.labelIds) ? stub.labelIds : [];
    if (labels.includes('INBOX') && typeof stub.message?.threadId === 'string') {
      archivedThreads.add(stub.message.threadId);
    }
  }
}

async function markPhase(ctx: ProbeContext, result: ProbeResult): Promise<void> {
  if (!ctx.state) {
    result.counts.marked = 0;
    result.status = 'fail';
    result.errorClasses.other = 1;
    return;
  }
  const profile = await getJson(ctx, '/profile', {
    fields: 'historyId,messagesTotal,threadsTotal',
  });
  result.timingsMs.profile = profile.ms;
  result.counts.messagesTotal = Number(profile.json.messagesTotal ?? 0);
  result.counts.threadsTotal = Number(profile.json.threadsTotal ?? 0);
  const historyId = String(profile.json.historyId ?? '');
  if (!HISTORY_ID.test(historyId)) {
    result.counts.marked = 0;
    result.status = 'fail';
    result.errorClasses['bad-body'] = 1;
    return;
  }
  await ctx.state.save({ historyId });
  result.counts.marked = 1;
}

async function measurePhase(ctx: ProbeContext, result: ProbeResult): Promise<void> {
  const baseline = (await ctx.state?.load())?.historyId;
  if (baseline === undefined) {
    result.counts.stateMissing = 1;
    result.status = 'fail';
    return;
  }
  result.counts.stateMissing = 0;
  const touched = new Set<string>();
  const archivedThreads = new Set<string>();
  let pageToken: string | undefined;
  const started = ctx.now();
  try {
    do {
      const page = await getJson(ctx, '/history', {
        startHistoryId: baseline,
        maxResults: String(PAGE),
        historyTypes: HISTORY_TYPES,
        fields: HISTORY_FIELDS,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      result.counts.historyPages = (result.counts.historyPages ?? 0) + 1;
      const items = Array.isArray(page.json.history) ? page.json.history : [];
      result.counts.historyRecords = (result.counts.historyRecords ?? 0) + items.length;
      for (const item of items) collectMessages(item, touched, archivedThreads);
      pageToken = typeof page.json.nextPageToken === 'string' ? page.json.nextPageToken : undefined;
    } while (pageToken !== undefined && (result.counts.historyPages ?? 0) < MAX_PAGES);
  } catch (error) {
    if (error instanceof ProbeHttpError && error.errorClass === 'not-found') {
      result.counts.historyExpired = 1;
      result.errorClasses['not-found'] = (result.errorClasses['not-found'] ?? 0) + 1;
      result.status = 'fail';
      return;
    }
    throw error;
  }
  result.timingsMs.list = ctx.now() - started;
  result.counts.messagesTouched = touched.size;
  result.counts.archivedThreads = archivedThreads.size;
  result.counts.historyExpired = 0;
  result.counts.pagesCapped = pageToken === undefined ? 0 : 1;
  // A capped walk is a partial measurement; the cursor stays so a rerun still sees the delta.
  if (pageToken !== undefined) {
    result.status = 'fail';
    return;
  }
  // Under the floor the archive was skipped, half-done or not an archive at all: keep the cursor.
  if (archivedThreads.size < ARCHIVE_MIN_THREADS) {
    result.counts.unmeasured = 1;
    result.status = 'fail';
    return;
  }
  result.counts.unmeasured = 0;
  // Only a pass re-marks: the newest cursor is the baseline for the next delta.
  const profile = await getJson(ctx, '/profile', { fields: 'historyId' });
  const next = String(profile.json.historyId ?? '');
  if (ctx.state && HISTORY_ID.test(next)) {
    await ctx.state.save({ historyId: next });
    result.counts.baselineUpdated = 1;
  } else {
    result.counts.baselineUpdated = 0;
  }
}

export const archiveDeltaCost: SmokeProbe = {
  id: 'gmail.archive-delta-cost',
  provider: 'gmail',
  tier: 'R',
  phased: true,
  async run(ctx: ProbeContext): Promise<ProbeResult> {
    if (ctx.phase !== 'mark' && ctx.phase !== 'measure') return emptyResult('skip');
    const result = emptyResult();
    const started = ctx.now();
    try {
      if (ctx.phase === 'mark') await markPhase(ctx, result);
      else await measurePhase(ctx, result);
    } catch (error) {
      failed(error, result);
    }
    result.timingsMs.total = ctx.now() - started;
    return result;
  },
};
