/**
 * Find in this email (⌘F, DESIGN 7.5): one quiet field above the thread that drives the frame's `findQuery`. Esc closes
 * it and gives the keys back to the reader; the field owns every other key while it has focus.
 */
import type { KeyboardEvent } from 'react';
import { TextField } from '../../ui/controls';

/** Props for `FindBar`. */
export interface FindBarProps {
  readonly query: string;
  readonly onChange: (query: string) => void;
  readonly onClose: () => void;
}

export function FindBar({ query, onChange, onClose }: FindBarProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    event.preventDefault();
    onClose();
  };
  return (
    <div className="aplos-reader__find" onKeyDown={onKeyDown}>
      <TextField
        id="reader-find"
        label="Find in this email"
        placeholder="Find in this email"
        type="search"
        icon="search"
        value={query}
        onChange={onChange}
        autoFocus
      />
    </div>
  );
}
