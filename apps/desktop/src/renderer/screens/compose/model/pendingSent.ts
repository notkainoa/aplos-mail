/**
 * A sent reply the thread does not hold yet (DESIGN 4.8 `arrive`: "a sent message in its thread"). The engine learns of
 * a message it sent from the provider's next sync, up to a minute after the undo window; until then the reader shows
 * what was sent from this note. A note says how many messages of yours the thread had when the reply opened, and is
 * dropped once the thread holds one more than that (or, when several wait, one more for each earlier note).
 */
import type { ComposeFields } from './fields';

export interface PendingSent {
  readonly key: string;
  readonly threadId: string;
  readonly fields: ComposeFields;
  /** When the send was pressed. */
  readonly at: number;
  /** Messages of yours the thread held when the reply opened. */
  readonly baseline: number;
}

/** A note nobody has settled after this long is dropped: the reader stops showing a message the engine never got. */
export const PENDING_SENT_LIFE_MS = 10 * 60 * 1000;

/** The notes of `threadId` still to show, oldest first, given how many messages of yours the thread holds now. */
export function stillPending(
  notes: readonly PendingSent[],
  threadId: string,
  mine: number,
  now: number,
): readonly PendingSent[] {
  const ofThread = notes
    .filter(note => note.threadId === threadId && now - note.at < PENDING_SENT_LIFE_MS)
    .sort((a, b) => a.at - b.at);
  return ofThread.filter((note, index) => mine <= note.baseline + index);
}

type Listener = () => void;

let notes: readonly PendingSent[] = [];
const listeners = new Set<Listener>();

function publish(next: readonly PendingSent[]): void {
  notes = next;
  for (const listener of [...listeners]) listener();
}

export const pendingSentStore = {
  get: (): readonly PendingSent[] => notes,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  add(note: PendingSent): void {
    publish([...notes.filter(other => other.key !== note.key), note]);
  },
  clear(): void {
    publish([]);
  },
};
