/** NavHead: a quiet sidebar group label, `small` 500 `--dim`, e.g. "Mail", "Calendars" (DESIGN 6, 7.1). */
import type { ComponentPropsMap } from '../props';

export function NavHead({ label, id }: ComponentPropsMap['NavHead']) {
  return (
    <div className="ui-nav-head" id={id}>
      {label}
    </div>
  );
}
