/**
 * PageHead: the row for page-level controls, right-aligned; never a title or subtitle (DESIGN 4.4, 6, 7).
 * The left side may hold only the calendar's date label or the search field.
 */
import type { ComponentPropsMap } from '../props';

export function PageHead({ lead, children }: ComponentPropsMap['PageHead']) {
  return (
    <div className="ui-page-head" data-lead={lead?.kind}>
      {lead?.kind === 'dateLabel' ? (
        <div className="ui-page-head__date">
          <span className="ui-page-head__date-label">{lead.label}</span>
          <span className="ui-page-head__date-range">{lead.range}</span>
        </div>
      ) : null}
      {lead?.kind === 'field' ? <div className="ui-page-head__field">{lead.field}</div> : null}
      {children ? <div className="ui-page-head__controls">{children}</div> : null}
    </div>
  );
}
