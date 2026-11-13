/**
 * The sidebar's outbox notice (DESIGN 7.1, 7.13, 7.15): a failed send stays here, calm and out of the way, after its
 * toast has faded. StatusSlot's shape: the alert icon in --stamp-ink and two or three short lines, with the verbs
 * as text buttons. It never covers the pane and never takes focus. The words and verbs come from the send that
 * failed, so the toast and this notice always agree.
 */
import { useSyncExternalStore } from 'react';
import { Button } from '../ui/buttons-keys';
import { PartIcon } from '../ui/surfaces/parts';
import { dismissToast, navigate } from './index';
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
    <section className="aplos-outbox" aria-label="Messages that did not send">
      {notices.map(notice => (
        <div key={notice.id} className="aplos-outbox__item" data-notice-id={notice.id}>
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

/** Closing the notice also closes its toast, so resolving either one resolves both. */
export function dismissOutboxNotice(id: string): void {
  dismissToast(id);
  removeOutboxNotice(id);
}

/**
 * Where focus goes when the pressed button's notice is about to leave: the first button of another notice, else the
 * Settings row. Taken before the notice goes, so focus never drops to the page.
 */
export function focusAfterLeaving(id: string): HTMLElement | null {
  const items = [...document.querySelectorAll<HTMLElement>('.aplos-outbox__item')];
  const here = items.findIndex(item => item.dataset.noticeId === id);
  const other = items[here + 1] ?? items[here - 1];
  return (
    other?.querySelector<HTMLElement>('button') ??
    document.querySelector<HTMLElement>('[data-puck-id="settings"] button')
  );
}

function leaving(id: string, run: () => void): void {
  focusAfterLeaving(id)?.focus();
  run();
}

/** The sidebar's outbox, live. */
export function OutboxHost() {
  const notices = useSyncExternalStore(subscribeOutbox, getOutbox, getOutbox);
  return (
    <OutboxView
      notices={notices}
      onAction={(id, actionId) => leaving(id, () => runOutboxAction(id, actionId))}
      onDismiss={id => leaving(id, () => dismissOutboxNotice(id))}
    />
  );
}

/** Props for `OutboxFlagView`. */
export interface OutboxFlagViewProps {
  readonly count: number;
  readonly onPress: () => void;
}

/** The small stand-in for the notice where the sidebar is not drawn (minimised or collapsed): an alert with a name. */
export function OutboxFlagView({ count, onPress }: OutboxFlagViewProps) {
  if (count === 0) return null;
  return (
    <div className="aplos-outbox-flag">
      <Button
        variant="icon"
        size="sm"
        icon="alert"
        tone="danger"
        label="Messages that did not send"
        onPress={onPress}
      />
    </div>
  );
}

/** The flag, live; it opens Drafts, where every unsent message is saved. */
export function OutboxFlag() {
  const notices = useSyncExternalStore(subscribeOutbox, getOutbox, getOutbox);
  return <OutboxFlagView count={notices.length} onPress={() => navigate('drafts')} />;
}
