/**
 * The outbox: what a send leaves behind when it could not go (DESIGN 7.13, 7.15 "Send failed"). A failure's toast
 * fades after 8 s so it never covers the pane; this store keeps the same words, with the same verbs, until the owner
 * deals with them (Try again, Edit or Dismiss), and the sidebar shows them quietly above the status slot. The
 * draft is always saved, so dismissing the notice never loses anything.
 */
import { createStore } from './store-core';

/** One verb on a notice. */
export interface OutboxAction {
  readonly id: string;
  readonly label: string;
}

/** What the sidebar draws for one unsent message. */
export interface OutboxNotice {
  /** One per failure; pushing the same id again replaces the notice in place. */
  readonly id: string;
  /** Plain words, what happened and what is safe: "Couldn’t send to Jordan. Your draft is saved." */
  readonly message: string;
  readonly actions: readonly OutboxAction[];
}

/** A notice with the handler its verbs call; the store keeps handlers apart from what it publishes. */
export interface PushedOutboxNotice extends OutboxNotice {
  readonly onAction: (actionId: string) => void;
}

const view = createStore<readonly OutboxNotice[]>([]);
const handlers = new Map<string, PushedOutboxNotice>();

function publish(): void {
  view.set([...handlers.values()].map(({ id, message, actions }) => ({ id, message, actions })));
}

/** Adds a notice, or replaces the one with the same id. */
export function addOutboxNotice(notice: PushedOutboxNotice): void {
  handlers.set(notice.id, notice);
  publish();
}

/** Removes a notice; a no-op once it has gone. */
export function removeOutboxNotice(id: string): void {
  if (handlers.delete(id)) publish();
}

/** Runs a verb. The notice leaves first: a send that fails again comes back as a fresh notice. */
export function runOutboxAction(id: string, actionId: string): void {
  const notice = handlers.get(id);
  if (!notice) return;
  removeOutboxNotice(id);
  notice.onAction(actionId);
}

/** Empties the outbox (tests). */
export function resetOutbox(): void {
  handlers.clear();
  publish();
}

export const getOutbox = view.get;
export const subscribeOutbox = view.subscribe;
