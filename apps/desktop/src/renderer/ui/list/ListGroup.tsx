// ListGroup (DESIGN §11.3, §7.2–7.4). Mockups: home.html, later.html, inbox.html, done.html.
// The WAI-ARIA grouped listbox: role="group" labelled by its SectionHeader, the presentational first child.
// An empty section does not render, except while `hold` keeps its label at 0 (DESIGN §5 rule 6).

import type { ListGroupProps } from '../props';
import { SectionHeader } from './SectionHeader';

/** A labelled group of options inside a ListBox. */
export function ListGroup({ header, children }: ListGroupProps) {
  if (header.count === 0 && !header.held) return null;
  return (
    <div
      className="ui-list-group"
      role="group"
      aria-labelledby={header.id}
      data-variant={header.variant}
    >
      <SectionHeader {...header} />
      {children}
    </div>
  );
}
