/**
 * The command target's state (F9, gap list U1/A12): every mounted `useCommandTarget` owns a slot.
 * A slot may name its `region` (the element its component draws); of the slots holding a target, the
 * one whose region is the deepest to contain the focused element wins (the innermost focused setter),
 * and when focus is in none of them the latest-mounted slot wins. Targets compare by value, so the
 * snapshot keeps its reference until kind, id, title or detail change.
 */
import { createStore } from './store-core';
import type { TargetSummary } from '../commands';

/** One component's contribution; `set(null)` clears it without giving up its place in the order. */
export interface TargetSlot {
  set(target: TargetSummary | null): void;
  remove(): void;
}

/** The element a slot's component draws, read when the winner is decided (a React ref satisfies it). */
export interface TargetRegion {
  readonly current: { contains(node: unknown): boolean } | null;
}

interface Slot {
  target: TargetSummary | null;
  readonly region: TargetRegion | undefined;
}

const targetStore = createStore<TargetSummary | null>(null);
const slots: Slot[] = [];
let listening = false;

/** True when both name the same thing in the same words. */
export function sameTarget(a: TargetSummary | null, b: TargetSummary | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.id === b.id && a.title === b.title && a.detail === b.detail;
}

/** Of the slots whose region holds the focused element, the deepest (regions nest); a later slot wins a tie. */
function focusedSlot(candidates: readonly Slot[]): Slot | undefined {
  if (typeof document === 'undefined' || !document.activeElement) return undefined;
  const active = document.activeElement;
  let best: Slot | undefined;
  for (const slot of candidates) {
    const region = slot.region?.current;
    if (!region || !region.contains(active)) continue;
    const outer = best?.region?.current;
    if (!best || (outer?.contains(region) ?? true)) best = slot;
  }
  return best;
}

function publish(): void {
  const holding = slots.filter(slot => slot.target !== null);
  const winner = (focusedSlot(holding) ?? holding.at(-1))?.target ?? null;
  if (!sameTarget(winner, targetStore.get())) targetStore.set(winner);
}

/** Focus moves change which region holds it, so the winner is decided again (listening only while a slot has a region). */
function onFocusChange(): void {
  publish();
}

function onFocusOut(): void {
  setTimeout(publish, 0);
}

function syncFocusListeners(): void {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  const wanted = slots.some(slot => slot.region);
  if (wanted === listening) return;
  listening = wanted;
  const toggle = wanted ? document.addEventListener : document.removeEventListener;
  toggle.call(document, 'focusin', onFocusChange);
  toggle.call(document, 'focusout', onFocusOut);
}

/** Adds a slot after every existing one (the latest-mounted setter); `region` makes it win while focus is inside it and no deeper slot holds focus. */
export function addTargetSlot(region?: TargetRegion): TargetSlot {
  const slot: Slot = { target: null, region };
  slots.push(slot);
  syncFocusListeners();
  return {
    set(target) {
      slot.target = target;
      publish();
    },
    remove() {
      const index = slots.indexOf(slot);
      if (index >= 0) slots.splice(index, 1);
      syncFocusListeners();
      publish();
    },
  };
}

/** The winning target now. */
export const getTarget = targetStore.get;

/** Subscribes to target changes (for `useSyncExternalStore`). */
export const subscribeTarget = targetStore.subscribe;
