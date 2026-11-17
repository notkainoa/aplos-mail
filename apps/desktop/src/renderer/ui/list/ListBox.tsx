// ListBox (DESIGN §11.3). Mockups: home.html, inbox.html, later.html, done.html, search.html.
// The one focusable listbox for every mail list. It owns aria-activedescendant; keys come from the registry,
// so the component binds none. Children are ListGroups or options (ListRow, FocusSlot › FocusLetter, LowBand).

import { useLayoutEffect, useRef, useState } from 'react';
import type { ListBoxProps } from '../props';
import { InListbox } from './internal/Action';

const DUE_CHIP = '.ui-list-row__line > .ui-chip[data-kind="due"]';

/**
 * Whether this list has ever shown a due chip. The chip slot (list.css) stays reserved for the life of the list, so
 * triaging the last chip row away never slides every subject left.
 */
function useChipSlotKept(box: { current: HTMLDivElement | null }): boolean {
  const [kept, setKept] = useState(false);
  // After every render, on purpose: the chips are the children's, which this component cannot list as dependencies.
  // It sets state once (`kept` then stays true), so it never loops.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!kept && box.current?.querySelector(DUE_CHIP)) setKept(true);
  });
  return kept;
}

/** The listbox container: id, accessible name and the option under the cursor. */
export function ListBox({ binding, multiselectable, children, ref }: ListBoxProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const slotKept = useChipSlotKept(box);
  return (
    <div
      ref={node => {
        box.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as { current: HTMLDivElement | null }).current = node;
      }}
      data-chip-slot={slotKept ? 'kept' : undefined}
      id={binding.id}
      className="ui-list-box"
      role="listbox"
      tabIndex={0}
      aria-label={binding.label}
      aria-activedescendant={binding.activeDescendantId}
      aria-multiselectable={multiselectable ? true : undefined}
    >
      <InListbox.Provider value={true}>{children}</InListbox.Provider>
    </div>
  );
}
