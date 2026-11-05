/**
 * Find in this email (⌘F, DESIGN 7.5): one quiet field above the thread that drives the frame's `findQuery`. Esc closes
 * it and gives the keys back to the reader; the field owns every other key while it has focus. Esc also closes it from
 * outside the field (the reader's back command closes find before it leaves), and another ⌘F refocuses the field.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { KEY_LAYER_ATTRIBUTE } from '../../mailframe';
import { TextField } from '../../ui/controls';

/** While open, the find bar is a layer above the reader: a key relayed from a sealed letter never reaches it. */
const KEY_LAYER = { [KEY_LAYER_ATTRIBUTE]: 'find' };

/** Props for `FindBar`. */
export interface FindBarProps {
  readonly query: string;
  readonly onChange: (query: string) => void;
  readonly onClose: () => void;
  /** Changes on every ⌘F: the field takes focus again and selects the query. */
  readonly focusKey: number;
}

/** Focuses the field and selects the query (the ⌘F effect). */
export function takeFocus(field: Pick<HTMLInputElement, 'focus' | 'select'> | null): void {
  field?.focus();
  field?.select();
}

export function FindBar({ query, onChange, onClose, focusKey }: FindBarProps) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    takeFocus(field.current);
  }, [focusKey]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    event.preventDefault();
    onClose();
  };
  return (
    <div
      className="aplos-reader__find"
      data-focus-key={focusKey}
      {...KEY_LAYER}
      onKeyDown={onKeyDown}
    >
      <TextField
        id="reader-find"
        label="Find in this email"
        placeholder="Find in this email"
        type="search"
        icon="search"
        value={query}
        onChange={onChange}
        ref={field}
      />
    </div>
  );
}
