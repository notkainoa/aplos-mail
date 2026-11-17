/** Settings → Calendar: the connected accounts' calendar access first, then week start and what is added from
 * mail (DESIGN 7.10). The Accounts block is never silent: every account gets its state line and action from
 * `calendarAccessOf` — grant for "Calendar not allowed yet", reconnect for "Needs sign-in again" — and with no
 * accounts it says so and offers Add account. An account whose calendar is on gets the editing half from
 * `calendarEditingOf`: quiet "Enable editing" while it is off (a refused write reads "Turn on editing" in
 * attention tone instead), nothing once it is on. */
import { Button } from '../../../ui/buttons-keys';
import { accountLabel } from '../../../ui/accountLabel';
import { Switch } from '../../../ui/controls';
import {
  CALENDAR_ACCESS_COPY,
  calendarAccessOf,
  calendarCountLine,
  calendarEditingOf,
  calendarWriteRefused,
  EDITING_COPY,
} from '../../calendar/accountCalendarState';
import { Group, NotAvailable, Row, Select } from '../parts';
import {
  CALENDAR_EDITING_COPY,
  hasCapability,
  tagColor,
  WEEK_START_OPTIONS,
  withCurrent,
} from '../settings.model';
import type { SectionProps } from './types';

const WEEK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Which calendars of the account nothing can be added to, in words: the demo's say why; others name themselves. */
function viewOnlyNote(
  mine: readonly { name: string; readOnly?: boolean }[],
  demo: boolean,
): string {
  if (demo) return 'Demo calendars are view-only';
  const names = mine.filter(c => c.readOnly).map(c => c.name);
  if (names.length === 0) return '';
  return names.length === mine.length ? 'All view-only' : `${names.join(', ')} view-only`;
}

/** The account's calendar count when there is no access line to show (demo and non-Google accounts), else undefined; view-only calendars are named after it. */
function ownCalendars(
  data: SectionProps['data'],
  account: { id: string; demo?: boolean },
): string | undefined {
  const mine = data.calendars?.filter(c => c.accountId === account.id) ?? [];
  if (mine.length === 0) return undefined;
  const note = viewOnlyNote(mine, account.demo === true);
  return note ? `${calendarCountLine(mine.length)} · ${note}` : calendarCountLine(mine.length);
}

export function Calendar({ data, actions, host }: SectionProps) {
  const { calendar, ui } = data.settings;
  const accountsBlock = (
    <Group id="set-calendar-accounts" label="Accounts">
      {data.accounts.length === 0 ? (
        <Row
          section="calendar"
          anchor="calendarPermission"
          description={CALENDAR_ACCESS_COPY.noAccounts}
          control={
            host.renderAddAccount ? (
              <Button
                variant="text"
                label="Add account"
                icon="plus"
                onPress={() => actions.openAddAccount()}
              />
            ) : undefined
          }
        />
      ) : (
        data.accounts.map((a, i) => {
          const access = calendarAccessOf(a, data.calendars);
          // Editing is an add-on on the 'on' state only: "· Editing off" with Enable editing, "· Editing
          // on" with nothing. A refused write (calendarWrite row) replaces the line with its own words
          // and labels the same action "Turn on editing" — attention tone, but not an error banner.
          const editing = access?.kind === 'on' ? calendarEditingOf(a) : null;
          const refused = editing === 'off' && calendarWriteRefused(a);
          const line = refused
            ? EDITING_COPY.notice
            : editing
              ? `${access?.line ?? ''} · ${
                  editing === 'on' ? CALENDAR_EDITING_COPY.on : CALENDAR_EDITING_COPY.off
                }`
              : (access?.line ?? ownCalendars(data, a));
          const attention =
            refused || access?.kind === 'not-allowed' || access?.kind === 'needs-signin';
          const action = refused
            ? { label: CALENDAR_EDITING_COPY.turnOn, mode: 'enableEditing' as const }
            : editing === 'off'
              ? { label: EDITING_COPY.action, mode: 'enableEditing' as const }
              : access?.action;
          return (
            <Row
              key={a.id}
              section="calendar"
              anchor="calendarPermission"
              idSuffix={a.id}
              label={accountLabel(a)}
              mark={tagColor(a, i)}
              description={line ?? undefined}
              descriptionTone={attention ? 'attention' : 'default'}
              control={
                action && host.renderReconnect ? (
                  <Button
                    variant="text"
                    label={action.label}
                    ariaLabel={`${accountLabel(a)}: ${action.label}`}
                    onPress={() => actions.startReconnect(a.id, action.mode)}
                  />
                ) : undefined
              }
            />
          );
        })
      )}
    </Group>
  );
  if (!hasCapability(data.session, 'calendar')) {
    return (
      <>
        {accountsBlock}
        <Group id="set-calendar-all" label="Calendar">
          <NotAvailable section="calendar" anchor="weekStart" />
          <NotAvailable section="calendar" anchor="autoAddPlans" />
          <NotAvailable section="calendar" anchor="gmailEvents" />
        </Group>
      </>
    );
  }
  const week = ui.calendar.weekStart === undefined ? 'system' : String(ui.calendar.weekStart);
  return (
    <>
      {accountsBlock}
      <Group id="set-calendar-view" label="View">
        <Row
          section="calendar"
          anchor="weekStart"
          description="The first column of the week and month views."
          control={
            <Select
              label="Week starts on"
              options={withCurrent(WEEK_START_OPTIONS, week, WEEK_DAYS[Number(week)] ?? week)}
              value={week}
              onChange={v =>
                void actions.setUi({
                  calendar: v === 'system' ? {} : { weekStart: Number(v) },
                })
              }
            />
          }
        />
      </Group>
      <Group id="set-calendar-mail" label="From your mail">
        <Row
          section="calendar"
          anchor="autoAddPlans"
          description="When off, plans found in mail show as outlines until you confirm them."
          control={id => (
            <Switch
              label="Add plans automatically"
              labelledBy={id}
              checked={calendar.autoAddPlans}
              onChange={on => void actions.set({ calendar: { autoAddPlans: on } })}
            />
          )}
        />
        <Row
          section="calendar"
          anchor="gmailEvents"
          description="Show events Google adds from your mail, like flights and bookings."
          control={id => (
            <Switch
              label="Events from Gmail"
              labelledBy={id}
              checked={calendar.providerEventsFromMail}
              onChange={on => void actions.set({ calendar: { providerEventsFromMail: on } })}
            />
          )}
        />
      </Group>
    </>
  );
}
