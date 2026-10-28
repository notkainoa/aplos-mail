/**
 * Drag to reschedule on the DOM (DESIGN 7.3, 5 rule 3): pointer events on the list, a ghost that follows the pointer, and
 * `laterDrag`'s reducer for everything React draws. The ghost is a clone of the row with fixed geometry; the real row
 * stays as an empty slot. React renders when the lift, the group under the pointer or the end changes, never per pixel.
 * Pointer cancel (and Esc) ends the drag with no drop (rule 15).
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { scales } from '../../ui/generated/motion';
import { rowIdOfDom } from '../lists/useMailList';
import type { ListConfig } from '../lists/listKinds';
import {
  dragReducer,
  dropFor,
  groupAt,
  IDLE,
  type DragEvent,
  type DragState,
  type Drop,
  type DropTarget,
  type GroupRect,
} from './laterDrag';
import { GROUP_ORDER, type LaterGroupKey } from './laterGroups';

/** The DOM id of a group's header, which also labels its `group` element. */
export const groupDomId = (key: LaterGroupKey): string => `later-group-${key}`;

/** Inputs for `useLaterDrag`. */
export interface LaterDragOptions {
  readonly config: ListConfig;
  /** The group a row is in, or undefined for a row not on screen. */
  readonly groupOf: (id: string) => LaterGroupKey | undefined;
  readonly targets: Readonly<Record<LaterGroupKey, DropTarget>>;
  readonly onDrop: (drop: Drop) => void;
}

/** What the screen spreads on the list's wrapper, and the state it draws. */
export interface LaterDrag {
  readonly drag: DragState;
  readonly handlers: {
    onPointerDown(event: PointerEvent<HTMLElement>): void;
    onPointerMove(event: PointerEvent<HTMLElement>): void;
    onPointerUp(event: PointerEvent<HTMLElement>): void;
    onPointerCancel(event: PointerEvent<HTMLElement>): void;
  };
}

interface Ghost {
  readonly clone: HTMLElement;
  readonly original: HTMLElement;
  readonly originX: number;
  readonly originY: number;
  readonly before: string;
}

function startGhost(original: HTMLElement, x: number, y: number): Ghost {
  const rect = original.getBoundingClientRect();
  const clone = original.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.setAttribute('inert', '');
  clone.setAttribute('data-lifted', 'true');
  const style = clone.style;
  style.position = 'fixed';
  style.left = `${rect.left}px`;
  style.top = `${rect.top}px`;
  style.width = `${rect.width}px`;
  style.height = `${rect.height}px`;
  style.margin = '0';
  style.pointerEvents = 'none';
  original.ownerDocument.body.appendChild(clone);
  const before = original.style.visibility;
  original.style.visibility = 'hidden';
  return { clone, original, originX: x, originY: y, before };
}

function moveGhost(ghost: Ghost, x: number, y: number): void {
  const dx = x - ghost.originX;
  const dy = y - ghost.originY;
  ghost.clone.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scales.lift})`;
}

function endGhost(ghost: Ghost): void {
  ghost.clone.remove();
  ghost.original.style.visibility = ghost.before;
}

function measure(root: HTMLElement): GroupRect[] {
  return GROUP_ORDER.flatMap(key => {
    const group = root.ownerDocument.getElementById(groupDomId(key))?.closest('[role="group"]');
    if (!group) return [];
    const rect = group.getBoundingClientRect();
    return [{ key, top: rect.top, bottom: rect.bottom }];
  });
}

function rowElementOf(target: EventTarget, config: ListConfig): HTMLElement | null {
  if (!(target instanceof Element) || target.closest('button')) return null;
  const option = target.closest<HTMLElement>('[role="option"]');
  return option && rowIdOfDom(config, option.id) !== null ? option : null;
}

export function useLaterDrag(options: LaterDragOptions): LaterDrag {
  const [drag, setDrag] = useState<DragState>(IDLE);
  const state = useRef<DragState>(IDLE);
  const ghost = useRef<Ghost | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const apply = useCallback((event: DragEvent): DragState => {
    const next = dragReducer(state.current, event);
    if (next === state.current) return next;
    state.current = next;
    setDrag(next);
    return next;
  }, []);

  const finish = useCallback(() => {
    if (ghost.current) endGhost(ghost.current);
    ghost.current = null;
    apply({ type: 'end' });
  }, [apply]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || state.current.phase === 'idle') return;
      event.preventDefault();
      finish();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (ghost.current) endGhost(ghost.current);
    };
  }, [finish]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const { config, groupOf } = latest.current;
      const row = event.button === 0 ? rowElementOf(event.target, config) : null;
      const id = row ? rowIdOfDom(config, row.id) : null;
      const from = id === null ? undefined : groupOf(id);
      if (!row || id === null || from === undefined) return;
      apply({ type: 'press', id, from, x: event.clientX, y: event.clientY });
    },
    [apply],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const before = state.current;
      if (before.phase === 'idle') return;
      const over = groupAt(measure(event.currentTarget), event.clientY);
      const after = apply({ type: 'move', x: event.clientX, y: event.clientY, over });
      if (after.phase !== 'lifted') return;
      // Capture only once the row lifts: capturing at pointer-down would retarget a plain click's events.
      if (before.phase !== 'lifted') event.currentTarget.setPointerCapture?.(event.pointerId);
      if (!ghost.current) {
        const origin = before.phase === 'pressed' ? before : null;
        const row = event.currentTarget.ownerDocument.getElementById(
          `${latest.current.config.id}-row-${after.id}`,
        );
        if (row)
          ghost.current = startGhost(row, origin?.x ?? event.clientX, origin?.y ?? event.clientY);
      }
      if (ghost.current) moveGhost(ghost.current, event.clientX, event.clientY);
    },
    [apply],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const drop = dropFor(state.current, latest.current.targets);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      finish();
      if (drop) latest.current.onDrop(drop);
    },
    [finish],
  );

  const onPointerCancel = useCallback(() => finish(), [finish]);

  return { drag, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } };
}
