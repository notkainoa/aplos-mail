/**
 * The thread the reader lane will show. `openThread` records its id and the shell navigates to the placeholder
 * screen; the reader reads the id with `useOpenThread` and renders it there.
 */
import { createStore } from './store-core';
import type { ThreadId } from '../data';

const threadStore = createStore<ThreadId | null>(null);

export const OPEN_THREAD_SCREEN = { label: 'thread' } as const;

/** Records the open thread (null clears it). */
export function setOpenThread(id: ThreadId | null): void {
  threadStore.set(id);
}

export const getOpenThread = threadStore.get;
export const subscribeOpenThread = threadStore.subscribe;
