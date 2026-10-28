import { emptyResult, type ProbeContext, type ProbeResult, type SmokeProbe } from '../types';
import { getJson, ProbeHttpError } from './http';

/**
 * Tier R Gmail probes: reads only, content-free results. They fetch metadata the way the app's
 * first sync does but keep only counts and timings; nothing from a message is stored or returned.
 */
function failed(error: unknown, result: ProbeResult): ProbeResult {
  const errorClass = error instanceof ProbeHttpError ? error.errorClass : 'other';
  result.status = 'fail';
  result.errorClasses[errorClass] = (result.errorClasses[errorClass] ?? 0) + 1;
  return result;
}

export const profileAndLabels: SmokeProbe = {
  id: 'gmail.profile-and-labels',
  provider: 'gmail',
  tier: 'R',
  async run(ctx: ProbeContext): Promise<ProbeResult> {
    const result = emptyResult();
    try {
      // The mask leaves out emailAddress: the probe has no use for it.
      const profile = await getJson(ctx, '/profile', { fields: 'messagesTotal,threadsTotal' });
      result.counts.messagesTotal = Number(profile.json.messagesTotal ?? 0);
      result.counts.threadsTotal = Number(profile.json.threadsTotal ?? 0);
      result.timingsMs.profile = profile.ms;

      const labels = await getJson(ctx, '/labels', { fields: 'labels(id,type)' });
      const list: { type?: string }[] = Array.isArray(labels.json.labels) ? labels.json.labels : [];
      result.counts.labels = list.length;
      result.counts.userLabels = list.filter(label => label.type === 'user').length;
      result.counts.systemLabels = list.filter(label => label.type === 'system').length;
      result.timingsMs.labels = labels.ms;
      // Every Gmail account has the system labels, so none means the answer was not a label list.
      if (result.counts.systemLabels === 0) result.status = 'fail';
    } catch (error) {
      return failed(error, result);
    }
    return result;
  },
};

const INBOX_WINDOW = 50;
const THREAD_ID = /^[0-9a-f]{1,16}$/i;

export const inboxWindowMetadata: SmokeProbe = {
  id: 'gmail.inbox-window-metadata',
  provider: 'gmail',
  tier: 'R',
  async run(ctx: ProbeContext): Promise<ProbeResult> {
    const result = emptyResult();
    const started = ctx.now();
    try {
      const list = await getJson(ctx, '/threads', {
        labelIds: 'INBOX',
        maxResults: String(INBOX_WINDOW),
        fields: 'threads(id),nextPageToken',
      });
      const ids: string[] = (Array.isArray(list.json.threads) ? list.json.threads : []).map(
        (thread: { id?: unknown }) => String(thread.id),
      );
      result.counts.threadsListed = ids.length;
      result.counts.pages = 1;
      result.timingsMs.list = list.ms;
      result.counts.threadsFetched = 0;
      result.counts.messagesInThreads = 0;
      let slowest = 0;
      let fetchTotal = 0;
      for (const id of ids) {
        if (!THREAD_ID.test(id)) {
          result.status = 'fail';
          result.errorClasses.other = (result.errorClasses.other ?? 0) + 1;
          continue;
        }
        try {
          // Metadata only, with a mask: the same shape the first sync asks for, minus the headers' values.
          const thread = await getJson(ctx, `/threads/${id}`, {
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
            fields: 'id,messages(id,labelIds,internalDate)',
          });
          result.counts.threadsFetched++;
          result.counts.messagesInThreads =
            (result.counts.messagesInThreads ?? 0) +
            (Array.isArray(thread.json.messages) ? thread.json.messages.length : 0);
          fetchTotal += thread.ms;
          slowest = Math.max(slowest, thread.ms);
        } catch (error) {
          failed(error, result);
          // Do not keep hammering an account that is being throttled.
          if (
            error instanceof ProbeHttpError &&
            (error.errorClass === 'rate-limit' ||
              error.errorClass === 'quota' ||
              error.errorClass === 'auth')
          )
            break;
        }
      }
      result.timingsMs.fetchTotal = fetchTotal;
      result.timingsMs.fetchMax = slowest;
    } catch (error) {
      failed(error, result);
    }
    result.timingsMs.total = ctx.now() - started;
    return result;
  },
};
