// LowBand (DESIGN §7.2 Low-importance band, §13). Mockups: home.html.
// One line on --raised: the label, up to three sender names in --dim with "and N more", and the plain count on
// the right. No count badge on the left and no comma list after a badge. Click or Return opens the sheet.

import type { LowBandProps } from '../props';
import { formatCount } from './internal/format';
import { tooltipText } from './internal/keys';

const SHOWN = 3;

/** "Field Notes", "Field Notes and Cedar Market", "Field Notes, Cedar Market and Google", "…, Google and 3 more". */
export function lowBandNames(senders: readonly string[]): string {
  const names = senders.filter((s) => s.length > 0);
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= SHOWN) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, SHOWN).join(', ')} and ${formatCount(names.length - SHOWN)} more`;
}

/** The low-importance band option on Home. */
export function LowBand({ id, senders, count, cursor, density, commandId, onOpen }: LowBandProps) {
  const names = lowBandNames(senders);
  return (
    <div
      id={id}
      role="option"
      aria-selected={cursor}
      className="ui-low-band"
      data-density={density}
      data-cursor={cursor ? 'true' : undefined}
      title={tooltipText('Open low importance', commandId)}
      onClick={onOpen}
    >
      <span className="ui-low-band__label">Low importance</span>
      {names ? <span className="ui-low-band__names">{names}</span> : null}
      <span className="ui-low-band__count">{formatCount(count)}</span>
    </div>
  );
}
