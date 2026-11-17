/**
 * Wires `createHomeActions` to the live screen: the latest snapshot through a ref, the hold gate, the registry, the
 * shell's toasts and the data layer's `api`. The actions object is stable for the life of the screen, so the
 * registry's handlers attach once; everything that changes is read when a key arrives.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Registry } from '../../commands';
import { api, undoStack, type HoldController, type ThreadId } from '../../data';
import {
  dismissToast,
  openCompose,
  pushToast,
  useRegisterCommands,
  useShellRegistry,
  useToasts,
} from '../../shell';
import type { ToastData } from '../../ui/props';
import type { CommitKind } from '../../ui/props';
import {
  createHomeActions,
  type HomeActions,
  type HomeDeps,
  type HomeSnapshot,
  type OpenHow,
} from './homeActions';
import type { HomeBulkDeps } from './homeBulk';
import { commandsForHome } from './homeCommands';

/** The screen's inputs to its actions. */
export interface HomeActionInputs {
  readonly snapshot: RefObject<HomeSnapshot>;
  readonly hold: HoldController;
  /** The bulk pick and its confirmation; absent where the screen cannot pick (the one-by-one view). */
  readonly bulk?: HomeBulkDeps;
  readonly setCursor: (key: string | null, departed?: string) => void;
  /** Draws a commit on the row that is leaving (the one acted on, not necessarily under the cursor) and extends the hold. */
  readonly commit: (kind: CommitKind, holdIds: readonly string[], rowId: ThreadId) => void;
  readonly openThread: (id: ThreadId, how: OpenHow) => void;
  readonly openLow: () => void;
  readonly oneByOne: () => void;
  readonly openMore: () => void;
  /** Opens the bulk bar's More menu (`.` while rows are picked). */
  readonly openBulkMore?: () => void;
  /** Opens the Later date presets for this thread. */
  readonly openDatePicker: (id: ThreadId) => void;
}

/** Home's inputs, and the ⋯ menu's "Why it's here" (I). */
export interface HomeKeyInputs extends HomeActionInputs {
  readonly why: () => void;
}

/** What the screen reads back: the thread a Remind toast is offering (so R is live), and the actions. */
export interface HomeActionState {
  readonly actions: HomeActions;
  readonly remindOffer: boolean;
}

/** Whether the toast that offers the reminder is still on screen; an offer with no toast of its own never lives. */
export function offerLives(opId: string | undefined, toasts: readonly ToastData[]): boolean {
  return opId !== undefined && toasts.some(toast => toast.id === opId);
}

function undoLabelOf(registry: Registry, commandId: string, fallback: string): string {
  const entry = registry.get(commandId);
  return (entry?.kind === 'command' ? entry.spec.undo?.label : undefined) ?? fallback;
}

/**
 * The actions for one mounted screen and the Remind offer they raise, with no keys attached: Home attaches its own
 * table (`useHomeActions`), the one-by-one view another (`commandsForOneByOne`).
 */
export function useHomeActionState(inputs: HomeActionInputs): HomeActionState {
  const { registry } = useShellRegistry();
  const latest = useRef(inputs);
  useEffect(() => {
    latest.current = inputs;
  });
  const offer = useRef<ThreadId | null>(null);
  // The offer lives as long as its own toast does: the toast owns the clock (it waits while hovered or focused).
  const [current, setCurrent] = useState<{ readonly id: ThreadId; readonly opId?: string } | null>(
    null,
  );
  const remindOffer = current !== null;
  const toasts = useToasts();

  useEffect(() => {
    if (!current || offerLives(current.opId, toasts)) return;
    offer.current = null;
    setCurrent(null);
  }, [current, toasts]);

  const canPick = inputs.bulk !== undefined;
  const actions = useMemo(() => {
    const now = () => latest.current;
    const bulk: HomeBulkDeps = {
      selection: {
        toggle: id => now().bulk?.selection.toggle(id),
        extendTo: id => now().bulk?.selection.extendTo(id),
        selectAll: () => now().bulk?.selection.selectAll(),
        clear: () => now().bulk?.selection.clear(),
      },
      confirmation: () => now().bulk?.confirmation() ?? null,
      setConfirmation: next => now().bulk?.setConfirmation(next),
    };
    const deps: HomeDeps = {
      snapshot: () => now().snapshot.current ?? EMPTY,
      setCursor: (key, departed) => now().setCursor(key, departed),
      act: args => api.thread.act(args),
      push: pushToast,
      dismiss: dismissToast,
      hold: { extend: ids => now().hold.extend(ids) },
      bulk: canPick ? bulk : undefined,
      commit: (kind, ids, rowId) => now().commit(kind, ids, rowId),
      offerReminder: (id, opId) => {
        offer.current = id;
        setCurrent(id === null ? null : { id, opId });
      },
      openDatePicker: id => now().openDatePicker(id),
      reminderOffer: () => offer.current,
      openThread: (id, how) => now().openThread(id, how),
      forward: id => openCompose({ forward: { threadId: id } }),
      openLow: () => now().openLow(),
      oneByOne: () => now().oneByOne(),
      openMore: () => now().openMore(),
      openBulkMore: () => now().openBulkMore?.(),
      undoLabel: (commandId, fallback) => undoLabelOf(registry, commandId, fallback),
    };
    return createHomeActions(deps);
  }, [registry, canPick]);

  return { actions, remindOffer };
}

/** The actions for one mounted Home, with Home's keys attached to the registry until it unmounts. */
export function useHomeActions(inputs: HomeKeyInputs): HomeActionState {
  const state = useHomeActionState(inputs);
  const { actions } = state;
  const { oneByOne, why } = inputs;
  const table = useMemo(
    () =>
      commandsForHome(actions, {
        oneByOne,
        more: () => actions.more(),
        why,
        undo: () => undoLast(actions),
      }),
    [actions, oneByOne, why],
  );
  useRegisterCommands(table);
  return state;
}

const EMPTY: HomeSnapshot = { items: [], key: null, rowOf: () => undefined, state: null };

/** Z: undoes the newest change; if it was the operation behind the live reminder offer, the offer ends with it. */
export function undoLast(actions: HomeActions): void {
  const outcome = undoStack.undoLast();
  if (outcome?.kind === 'operation') actions.undone(outcome.opId);
}
