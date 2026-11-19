/**
 * Drag to reschedule (DESIGN 7.3), as pure state. A press becomes a lift after a few pixels; while lifted every group
 * is a drop target named by the moment it resolves to ("Move to Tomorrow, 8:00 AM"); Overdue is never a target, because
 * you cannot reschedule into the past. The drop resolves to a moment; the screen applies it and toasts with Undo. The
 * pointer position is not state: the ghost follows it on the DOM, and this reducer only changes when the lift, the group
 * under the pointer, or the end changes, so React renders a handful of times per drag, not per pixel.
 */
import type { SectionHeaderProps } from '../../ui/props';
import type { LaterGroupKey } from './laterGroups';
import { momentLabel, presetById, type LaterPreset } from './laterPresets';

/** Pixels a press must travel before it lifts the row (a click is not a drag). */
export const DRAG_THRESHOLD = 4;

export type DragState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'pressed';
      readonly id: string;
      readonly from: LaterGroupKey;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly phase: 'lifted';
      readonly id: string;
      readonly from: LaterGroupKey;
      readonly over: LaterGroupKey | null;
    };

export type DragEvent =
  | {
      readonly type: 'press';
      readonly id: string;
      readonly from: LaterGroupKey;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: 'move';
      readonly x: number;
      readonly y: number;
      readonly over: LaterGroupKey | null;
    }
  | { readonly type: 'end' };

export const IDLE: DragState = { phase: 'idle' };

/** The next state. The same object comes back when nothing visible changed. */
export function dragReducer(state: DragState, event: DragEvent): DragState {
  switch (event.type) {
    case 'press':
      return { phase: 'pressed', id: event.id, from: event.from, x: event.x, y: event.y };
    case 'end':
      return state.phase === 'idle' ? state : IDLE;
    case 'move':
      return moved(state, event);
  }
}

function moved(state: DragState, event: Extract<DragEvent, { type: 'move' }>): DragState {
  if (state.phase === 'idle') return state;
  if (state.phase === 'pressed') {
    const travel = Math.hypot(event.x - state.x, event.y - state.y);
    if (travel < DRAG_THRESHOLD) return state;
    return { phase: 'lifted', id: state.id, from: state.from, over: event.over };
  }
  return state.over === event.over ? state : { ...state, over: event.over };
}

/** Where a group's drop lands. Overdue, and Today after the evening is gone, are unavailable. */
export interface DropTarget {
  readonly state: 'available' | 'unavailable';
  /** The moment's name: "Today, 6:00 PM". */
  readonly label: string;
  /** The moment; absent for Someday and for an unavailable target. */
  readonly until?: number;
}

/** The groups a row can be dropped on, other than Overdue. */
export type TargetKey = Exclude<LaterGroupKey, 'overdue'>;

const UNAVAILABLE: DropTarget = { state: 'unavailable', label: '' };

/** Today lands on this evening, This week on tomorrow morning, Someday on Someday (later.html). */
export function dropTargets(
  presets: readonly LaterPreset[],
  nowMs: number,
): Readonly<Record<LaterGroupKey, DropTarget>> {
  const target = (id: 'evening' | 'tomorrow' | 'someday'): DropTarget => {
    const preset = presetById(presets, id);
    if (!preset) return UNAVAILABLE;
    return { state: 'available', label: momentLabel(preset.until, nowMs), until: preset.until };
  };
  return {
    overdue: UNAVAILABLE,
    today: target('evening'),
    week: target('tomorrow'),
    someday: target('someday'),
  };
}

/** The header's drop-target prop for a group, or undefined when nothing is being dragged. */
export function headerDrop(
  group: LaterGroupKey,
  drag: DragState,
  targets: Readonly<Record<LaterGroupKey, DropTarget>>,
): SectionHeaderProps['dropTarget'] {
  if (drag.phase !== 'lifted') return undefined;
  const target = targets[group];
  if (target.state === 'unavailable') return { label: '', state: 'unavailable' };
  return { label: target.label, state: drag.over === group ? 'over' : 'available' };
}

/** What a release does. */
export interface Drop {
  readonly id: string;
  readonly until?: number;
  readonly label: string;
}

/** The drop for a release, or null: not lifted, released outside a group, on the row's own group, or over an unavailable group. */
export function dropFor(
  drag: DragState,
  targets: Readonly<Record<LaterGroupKey, DropTarget>>,
): Drop | null {
  if (drag.phase !== 'lifted' || drag.over === null || drag.over === drag.from) return null;
  const target = targets[drag.over];
  if (target.state === 'unavailable') return null;
  return { id: drag.id, until: target.until, label: target.label };
}

/** A group's measured box, for hit-testing. */
export interface GroupRect {
  readonly key: LaterGroupKey;
  readonly top: number;
  readonly bottom: number;
}

/** The group under a vertical position, or null between groups and outside the list. */
export function groupAt(rects: readonly GroupRect[], y: number): LaterGroupKey | null {
  return rects.find(rect => y >= rect.top && y < rect.bottom)?.key ?? null;
}
