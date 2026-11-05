import { useSyncExternalStore } from 'react';
import type { Thread } from '@aplos/contract/legacy/types';
import { bridge, invoke } from './bridge';
import { hasRealSummary } from '@aplos/contract/legacy/summary';
import { summaryProvider, type SummaryProvider } from './summaryText';
export {
  describeSummaryError,
  hasRealSummary,
  summaryProvider,
  type SummaryProvider,
} from './summaryText';

/**
 * Summaries requested from the reader or the list this session. Opening an email whose summary is only its own text
 * asks once; a failure stays on the card (with its reason) until Retry, so reopening the email doesn't ask again.
 */
/** A failure keeps the provider it was asked of, so its explanation stays right after the model changes. */
export type SummaryJob = {
  running: boolean;
  error?: string;
  provider?: SummaryProvider;
  done?: boolean;
};
const jobs = new Map<string, SummaryJob>();
/** Emails the engine reports being summarized, including those from sync. */
const working = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const set = (id: string, job: SummaryJob) => {
  jobs.set(id, job);
  notify();
};
let watching = false;
function watch() {
  if (watching) return;
  watching = true;
  // Sync may have started before this window was listening; ask what is in flight, minus anything that ends meanwhile.
  let ended: Set<string> | undefined = new Set();
  bridge.subscribe(
    event => {
      if (event.type !== 'ai.summarizing') return;
      const { threadId, active } = event.payload as { threadId: string; active: boolean };
      if (active) {
        working.add(threadId);
        ended?.delete(threadId);
      } else {
        working.delete(threadId);
        ended?.add(threadId);
      }
      notify();
      // `only`: this window-wide watcher may start before the app subscribes and must not take its held events.
    },
    { only: ['ai.summarizing'] },
  );
  void invoke<string[]>('ai.summarizing')
    .then(
      ids => {
        for (const id of ids) if (!ended!.has(id)) working.add(id);
        notify();
      },
      () => {},
    )
    .finally(() => {
      ended = undefined;
    });
}
const subscribe = (listener: () => void) => {
  watch();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useSummaryJob(threadId: string) {
  return useSyncExternalStore(subscribe, () => jobs.get(threadId));
}
/** Whether this email's summary is being written right now, whoever asked. */
export function useSummarizing(threadId: string) {
  return useSyncExternalStore(
    subscribe,
    () => working.has(threadId) || !!jobs.get(threadId)?.running,
  );
}

/** Emails the list failed to summarize: the list won't ask again this session, but opening one still does. */
const listFailed = new Set<string>();

/**
 * Resolves to the error message, or undefined once the thread has a fresh summary. A call while one is running does
 * nothing. Background requests (`ifMissing`) leave an email alone if it got a summary meanwhile; Retry and
 * "Summarize again" don't.
 */
export async function summarize(
  threadId: string,
  {
    ifMissing = false,
    fromList = false,
    summaryModel,
  }: { ifMissing?: boolean; fromList?: boolean; summaryModel?: string } = {},
): Promise<string | undefined> {
  if (jobs.get(threadId)?.running) return;
  const provider = summaryProvider(summaryModel);
  set(threadId, { running: true });
  try {
    await invoke('ai.summarize', { threadId, ...(ifMissing ? { onlyIfMissing: true } : {}) });
    set(threadId, { running: false, done: true });
    return;
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'The AI provider could not summarize this email.';
    if (fromList) {
      jobs.delete(threadId);
      listFailed.add(threadId);
      notify();
    } else set(threadId, { running: false, error: message, provider });
    return message;
  }
}
/** Summarize on open, once per session; a retry is the user's call. */
export function summarizeIfNeeded(thread: Thread, summaryModel?: string) {
  if (!hasRealSummary(thread) && !jobs.has(thread.id))
    void summarize(thread.id, { ifMissing: true, summaryModel });
}

// Rows on screen without a summary are summarized two at a time. After a failure (often no key or a rate limit)
// the list waits a minute before going on with the rest; opening an email still asks, and shows why it failed.
const queue: string[] = [];
let active = 0,
  pausedUntil = 0,
  resume: ReturnType<typeof setTimeout> | undefined;
export function summarizeRow(thread: Thread) {
  if (
    hasRealSummary(thread) ||
    jobs.has(thread.id) ||
    listFailed.has(thread.id) ||
    queue.includes(thread.id)
  )
    return;
  queue.push(thread.id);
  pump();
}
/** A row that scrolls away or leaves stops waiting, so rows on screen go first. */
export function cancelRow(threadId: string) {
  const at = queue.indexOf(threadId);
  if (at >= 0) queue.splice(at, 1);
}
function pump() {
  const wait = pausedUntil - Date.now();
  if (wait > 0) {
    resume ??= setTimeout(() => {
      resume = undefined;
      pump();
    }, wait);
    return;
  }
  while (active < 2 && queue.length) {
    const id = queue.shift()!;
    if (jobs.has(id)) continue;
    active++;
    void summarize(id, { ifMissing: true, fromList: true })
      .then(error => {
        if (error) pausedUntil = Date.now() + 60_000;
      })
      .finally(() => {
        active--;
        pump();
      });
  }
}
