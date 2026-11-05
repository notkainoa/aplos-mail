/** Settings → Calendar: week start, what is added from mail, and the calendar permission (DESIGN 7.10; map UNCLEAR-9). */
import { Button } from '../../../ui/buttons-keys';
import { Switch } from '../../../ui/controls';
import { Group, NotAvailable, Row, Select } from '../parts';
import { hasCapability, WEEK_START_OPTIONS, withCurrent } from '../settings.model';
import type { SectionProps } from './types';

const WEEK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function Calendar({ data, actions }: SectionProps) {
  const { calendar, ui } = data.settings;
  if (!hasCapability(data.session, 'calendar')) {
    return (
      <Group id="set-calendar-all" label="Calendar">
        <NotAvailable section="calendar" anchor="weekStart" />
        <NotAvailable section="calendar" anchor="autoAddPlans" />
        <NotAvailable section="calendar" anchor="gmailEvents" />
      </Group>
    );
  }
  const week = ui.calendar.weekStart === undefined ? 'system' : String(ui.calendar.weekStart);
  // Accounts whose calendar permission is missing while mail still works.
  const missing = data.accounts.filter(a =>
    a.missingPermissions?.some(m => m.capability === 'calendar'),
  );
  return (
    <>
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
          description="Off shows plans from mail as outlines until you confirm them."
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
        {missing.map(a => (
          <Row
            key={a.id}
            section="calendar"
            anchor="calendarPermission"
            idSuffix={a.id}
            label={a.name || a.address}
            description="Aplos needs permission to use your Google Calendar."
            descriptionTone="attention"
            control={
              <Button
                variant="text"
                label="Reconnect"
                onPress={() => actions.startReconnect(a.id, 'grant')}
              />
            }
          />
        ))}
      </Group>
    </>
  );
}
