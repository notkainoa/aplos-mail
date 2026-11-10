import { emptyResult, type ProbeContext, type ProbeResult, type SmokeProbe } from '../types';
import { getJson, ProbeHttpError } from './http';

/**
 * Tier R probe `gmail.archive-delta-cost`, in two phases (`--phase mark`, then `--phase measure`):
 * what a change made OUTSIDE the app costs the next incremental sync — the budgets.json row
 * `sync.archive-2000-units`, "a 2,000-thread archive made in Gmail web". `mark` stores the profile
 * historyId in the probe's state file (a decimal cursor is the one non-hash value state.ts allows).
 * The owner then archives threads in Gmail web on the spare account. `measure` walks
 * `users.history.list` from the stored cursor — the same call the syncer's incremental step makes —
 * and counts pages, records and the distinct messages touched, never an id. The run's pacer prices
 * every page (history.list is 2 units a call) in its own evidence, so `historyPages` is the number
 * the budget row records. `measure` ends by storing the fresh profile historyId, so the file is
 * again the baseline for the next delta. A cursor Gmail has forgotten answers 404: the probe
 * reports `historyExpired`, fails, and a fresh `mark` is needed.
 */

/** One page of `history.list` asks for this many records; the page count is the unit cost. */
const PAGE = 500;
/** Pages a measure walks before stopping: 40 pages at 2 units still sit under the 100-unit row. */
const MAX_PAGES = 40;
const HISTORY_ID = /^\d{1,25}$/;

function failed(error: unknown, result: ProbeResult): ProbeResult {
  const errorClass = error instanceof ProbeHttpError ? error.errorClass : 'other';
  result.status = 'fail';
  result.errorClasses[errorClass] = (result.errorClasses[errorClass] ?? 0) + 1;
  return result;
}

/** Every message id one history record names, folded into a distinct-id set that leaves nothing. */
function collectMessages(record: unknown, touched: Set<string>): void {
  if (typeof record !== 'object' || record === null) return;
  const lists = record as Record<string, unknown>;
  for (const key of [
    'messages',
    'messagesAdded',
    'messagesDeleted',
    'labelsAdded',
    'labelsRemoved',
  ]) {
    const list = lists[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const stub = entry as { id?: unknown; message?: { id?: unknown } };
      const id = stub.message?.id ?? stub.id;
      if (typeof id === 'string') touched.add(id);
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
  let pageToken: string | undefined;
  const started = ctx.now();
  try {
    do {
      const page = await getJson(ctx, '/history', {
        startHistoryId: baseline,
        maxResults: String(PAGE),
        fields: 'history,nextPageToken',
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      result.counts.historyPages = (result.counts.historyPages ?? 0) + 1;
      const items = Array.isArray(page.json.history) ? page.json.history : [];
      result.counts.historyRecords = (result.counts.historyRecords ?? 0) + items.length;
      for (const item of items) collectMessages(item, touched);
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
  result.counts.historyExpired = 0;
  result.counts.pagesCapped = pageToken === undefined ? 0 : 1;
  // A walk stopped by the page cap is a partial measurement, not a cost the row can record.
  if (pageToken !== undefined) result.status = 'fail';
  // A walked delta leaves the newest cursor behind, so the file is the baseline for the next one.
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
