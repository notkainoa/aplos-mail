// LowBand (DESIGN §7.2 Low-importance band, §13). Mockups: home.html.
// One line on --raised: the label, up to three sender names in --dim with "and N more", and the plain count on
// the right. No count badge on the left and no comma list after a badge. Click or Return opens the sheet.

import type { LowBandProps } from '../props';
import { formatCount } from './internal/format';
import { useTooltipText } from './internal/keys';

const SHOWN = 3;

/**
 * The names and the "and N more" suffix apart, so the suffix survives when the names are cut. `extra` counts
 * senders the caller did not pass, so "and N more" can run past the list it was given.
 */
export function lowBandParts(
  senders: readonly string[],
  extra = 0,
): { names: string; more: string } {
  const names = senders.filter(s => s.length > 0);
  if (names.length === 0) return { names: '', more: '' };
  const hidden = Math.max(0, names.length - SHOWN) + Math.max(0, Math.floor(extra));
  if (hidden === 0) return listed(names);
  return { names: names.slice(0, SHOWN).join(', '), more: `and ${formatCount(hidden)} more` };
}

function listed(names: readonly string[]): { names: string; more: string } {
  if (names.length <= 1) return { names: names[0] ?? '', more: '' };
  return { names: `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`, more: '' };
}

/** "Field Notes", "Field Notes and Cedar Market", "Field Notes, Cedar Market and Google", "…, Google and 3 more". */
export function lowBandNames(senders: readonly string[]): string {
  const { names, more } = lowBandParts(senders);
  return more ? `${names} ${more}` : names;
}

/** The low-importance band option on Home. */
export function LowBand({
  id,
  senders,
  moreSenders,
  count,
  cursor,
  density,
  commandId,
  onOpen,
}: LowBandProps) {
  const tip = useTooltipText();
  const { names, more } = lowBandParts(senders, moreSenders);
  return (
    <div
      id={id}
      role="option"
      aria-selected={cursor}
      className="ui-low-band"
      data-density={density}
      data-cursor={cursor ? 'true' : undefined}
      title={tip('Open low importance', commandId)}
      onClick={onOpen}
    >
      <span className="ui-low-band__label">Low importance</span>
      {names ? (
        <span className="ui-low-band__senders">
          <span className="ui-low-band__names" dir="auto">
            {names}
          </span>
          {more ? <span className="ui-low-band__more"> {more}</span> : null}
        </span>
      ) : null}
      <span className="ui-low-band__count">{formatCount(count)}</span>
    </div>
  );
}
