/**
 * The state behind the Later date picker (DESIGN 6 DatePresets, 7.3): which preset is highlighted, whether the month is
 * open and which day and time are picked. `DatePresets` is controlled, so this is its model. Pure: the screen holds it
 * in a reducer and turns a choice into a moment with `pickedUntil`. A moment in the past is refused, like Overdue as a
 * drop target.
 */
import type { DatePresetId, IsoDate, IsoTime, IsoYearMonth } from '../../ui/props';

export type PickerEntry = DatePresetId | 'date';

export interface PickerState {
  readonly open: boolean;
  /** The thread being re-dated. */
  readonly id: string | null;
  readonly activeId: PickerEntry;
  readonly calendarOpen: boolean;
  readonly month: IsoYearMonth;
  readonly pickedDate?: IsoDate;
  readonly pickedTime: IsoTime;
}

export type PickerEvent =
  | {
      readonly type: 'open';
      readonly id: string;
      readonly today: IsoDate;
      readonly first: DatePresetId;
    }
  | { readonly type: 'active'; readonly entry: PickerEntry; readonly today: IsoDate }
  | { readonly type: 'month'; readonly month: IsoYearMonth }
  | { readonly type: 'day'; readonly date: IsoDate }
  | { readonly type: 'time'; readonly time: IsoTime }
  | { readonly type: 'close' };

const DEFAULT_TIME: IsoTime = '08:00';

export const CLOSED: PickerState = {
  open: false,
  id: null,
  activeId: 'tomorrow',
  calendarOpen: false,
  month: '1970-01',
  pickedTime: DEFAULT_TIME,
};

/** The day after `today` ("2026-10-29" gives "2026-10-30"), in local time. */
export function dayAfter(today: IsoDate): IsoDate {
  const [year = 1970, month = 1, day = 1] = today.split('-').map(Number);
  const next = new Date(year, month - 1, day + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

function opened(id: string, today: IsoDate, first: DatePresetId): PickerState {
  return { ...CLOSED, open: true, id, activeId: first, month: today.slice(0, 7) };
}

/** Highlighting "Pick a date…" opens the month on tomorrow, so Return has a day to confirm. */
function activated(state: PickerState, entry: PickerEntry, today: IsoDate): PickerState {
  if (entry !== 'date') return { ...state, activeId: entry, calendarOpen: false };
  const picked = state.pickedDate ?? dayAfter(today);
  return {
    ...state,
    activeId: 'date',
    calendarOpen: true,
    pickedDate: picked,
    month: picked.slice(0, 7),
  };
}

export function pickerReducer(state: PickerState, event: PickerEvent): PickerState {
  switch (event.type) {
    case 'open':
      return opened(event.id, event.today, event.first);
    case 'active':
      return state.open ? activated(state, event.entry, event.today) : state;
    case 'month':
      return { ...state, month: event.month };
    case 'day':
      return { ...state, pickedDate: event.date };
    case 'time':
      return { ...state, pickedTime: event.time };
    case 'close':
      return CLOSED;
  }
}

/** The picked day and time as a moment, or null when none is picked or it is not in the future. */
export function pickedUntil(state: PickerState, nowMs: number): number | null {
  if (!state.pickedDate) return null;
  const [year = 1970, month = 1, day = 1] = state.pickedDate.split('-').map(Number);
  const [hour = 0, minute = 0] = state.pickedTime.split(':').map(Number);
  const at = new Date(year, month - 1, day, hour, minute).getTime();
  return at > nowMs ? at : null;
}
