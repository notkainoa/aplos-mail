/**
 * The command target's state (F9, gap list U1/A12): every mounted `useCommandTarget` owns a slot,
 * and the latest-mounted slot holding a target wins. Targets compare by value, so the snapshot
 * keeps its reference until kind, id, title or detail change.
 */
import { createStore } from './store-core';
import type { TargetSummary } from '../commands';

/** One component's contribution; `set(null)` clears it without giving up its place in the order. */
export interface TargetSlot {
  set(target: TargetSummary | null): void;
  remove(): void;
}

const targetStore = createStore<TargetSummary | null>(null);
const slots: { target: TargetSummary | null }[] = [];

/** True when both name the same thing in the same words. */
export function sameTarget(a: TargetSummary | null, b: TargetSummary | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.id === b.id && a.title === b.title && a.detail === b.detail;
}

function publish(): void {
  const winner = slots.findLast(slot => slot.target !== null)?.target ?? null;
  if (!sameTarget(winner, targetStore.get())) targetStore.set(winner);
}

/** Adds a slot after every existing one (the innermost, latest-mounted setter). */
export function addTargetSlot(): TargetSlot {
  const slot: { target: TargetSummary | null } = { target: null };
  slots.push(slot);
  return {
    set(target) {
      slot.target = target;
      publish();
    },
    remove() {
      const index = slots.indexOf(slot);
      if (index >= 0) slots.splice(index, 1);
      publish();
    },
  };
}

/** The winning target now. */
export const getTarget = targetStore.get;

/** Subscribes to target changes (for `useSyncExternalStore`). */
export const subscribeTarget = targetStore.subscribe;
