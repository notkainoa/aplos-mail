/**
 * Prefetch on intent (DESIGN 5 rule 9): keyboard focus resting 80 ms, or the pointer resting 120 ms, on a thread
 * prefetches its body and both neighbours' (`MessageBody/prefetch {threadIds}`). Moving on cancels the timer, and a
 * request already sent is cancelled with `{threadIds, cancel: true}`.
 */
import type { ThreadId } from './contract-shapes';
import type { DataClient } from './client';
import { PREFETCH_TIMING, type PrefetchIntent } from './index';
import type { Timers } from './scheduler';

/** `MessageBody/prefetch` takes at most 20 thread ids. */
const MAX_THREADS = 20;

export function createPrefetchIntent(client: DataClient, timers: Timers): PrefetchIntent {
  let cancelTimer: (() => void) | null = null;
  let sent: ThreadId[] | null = null;
  let target: string | null = null;

  const stop = () => {
    cancelTimer?.();
    cancelTimer = null;
    target = null;
    if (sent) {
      const threadIds = sent;
      sent = null;
      client.call('MessageBody/prefetch', { threadIds, cancel: true }).catch(() => {});
    }
  };

  const intend = (threadId: ThreadId, neighbours: readonly ThreadId[], delay: number) => {
    const threadIds = [...new Set([threadId, ...neighbours])].slice(0, MAX_THREADS);
    const key = threadIds.join('\u0000');
    if (key === target) return;
    stop();
    target = key;
    cancelTimer = timers.setTimeout(() => {
      cancelTimer = null;
      sent = threadIds;
      client.call('MessageBody/prefetch', { threadIds }).catch(() => {});
    }, delay);
  };

  return {
    focus: (threadId, neighbours) => intend(threadId, neighbours, PREFETCH_TIMING.focusMs),
    hover: (threadId, neighbours) => intend(threadId, neighbours, PREFETCH_TIMING.hoverMs),
    cancel: stop,
  };
}
