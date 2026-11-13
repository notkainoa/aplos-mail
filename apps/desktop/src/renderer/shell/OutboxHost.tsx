/**
 * The sidebar's outbox notice (DESIGN 7.1, 7.13, 7.15): a failed send stays here, calm and out of the way, after its
 * toast has faded. StatusSlot's shape: the alert icon in --stamp-ink and two or three short lines, with the verbs
 * as text buttons. It never covers the pane and never takes focus. The words and verbs come from the send that
 * failed, so the toast and this notice always agree.
 */
import { useSyncExternalStore } from 'react';
import { Button } from '../ui/buttons-keys';
import { PartIcon } from '../ui/surfaces/parts';
import { getOutbox, removeOutboxNotice, runOutboxAction, subscribeOutbox } from './store-outbox';
import type { OutboxNotice } from './store-outbox';

/** Props for `OutboxView`. */
export interface OutboxViewProps {
  readonly notices: readonly OutboxNotice[];
  readonly onAction: (id: string, actionId: string) => void;
  readonly onDismiss: (id: string) => void;
}

/** The notices for a given list; kept apart from the store so tests can render any list. */
export function OutboxView({ notices, onAction, onDismiss }: OutboxViewProps) {
  if (notices.length === 0) return null;
  return (
    <section className="aplos-outbox" aria-label="Outbox" role="status">
      {notices.map(notice => (
        <div key={notice.id} className="aplos-outbox__item">
          <PartIcon name="alert" size="sm" />
          <div className="aplos-outbox__body">
            <p className="aplos-outbox__text">{notice.message}</p>
            <div className="aplos-outbox__actions">
              {notice.actions.map(action => (
                <Button
                  key={action.id}
                  variant="text"
                  size="sm"
                  label={action.label}
                  onPress={() => onAction(notice.id, action.id)}
                />
              ))}
              <Button
                variant="icon"
                size="sm"
                icon="close"
                label="Dismiss"
                onPress={() => onDismiss(notice.id)}
              />
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

/** The sidebar's outbox, live. */
export function OutboxHost() {
  const notices = useSyncExternalStore(subscribeOutbox, getOutbox, getOutbox);
  return <OutboxView notices={notices} onAction={runOutboxAction} onDismiss={removeOutboxNotice} />;
}
