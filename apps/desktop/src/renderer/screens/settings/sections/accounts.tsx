/**
 * Settings → Accounts (DESIGN 7.10, 7.1, 7.15). One name per account; its state sits on the row. Reconnect appears
 * for `needsReauth`, `needsPermission` and when `reconnectBy` is within 24 hours, and opens the reconnect flow;
 * only the first account that needs one gets the filled button. The demo account has Reset and Remove.
 */
import { Button } from '../../../ui/buttons-keys';
import { Switch, SwatchPicker } from '../../../ui/controls';
import { calendarAccessOf } from '../../calendar/accountCalendarState';
import { Group, Row } from '../parts';
import { accountRows, hasCapability, leaseLine, NOT_AVAILABLE, tagColor } from '../settings.model';
import type { SectionProps } from './types';

export function Accounts({ data, view, actions, host }: SectionProps) {
  const rows = accountRows(data.accounts, data.now);
  const real = data.accounts.map((a, i) => ({ account: a, index: i })).filter(x => !x.account.demo);
  return (
    <>
      <Group id="set-accounts-list" label="Accounts">
        {rows.length === 0 ? (
          <Row section="accounts" anchor="accountsList" description="No accounts yet." />
        ) : null}
        {rows.map(r => {
          const account = data.accounts.find(a => a.id === r.id);
          const access = account ? calendarAccessOf(account, data.calendars) : null;
          return (
            <Row
              key={r.id}
              section="accounts"
              anchor="accountsList"
              idSuffix={r.id}
              label={r.name}
              meta={r.meta || undefined}
              mark={r.mark}
              description={r.description}
              descriptionTone={r.tone}
              below={
                // When the row already carries its own reconnect/grant control it says everything — never stack a second copy.
                access && !r.reconnect ? (
                  <div className="settings-cal-access">
                    <span className="settings-cal-access__line">{access.line}</span>
                    {access.action && host.renderReconnect ? (
                      <Button
                        variant="text"
                        size="sm"
                        label={access.action.label}
                        ariaLabel={`${r.name}: ${access.action.label}`}
                        onPress={() => actions.startReconnect(r.id, access.action!.mode)}
                      />
                    ) : null}
                  </div>
                ) : undefined
              }
              control={
                <>
                  {r.reconnect && host.renderReconnect ? (
                    <Button
                      variant={r.reconnect.filled ? 'filled' : 'text'}
                      label={r.reconnect.label}
                      onPress={() => actions.startReconnect(r.id, r.reconnect!.mode)}
                    />
                  ) : null}
                  {r.demo ? (
                    <>
                      <Button
                        variant="text"
                        label="Reset"
                        busy={view.busy.demo === true}
                        onPress={() => void actions.resetDemo()}
                      />
                      <Button
                        variant="text"
                        label="Remove"
                        disabled={view.busy.demo === true}
                        onPress={() => actions.askRemoveDemo()}
                      />
                    </>
                  ) : (
                    <Button
                      variant="text"
                      label="Remove"
                      onPress={() => actions.askRemoveAccount(r.id)}
                    />
                  )}
                </>
              }
            />
          );
        })}
        <Row
          section="accounts"
          anchor="addAccount"
          description={host.renderAddAccount ? 'Connect another Google account.' : NOT_AVAILABLE}
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
      </Group>

      {real.map(({ account, index }) => (
        <Group
          key={account.id}
          id={`set-accounts-${account.id}`}
          label={account.name || account.address}
        >
          <Row
            section="accounts"
            anchor="accountAi"
            idSuffix={account.id}
            description="Off means nothing from it is sent to a provider."
            control={id => (
              <Switch
                label={`Use ${account.name || account.address} mail for AI`}
                labelledBy={id}
                checked={account.aiAllowed}
                onChange={on => void actions.setAccount(account.id, { aiAllowed: on })}
              />
            )}
          />
          <Row
            section="accounts"
            anchor="accountColour"
            idSuffix={account.id}
            control={id => (
              <SwatchPicker
                label="Colour"
                labelledBy={id}
                value={tagColor(account, index)}
                onChange={c => void actions.setAccount(account.id, { colorTag: c })}
              />
            )}
          />
          {hasCapability(data.session, 'workflowSync') || account.lease
            ? (() => {
                const lease = leaseLine(account, data.session.device.name);
                return (
                  <Row
                    section="accounts"
                    anchor="lease"
                    idSuffix={account.id}
                    label={lease.text}
                    control={
                      lease.action ? (
                        <Button
                          variant="text"
                          label={lease.action === 'use' ? 'Use this Mac' : 'Let Aplos choose'}
                          busy={view.busy[`lease:${account.id}`] === true}
                          onPress={() => void actions.takeLease(account.id, lease.action === 'use')}
                        />
                      ) : undefined
                    }
                  />
                );
              })()
            : null}
        </Group>
      ))}
    </>
  );
}
