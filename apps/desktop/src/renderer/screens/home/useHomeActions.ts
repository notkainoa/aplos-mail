/**
 * Wires `createHomeActions` to the live screen: the latest snapshot through a ref, the hold gate, the registry, the
 * shell's toasts and the data layer's `api`. The actions object is stable for the life of the screen, so the
 * registry's handlers attach once; everything that changes is read when a key arrives.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { CommandContext, Registry } from '../../commands';
import { api, undoStack, type HoldController, type ThreadId } from '../../data';
import { dismissToast, pushToast, UNDO_TOAST_MS } from '../../shell';
import type { CommitKind } from '../../ui/props';
import {
  createHomeActions,
  type HomeActions,
  type HomeDeps,
  type HomeSnapshot,
  type OpenHow,
  type RunStatus,
} from './homeActions';
import { attachHomeCommands } from './homeCommands';

/** The screen's inputs to its actions. */
export interface HomeActionInputs {
  readonly snapshot: RefObject<HomeSnapshot>;
  readonly registry: Registry;
  /** The command context a command run from here (Space on a reply) gets. */
  readonly context: () => CommandContext;
  readonly hold: HoldController;
  readonly setCursor: (key: string | null) => void;
  /** Draws a commit on the element under the cursor and extends the hold. */
  readonly commit: (kind: CommitKind, holdIds: readonly string[]) => void;
  readonly openThread: (id: ThreadId, how: OpenHow) => void;
  readonly openLow: () => void;
  readonly oneByOne: () => void;
  readonly openMore: () => void;
}

/** What the screen reads back: the thread a Remind toast is offering (so R is live), and the actions. */
export interface HomeActionState {
  readonly actions: HomeActions;
  readonly remindOffer: boolean;
}

function statusOf(result: ReturnType<Registry['run']>): RunStatus {
  switch (result.status) {
    case 'ran':
    case 'failed':
    case 'unknown':
    case 'unhandled':
    case 'disabled':
      return result.status;
    default:
      return 'other';
  }
}

function undoLabelOf(registry: Registry, commandId: string, fallback: string): string {
  const entry = registry.get(commandId);
  return (entry?.kind === 'command' ? entry.spec.undo?.label : undefined) ?? fallback;
}

/** The actions for one mounted Home, attached to `registry` until it unmounts. */
export function useHomeActions(inputs: HomeActionInputs): HomeActionState {
  const latest = useRef(inputs);
  useEffect(() => {
    latest.current = inputs;
  });
  const offer = useRef<ThreadId | null>(null);
  const [remindOffer, setRemindOffer] = useState(false);

  useEffect(() => {
    if (!remindOffer) return;
    const timer = setTimeout(() => {
      offer.current = null;
      setRemindOffer(false);
    }, UNDO_TOAST_MS);
    return () => clearTimeout(timer);
  }, [remindOffer]);

  const actions = useMemo(() => {
    const now = () => latest.current;
    const deps: HomeDeps = {
      snapshot: () => now().snapshot.current ?? EMPTY,
      setCursor: key => now().setCursor(key),
      act: args => api.thread.act(args),
      push: pushToast,
      dismiss: dismissToast,
      hold: { extend: ids => now().hold.extend(ids) },
      commit: (kind, ids) => now().commit(kind, ids),
      offerReminder: id => {
        offer.current = id;
        setRemindOffer(id !== null);
      },
      reminderOffer: () => offer.current,
      runCommand: id => statusOf(now().registry.run(id, now().context())),
      openThread: (id, how) => now().openThread(id, how),
      openLow: () => now().openLow(),
      oneByOne: () => now().oneByOne(),
      openMore: () => now().openMore(),
      undoLabel: (commandId, fallback) => undoLabelOf(now().registry, commandId, fallback),
    };
    return createHomeActions(deps);
  }, []);

  const { registry, oneByOne, openMore } = inputs;
  useEffect(
    () => attachHomeCommands(registry, actions, { oneByOne, more: openMore, undo: undoLast }),
    [registry, actions, oneByOne, openMore],
  );
  return { actions, remindOffer };
}

const EMPTY: HomeSnapshot = { items: [], key: null, rowOf: () => undefined, state: null };

function undoLast(): void {
  undoStack.undoLast();
}
