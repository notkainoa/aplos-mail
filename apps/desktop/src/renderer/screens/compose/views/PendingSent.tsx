/**
 * The replies sent from this thread that its messages do not hold yet, under the last message: the text you sent,
 * "You · to Jordan", with no tray (the undo window is over). Each goes once the thread holds the real message.
 */
import { useSyncExternalStore } from 'react';
import { getNow, toIsoDateTime, useView, type Message } from '../../../data';
import { ThreadMessage } from '../../../ui/reader';
import { pendingSentStore, stillPending } from '../model/pendingSent';
import { toLabelOf } from './SendStatus';

/** Messages of yours in the thread: the engine's own flag, which a provider sets on every message you sent. */
export function mineIn(messages: readonly Pick<Message, 'fromMe'>[]): number {
  return messages.filter(message => message.fromMe).length;
}

export function PendingSent({ threadId }: { readonly threadId: string }) {
  const notes = useSyncExternalStore(
    pendingSentStore.subscribe,
    pendingSentStore.get,
    pendingSentStore.get,
  );
  const view = useView({ kind: 'thread', threadId });
  const mine = mineIn(view.ids.flatMap(id => view.rows.get(id) ?? []));
  const shown = stillPending(notes, threadId, mine, getNow());
  return (
    <>
      {shown.map(note => (
        <ThreadMessage
          key={note.key}
          id={`sent-${note.key}`}
          from="You"
          toLabel={toLabelOf(note.fields)}
          date={toIsoDateTime(note.at)}
          cursor={false}
          body={<p className="aplos-compose-sent__body">{note.fields.body}</p>}
        />
      ))}
    </>
  );
}
