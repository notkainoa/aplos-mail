/**
 * Home's triage motion: a thin wrapper that gives the motion runtime the list's hold gate and the leaving element, and
 * decorates the ghost with the commit chip and edge cloned from hidden templates the screen renders (so the real
 * `CommitChip` and `CommitEdge` markup is what flies). Without a DOM or without a full hold gate it does nothing
 * visible and only extends the hold. React never re-renders per frame: the ghost is the motion's own clone.
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { HoldController, Id } from '../../data';
import {
  browserEnv,
  createMotionRuntime,
  createTriageMotion,
  type HoldGate,
  type MotionRuntime,
  type TriageMotion,
} from '../../motion';
import type { CommitKind } from '../../ui/props';

/** `useHold` returns a `HoldGate` at runtime; the frozen type is the narrower `HoldController`. */
export function isGate(hold: HoldController): hold is HoldGate {
  return 'pointerEnter' in hold && 'subscribe' in hold;
}

interface Running {
  readonly runtime: MotionRuntime;
  readonly triage: TriageMotion;
}

function start(hold: HoldController): Running | null {
  if (typeof window === 'undefined' || !isGate(hold)) return null;
  const runtime = createMotionRuntime(browserEnv());
  const { scheduler, ghosts, rapid } = runtime;
  return { runtime, triage: createTriageMotion({ scheduler, ghosts, hold, rapid }) };
}

function templateFor(templates: HTMLElement | null, part: 'chip' | 'edge', kind: CommitKind) {
  const found = templates?.querySelector(`[data-part="${part}"][data-kind="${kind}"] > *`);
  return found instanceof HTMLElement ? (found.cloneNode(true) as HTMLElement) : undefined;
}

/** Returns `commit(kind, element, holdIds)`: draws one committed triage key and extends the hold. */
export function useHomeMotion(
  hold: HoldController,
  templates: RefObject<HTMLElement | null>,
): (kind: CommitKind, element: HTMLElement | null, holdIds: readonly Id[]) => void {
  const running = useRef<Running | null>(null);
  useEffect(() => {
    running.current = start(hold);
    return () => {
      running.current?.triage.dispose();
      running.current?.runtime.dispose();
      running.current = null;
    };
  }, [hold]);
  return useCallback(
    (kind, element, holdIds) => {
      const motion = running.current;
      if (!motion) return hold.extend(holdIds);
      const surface = element?.classList.contains('ui-focus-letter') ? 'letter' : 'row';
      motion.triage.commit({
        kind,
        surface,
        element,
        holdIds,
        release: 'hide',
        decorate: clone => {
          const chip = templateFor(templates.current, 'chip', kind);
          const edge = templateFor(templates.current, 'edge', kind);
          clone.append(...[edge, chip].filter((part): part is HTMLElement => part !== undefined));
          return { chip, edge };
        },
      });
    },
    [hold, templates],
  );
}
