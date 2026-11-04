/**
 * The lists' commit motion (DESIGN 4.9): Home's ghost, chip and edge, aimed at the list's rows by DOM id. A bulk commit
 * flies the first few rows it can find; the rest leave when the hold releases. Without a DOM it only extends the hold.
 */
import { useCallback, useRef } from 'react';
import type { HoldController } from '../../data';
import type { CommitKind } from '../../ui/props';
import { useHomeMotion } from '../home/useHomeMotion';
import { MAX_FLYING } from './bulkActions';

/** The mounted elements among these DOM ids; none without a DOM. */
function elementsOf(domIds: readonly string[]): HTMLElement[] {
  if (typeof document === 'undefined') return [];
  const found = domIds.map(id => document.getElementById(id));
  return found.filter((element): element is HTMLElement => element !== null);
}

/** What `useMailList` offers its actions as `ListDeps.commit`, and the hidden templates `MailListView` renders. */
export function useListMotion(hold: HoldController, domIdOf: (id: string) => string) {
  const templates = useRef<HTMLDivElement>(null);
  const motionCommit = useHomeMotion(hold, templates);
  const commit = useCallback(
    (kind: CommitKind, holdIds: readonly string[], rowIds: readonly string[]) => {
      const found = elementsOf(rowIds.slice(0, MAX_FLYING).map(domIdOf));
      if (found.length === 0) return motionCommit(kind, null, holdIds);
      for (const element of found) {
        motionCommit(kind, element, holdIds);
      }
    },
    [domIdOf, motionCommit],
  );
  return { templates, commit };
}
