/**
 * The Later date picker (DESIGN 6 DatePresets, 7.3, later-picker.html): the five presets on 1 to 5, "Pick a date…" with
 * a month and a time, Return to confirm. `DatePresets` is controlled; this holds its model (`laterPickerState`) and turns a
 * choice into a moment. It owns no keys beyond the component's own; the screen puts the `datePicker` context on the
 * key stack while it shows.
 */
import { useMemo, type Dispatch } from 'react';
import { DatePresets } from '../../ui/calendar';
import type { Anchor, DatePresetId } from '../../ui/props';
import { presetById, presetName, presetOptions, type LaterPreset } from './laterPresets';
import { pickedUntil, type PickerEvent, type PickerState } from './laterPickerState';

/** What a choice resolved to. */
export interface LaterChoice {
  readonly id: string;
  readonly until?: number;
  readonly label: string;
}

/** Props for `LaterPicker`. */
export interface LaterPickerProps {
  readonly state: PickerState;
  readonly dispatch: Dispatch<PickerEvent>;
  readonly anchor: Anchor;
  readonly presets: readonly LaterPreset[];
  /** Local today, "2026-10-29". */
  readonly today: string;
  readonly nowMs: number;
  /** A preset was chosen, or a picked day and time confirmed. */
  readonly onChoose: (choice: LaterChoice) => void;
  /** Names a picked moment for the toast, e.g. "Wed, Nov 4, 8:00 AM". */
  readonly nameOf: (until: number) => string;
}

export function LaterPicker(props: LaterPickerProps) {
  const { state, dispatch, presets, today, nowMs } = props;
  const options = useMemo(() => presetOptions(presets), [presets]);
  const close = () => dispatch({ type: 'close' });
  const choose = (choice: Omit<LaterChoice, 'id'>) => {
    if (state.id === null) return;
    props.onChoose({ id: state.id, ...choice });
    close();
  };
  const pickPreset = (id: DatePresetId) => {
    const preset = presetById(presets, id);
    if (preset) choose({ until: preset.until, label: presetName(id) });
  };
  const confirmDate = () => {
    const until = pickedUntil(state, nowMs);
    if (until !== null) choose({ until, label: props.nameOf(until) });
  };
  return (
    <DatePresets
      open={state.open}
      anchor={props.anchor}
      purpose="later"
      presets={options}
      activeId={state.activeId}
      onActiveChange={entry => dispatch({ type: 'active', entry, today })}
      onPick={pickPreset}
      calendarOpen={state.calendarOpen}
      month={state.month}
      onMonthChange={month => dispatch({ type: 'month', month })}
      pickedDate={state.pickedDate}
      onPickDate={date => dispatch({ type: 'day', date })}
      pickedTime={state.pickedTime}
      onTimeChange={time => dispatch({ type: 'time', time })}
      onConfirmDate={confirmDate}
      onClose={close}
    />
  );
}
