// SwatchPicker (DESIGN §4.2): the six account colours as a radio group. The selected one has a check, so the
// choice never rides on colour alone. Arrows move and select, Space selects, one tab stop (roving tabindex).
import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { Icon } from '../buttons-keys/Icon';
import type { SwatchPickerProps, TagColor } from '../props';

/** Fixed copy: the colour names are not a prop. */
export const SWATCHES: ReadonlyArray<{ color: TagColor; name: string }> = [
  { color: 'sky', name: 'Sky' },
  { color: 'hill', name: 'Hill' },
  { color: 'stamp', name: 'Stamp' },
  { color: 'dusk', name: 'Dusk' },
  { color: 'sand', name: 'Sand' },
  { color: 'ember', name: 'Ember' },
];

export function SwatchPicker({
  label,
  labelledBy,
  value,
  onChange,
  disabled = false,
}: SwatchPickerProps) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, step: number) => {
    const next = (from + step + SWATCHES.length) % SWATCHES.length;
    onChange(SWATCHES[next].color);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.nativeEvent.isComposing || disabled) return;
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    move(index, step);
  };

  return (
    <div
      role="radiogroup"
      className="ui-swatch-picker"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
    >
      {SWATCHES.map(({ color, name }, index) => {
        const selected = color === value;
        return (
          <button
            key={color}
            ref={node => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            className="ui-swatch"
            data-color={color}
            data-state={selected ? 'selected' : 'idle'}
            style={{ '--swatch': `var(--tag-${color})` } as CSSProperties}
            aria-checked={selected}
            aria-label={name}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(color)}
            onKeyDown={event => onKeyDown(event, index)}
          >
            <span className="ui-swatch-dot" aria-hidden="true">
              {selected ? <Icon name="check" size="xs" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
