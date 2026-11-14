/**
 * Settings → Accounts (DESIGN 7.10, 7.1, 7.15). One name per account; its state sits on the row. Reconnect appears
 * for `needsReauth`, `needsPermission` and when `reconnectBy` is within 24 hours, and opens the reconnect flow;
 * only the first account that needs one gets the filled button. The demo account has Reset and Remove.
 */
import { Button } from '../../../ui/buttons-keys';
import { accountLabel } from '../../../ui/accountLabel';
import { Switch, SwatchPicker } from '../../../ui/controls';
import { calendarAccessOf } from '../../calendar/accountCalendarState';
import { Group, Row } from '../parts';
import { accountRows, leaseLine, NOT_AVAILABLE, tagColor } from '../settings.model';
import type { SectionProps } from './types';

type Props = Pick<SectionProps, 'data' | 'view' | 'actions'>;

/** Which Mac syncs: drawn only when there is something to choose, so there is never a row with no control. */
function LeaseRow({
  account,
  data,
  view,
  actions,
}: Props & { account: Props['data']['accounts'][number] }) {
  const lease = leaseLine(account, data.session.device.name, data.settings.ui.devDetails);
  if (lease.action === null) return null;
  return (
    <Row
      section="accounts"
      anchor="lease"
      idSuffix={account.id}
      label={lease.text}
      control={
        <Button
          variant="text"
          label={lease.action === 'use' ? 'Use this Mac' : 'Let Aplos choose'}
          busy={view.busy[`lease:${account.id}`] === true}
          onPress={() => void actions.takeLease(account.id, lease.action === 'use')}
        />
      }
    />
  );
}

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
          // The row's own reconnect/grant control (and its red line) already says "sign in again": never stack a copy of
          // that. Any other state keeps its line; only an action that would repeat the row's own control is dropped.
          const hideLine = access?.kind === 'needs-signin' && r.reconnect !== undefined;
          const repeatsRowControl =
            r.reconnect !== undefined && r.reconnect.mode === access?.action?.mode;
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
                access && !hideLine ? (
                  <div className="settings-cal-access">
                    <span className="settings-cal-access__line">{access.line}</span>
                    {access.action && host.renderReconnect && !repeatsRowControl ? (
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
                        tone="danger"
                        label="Remove"
                        disabled={view.busy.demo === true}
                        onPress={() => actions.askRemoveDemo()}
                      />
                    </>
                  ) : (
                    <Button
                      variant="text"
                      tone="danger"
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
          description={host.renderAddAccount ? 'Connect another account.' : NOT_AVAILABLE}
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
        <Group key={account.id} id={`set-accounts-${account.id}`} label={accountLabel(account)}>
          <Row
            section="accounts"
            anchor="accountAi"
            idSuffix={account.id}
            description="Off keeps this mailbox out of every AI feature."
            control={id => (
              <Switch
                label={`Use ${accountLabel(account)} mail for AI`}
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
                label="Color"
                labelledBy={id}
                value={tagColor(account, index)}
                onChange={c => void actions.setAccount(account.id, { colorTag: c })}
              />
            )}
          />
          <LeaseRow account={account} {...{ data, view, actions }} />
        </Group>
      ))}
    </>
  );
}
