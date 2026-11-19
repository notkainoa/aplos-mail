/**
 * Home's date presets (DESIGN 7.3, 7.2): D on the row under the cursor, and "Set a date" on a Later toast, open the same
 * picker Later uses and re-date through the same write (`reschedule`). The picker belongs to the thread that asked for
 * it, so an older toast's button never re-dates the row under the cursor.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  api,
  toIsoDate,
  useNow,
  useSettings,
  type HoldController,
  type ThreadId,
} from '../../data';
import { dismissToast, pushToast } from '../../shell';
import { reschedule } from '../later/laterActions';
import { CLOSED, pickerReducer } from '../later/laterPickerState';
import { laterPresets, momentLabel } from '../later/laterPresets';
import { LaterPicker } from '../later/LaterPicker';
import { rowDomId } from './HomeList';

/** What the screen reads back: opening it, whether it shows, and the element to render. */
export interface HomeDatePicker {
  readonly open: (id: ThreadId) => void;
  readonly isOpen: boolean;
  /** Closes it, for a screen that stops showing it (the list emptied under it). */
  readonly close: () => void;
  readonly element: ReactElement;
}

/**
 * The element the presets hang from: the row's own, or the fallback (the row under the cursor) when the row has left
 * Home, as a Later toast's "Set a date" finds it. Null when neither is on screen, so nothing opens.
 */
export function pickerAnchor(
  id: ThreadId,
  find: (domId: string) => HTMLElement | null,
  fallback: () => HTMLElement | null,
): HTMLElement | null {
  return find(rowDomId(id)) ?? fallback();
}

export function useHomeDatePicker(
  hold: HoldController,
  fallback: () => HTMLElement | null,
): HomeDatePicker {
  const [picker, dispatch] = useReducer(pickerReducer, CLOSED);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const nowMs = useNow({ granularity: 'minute' });
  const weekStart = useSettings()?.ui.calendar?.weekStart ?? 1;
  const presets = useMemo(() => laterPresets(nowMs, weekStart), [nowMs, weekStart]);
  const latest = useRef({ nowMs, presets, fallback });
  useEffect(() => {
    latest.current = { nowMs, presets, fallback };
  });

  const open = useCallback((id: ThreadId) => {
    const { nowMs: now, presets: list, fallback: other } = latest.current;
    const at = pickerAnchor(id, domId => document.getElementById(domId), other);
    // Without an element to hang from the popover never places, and the key context would stay on with nothing shown.
    if (!at) return;
    setAnchor(at);
    dispatch({ type: 'open', id, today: toIsoDate(now), first: list[0]?.id ?? 'tomorrow' });
  }, []);
  const close = useCallback(() => dispatch({ type: 'close' }), []);

  const move = (id: string, until: number | undefined, label: string) =>
    reschedule(
      {
        act: args => api.thread.act(args),
        push: pushToast,
        dismiss: dismissToast,
        hold: ids => hold.extend(ids),
      },
      id,
      until,
      label,
    );
  const element = (
    <LaterPicker
      state={picker}
      dispatch={dispatch}
      anchor={anchor}
      presets={presets}
      today={toIsoDate(nowMs)}
      nowMs={nowMs}
      onChoose={choice => move(choice.id, choice.until, choice.label)}
      nameOf={until => momentLabel(until, nowMs)}
    />
  );
  return { open, close, isOpen: picker.open, element };
}
