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
import { CLOSED, pickerReducer } from '../later/laterPicker';
import { laterPresets, momentLabel } from '../later/laterPresets';
import { LaterPicker } from '../later/LaterPicker';
import { rowDomId } from './HomeList';

/** What the screen reads back: opening it, whether it shows, and the element to render. */
export interface HomeDatePicker {
  readonly open: (id: ThreadId) => void;
  readonly isOpen: boolean;
  readonly element: ReactElement;
}

export function useHomeDatePicker(hold: HoldController): HomeDatePicker {
  const [picker, dispatch] = useReducer(pickerReducer, CLOSED);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const nowMs = useNow({ granularity: 'minute' });
  const weekStart = useSettings()?.ui.calendar?.weekStart ?? 1;
  const presets = useMemo(() => laterPresets(nowMs, weekStart), [nowMs, weekStart]);
  const latest = useRef({ nowMs, presets });
  useEffect(() => {
    latest.current = { nowMs, presets };
  });

  const open = useCallback((id: ThreadId) => {
    const { nowMs: now, presets: list } = latest.current;
    setAnchor(document.getElementById(rowDomId(id)));
    dispatch({ type: 'open', id, today: toIsoDate(now), first: list[0]?.id ?? 'tomorrow' });
  }, []);

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
  return { open, isOpen: picker.open, element };
}
