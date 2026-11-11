/**
 * The write-side watchers (the providers' 2026-11-11 NOTICE): one component per accepted write
 * follows its `OperationView` through the provider queue — `queued` → `syncing` → `synced` |
 * `failed` | `cancelled` — so the optimistic overlay holds while a held write waits, settles when
 * it lands, and rolls back with the reasonCode sentence when the provider refuses. `operationUpdate`
 * in effects.ts owns the rules; this file is the React plumbing — subscribe, run them, unmount when
 * done. A Retry on a failed hold re-queues the same operation: the effects layer puts the watch
 * back, and the row mounts here again under the same key.
 */
import { useEffect } from 'react';
import { useOperation } from '../../data';
import { operationUpdate, type EffectUi, type WatchedWrite } from './effects';

export interface HeldWritesProps {
  /** One entry per accepted write, removed when its watch is done. */
  readonly watches: readonly WatchedWrite[];
  /** The events window's current ids: a held create's real row replaces its tmp entry on sight. */
  readonly eventIds: ReadonlySet<string>;
  readonly ui: EffectUi;
  /** Remove a finished watch. */
  readonly unwatch: (watch: WatchedWrite) => void;
}

export function HeldWrites({ watches, eventIds, ui, unwatch }: HeldWritesProps) {
  return (
    <>
      {watches.map(watch => (
        <HeldWrite key={watch.opId} watch={watch} eventIds={eventIds} ui={ui} unwatch={unwatch} />
      ))}
    </>
  );
}

function HeldWrite({
  watch,
  eventIds,
  ui,
  unwatch,
}: Omit<HeldWritesProps, 'watches'> & { readonly watch: WatchedWrite }) {
  const view = useOperation(watch.opId);
  useEffect(() => {
    if (operationUpdate(watch, view, ui, eventIds) === 'done') unwatch(watch);
  }, [view, eventIds, watch, ui, unwatch]);
  return null;
}
