/**
 * Where a send shows itself once the composer has closed (DESIGN 7.6 Send, 7.15 Send failed): the message you sent
 * `arrive`s at the end of the thread with the `UndoTray` under it ("Sending to Jordan in 8 s · Undo Z · Send now", and
 * the unconfirmed, missed and deferred lines), or the send-failed line "Couldn't send to Jordan. Your draft is saved."
 * with Try again and Edit. One place per send; the engine's row decides which.
 */
import { useSyncExternalStore } from 'react';
import { toIsoDateTime } from '../../../data';
import { themeHooks } from '../../../ui/generated/motion';
import { ErrorLine } from '../../../ui/list';
import type { ErrorLineAction, UndoTrayAction } from '../../../ui/props';
import { ThreadMessage } from '../../../ui/reader';
import type { ComposeFields } from '../model/fields';
import { safeDisplayName } from '../model/recipients';
import type { SendAction, SendView } from '../model/sendState';

function subscribeMotion(listener: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const query = window.matchMedia(themeHooks.reducedMotionQuery);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

function reducedNow(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(themeHooks.reducedMotionQuery).matches;
}

/** Reduced motion: the tray's drain becomes a static text countdown. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, reducedNow, () => false);
}

/** "to Jordan Lee, mina@example.com"; a name that contains "@" gives way to the real address. */
export function toLabelOf(fields: ComposeFields): string {
  const names = [...fields.to, ...fields.cc].map(safeDisplayName);
  return names.length > 0 ? `to ${names.join(', ')}` : 'No recipient';
}

const ERROR_TO_SEND: Partial<Record<ErrorLineAction, SendAction>> = {
  retry: 'retry',
  edit: 'edit',
};

export interface SendStatusProps {
  /** DOM id for the sent message. */
  readonly id: string;
  readonly view: SendView;
  readonly fields: ComposeFields;
  /** When the send was pressed or queued, for the message's time. */
  readonly at: number;
  readonly reducedMotion: boolean;
  /** The undo window is over (sending, offline, sent): the message stays, with no tray, until the thread holds it. */
  readonly bare?: boolean;
  readonly onAction: (action: SendAction) => void;
}

/** The sent message with its tray, or the send-failed line; nothing for phases that show neither. */
export function SendStatus({
  id,
  view,
  fields,
  at,
  reducedMotion,
  bare = false,
  onAction,
}: SendStatusProps) {
  if (view.failure) {
    return (
      <ErrorLine
        kind="sendFailed"
        recipient={view.failure.recipient}
        placement="column"
        onAction={action => {
          const verb = ERROR_TO_SEND[action];
          if (verb) onAction(verb);
        }}
      />
    );
  }
  if (!view.tray && !bare) return null;
  return (
    <ThreadMessage
      id={id}
      from="You"
      toLabel={toLabelOf(fields)}
      date={toIsoDateTime(at)}
      cursor={false}
      body={<p className="aplos-compose-sent__body">{fields.body}</p>}
      undoTray={
        view.tray
          ? {
              state: view.tray,
              reducedMotion,
              undoCommandId: 'app.undo',
              onAction: (action: UndoTrayAction) => onAction(action),
            }
          : undefined
      }
    />
  );
}
