/** Settings → Notifications: what may interrupt you (DESIGN 7.13: Do now and Important updates, never Low importance). */
import { Switch } from '../../../ui/controls';
import { Group, NotAvailable, Row } from '../parts';
import { hasCapability, notifyRows } from '../settings.model';
import type { SectionProps } from './types';

export function Notifications({ data, actions }: SectionProps) {
  const n = data.settings.notifications;
  if (!hasCapability(data.session, 'notifications')) {
    return (
      <Group id="set-notifications-all" label="Notifications">
        <NotAvailable section="notifications" anchor="enabled" />
      </Group>
    );
  }
  const accounts = notifyRows(data.accounts);
  return (
    <>
      <Group id="set-notifications-what" label="What to tell me">
        <Row
          section="notifications"
          anchor="enabled"
          description="Do now and Important updates. Low importance never interrupts."
          control={id => (
            <Switch
              label="Show notifications"
              labelledBy={id}
              checked={n.enabled}
              onChange={on => void actions.set({ notifications: { enabled: on } })}
            />
          )}
        />
        <Row
          section="notifications"
          anchor="reminders"
          description="When a reminder or a Later date comes due."
          control={id => (
            <Switch
              label="Reminders"
              labelledBy={id}
              checked={n.reminders}
              disabled={!n.enabled}
              onChange={on => void actions.set({ notifications: { reminders: on } })}
            />
          )}
        />
        <Row
          section="notifications"
          anchor="reconnectReminder"
          description="A notice the day before Google asks you to sign in again."
          control={id => (
            <Switch
              label="Remind me before Gmail asks to reconnect"
              labelledBy={id}
              checked={n.reconnectReminder}
              disabled={!n.enabled}
              onChange={on => void actions.set({ notifications: { reconnectReminder: on } })}
            />
          )}
        />
      </Group>
      {accounts.length > 0 ? (
        <Group id="set-notifications-accounts" label="Accounts">
          {accounts.map(a => (
            <Row
              key={a.id}
              section="notifications"
              anchor="perAccount"
              idSuffix={a.id}
              label={a.name}
              mark={a.mark}
              control={id => (
                <Switch
                  label={`Notify for ${a.name}`}
                  labelledBy={id}
                  checked={a.on}
                  disabled={!n.enabled}
                  onChange={on => void actions.setAccount(a.id, { notifications: on })}
                />
              )}
            />
          ))}
        </Group>
      ) : null}
    </>
  );
}
