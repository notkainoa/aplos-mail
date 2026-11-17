/**
 * The accounts block under the sidebar's Calendars list (DESIGN 7.8): which accounts the view is reading, as a
 * colour dot and a name, and each one's calendar state from `calendarAccessOf`. A gap gets its action instead of
 * silence; a list still arriving says "Syncing…"; no accounts says so. Nothing here is a live region: a state
 * change is visible the next time the owner looks, and the row's own words say what happened.
 */
import type { CSSProperties } from 'react';
import { Button } from '../../ui/buttons-keys';
import type { TagColor } from '../../ui/props';
import { CALENDAR_ACCESS_COPY, type CalendarAccess } from './accountCalendarState';

/** One account's line: identity plus the state `calendarAccessOf` derived (null claims nothing). */
export interface CalendarAccountLine {
  readonly accountId: string;
  readonly name: string;
  readonly mark: TagColor;
  readonly state: CalendarAccess | null;
}

/** What the block draws when there are no account lines: 'syncing' while `Account/get` is unanswered. */
export type CalendarAccountsEmpty = 'syncing' | 'no-accounts';

export interface CalendarAccountsModel {
  readonly lines: readonly CalendarAccountLine[];
  readonly empty: CalendarAccountsEmpty | null;
}

export interface CalendarAccountsProps {
  readonly model: CalendarAccountsModel;
  /** Opens the account's sheet: 'grant' for Allow calendar access, 'reconnect' for Sign in again. */
  readonly onAction: (accountId: string, mode: 'reconnect' | 'grant') => void;
}

/**
 * True when no account has anything to say about its calendar (demo and non-Google accounts claim nothing): the block
 * would only repeat the names and colours the account menu already lists, so the sidebar leaves it out rather than
 * run a heading into the footer with nothing under it.
 */
export function onlyRepeatsAccountMenu(model: CalendarAccountsModel): boolean {
  if (model.lines.length === 0) return false;
  return model.lines.every(line => !line.state?.line && !line.state?.action);
}

export function CalendarAccounts({ model, onAction }: CalendarAccountsProps) {
  if (onlyRepeatsAccountMenu(model)) return null;
  return (
    <div className="cal-accounts">
      <div className="cal-accounts__head">Accounts</div>
      {model.lines.length === 0 ? (
        <div className="cal-accounts__empty">
          {model.empty === 'no-accounts'
            ? CALENDAR_ACCESS_COPY.noAccounts
            : CALENDAR_ACCESS_COPY.syncing}
        </div>
      ) : (
        <ul className="cal-accounts__items">
          {model.lines.map(line => (
            <li key={line.accountId} className="cal-account">
              <div className="cal-account__name">
                <span
                  className="cal-account__dot"
                  aria-hidden="true"
                  style={{ '--swatch': `var(--tag-${line.mark})` } as CSSProperties}
                />
                <span className="cal-account__label" dir="auto">
                  {line.name}
                </span>
              </div>
              {line.state?.line ? (
                <div className="cal-account__state">{line.state.line}</div>
              ) : null}
              {line.state?.action ? (
                <div className="cal-account__action">
                  <Button
                    variant="text"
                    size="sm"
                    label={line.state.action.label}
                    ariaLabel={`${line.name}: ${line.state.action.label}`}
                    onPress={() => onAction(line.accountId, line.state!.action!.mode)}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
