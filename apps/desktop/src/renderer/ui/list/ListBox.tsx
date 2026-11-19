// ListBox (DESIGN §11.3). Mockups: home.html, inbox.html, later.html, done.html, search.html.
// The one focusable listbox for every mail list. It owns aria-activedescendant; keys come from the registry,
// so the component binds none. Children are ListGroups or options (ListRow, FocusSlot › FocusLetter, LowBand).

import type { Ref } from 'react';
import type { ListBoxProps } from '../props';
import { InListbox } from './internal/Action';

/** The listbox container: id, accessible name and the option under the cursor. */
export function ListBox({ binding, multiselectable, children, ref }: ListBoxProps) {
  return (
    <div
      ref={ref as Ref<HTMLDivElement>}
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
