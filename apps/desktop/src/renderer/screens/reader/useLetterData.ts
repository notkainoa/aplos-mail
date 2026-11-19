/**
 * What one letter (a thread) needs from the engine: the thread row and its messages, oldest first, and whether they are
 * still coming, gone, or failed. The row and the messages are shared with every other reader of the same thread.
 */
import { useRowState, useView, type Message, type ThreadRow } from '../../data';

/** Where a letter's data stands. */
export type LetterStatus = 'loading' | 'ready' | 'missing' | 'failed';

/** The data of one letter. */
export interface LetterData {
  readonly status: LetterStatus;
  readonly row: ThreadRow | undefined;
  /** Oldest first; complete when `status` is 'ready'. */
  readonly messages: readonly Message[];
}

function isMissing(rowGone: boolean, error: { type: string } | null, empty: boolean): boolean {
  return rowGone || error?.type === 'notFound' || empty;
}

export function useLetterData(threadId: string): LetterData {
  const rowState = useRowState('Thread', threadId);
  const view = useView({ kind: 'thread', threadId });
  const messages = view.ids.flatMap(id => view.rows.get(id) ?? []);
  const live = view.status === 'live';
  const empty = live && view.ids.length === 0;
  const row = rowState.row;
  if (isMissing(rowState.status === 'notFound', view.error, empty))
    return { status: 'missing', row, messages };
  if (view.status === 'failed') return { status: 'failed', row, messages };
  const whole = live && messages.length === view.ids.length && messages.length > 0;
  return { status: row && whole ? 'ready' : 'loading', row, messages };
}
