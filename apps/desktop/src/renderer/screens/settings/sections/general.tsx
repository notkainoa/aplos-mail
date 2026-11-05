/** Settings → General: appearance, keys and gestures, the window, and the tools allowed on this Mac (DESIGN 7.10). */
import { Button } from '../../../ui/buttons-keys';
import { Switch } from '../../../ui/controls';
import { Puck } from '../../../ui/surfaces';
import { Group, NotAvailable, Row, Select } from '../parts';
import {
  DENSITY_ITEMS,
  densityFromUi,
  densityToUi,
  hasCapability,
  listenerLine,
  SWIPE_OPTIONS,
  THEME_ITEMS,
  toolRows,
} from '../settings.model';
import type { SectionProps } from './types';

export function General({ data, actions }: SectionProps) {
  const { ui, host } = data.settings;
  const caps = data.session;
  return (
    <>
      <Group id="set-general-appearance" label="Appearance">
        <Row
          section="general"
          anchor="theme"
          description="Light, dark, or match the system."
          control={
            <Puck
              kind="segmented"
              role="radio"
              label="Theme"
              items={THEME_ITEMS}
              selectedId={ui.theme}
              onSelect={theme => void actions.setUi({ theme: theme as typeof ui.theme })}
            />
          }
        />
        <Row
          section="general"
          anchor="density"
          description="How much room each row gets."
          control={
            <Puck
              kind="segmented"
              role="radio"
              label="Density"
              items={DENSITY_ITEMS}
              selectedId={densityToUi(ui.density)}
              onSelect={d => void actions.setUi({ density: densityFromUi(d) })}
            />
          }
        />
      </Group>

      <Group id="set-general-keys" label="Keys and gestures">
        <Row
          section="general"
          anchor="keyHints"
          description="Keep every shortcut visible next to its button."
          control={id => (
            <Switch
              label="Show all key hints"
              labelledBy={id}
              checked={ui.keyHints === 'always'}
              onChange={on => void actions.setUi({ keyHints: on ? 'always' : 'tooltip' })}
            />
          )}
        />
        <Row
          section="general"
          anchor="swipeDirection"
          description="Which way Done goes on Home and one by one."
          control={
            <Select
              label="Swipe direction"
              options={SWIPE_OPTIONS}
              value={ui.swipeDirection}
              onChange={v => void actions.setUi({ swipeDirection: v as typeof ui.swipeDirection })}
            />
          }
        />
      </Group>

      <Group id="set-general-window" label="Window">
        <Row
          section="general"
          anchor="sidebarMinimised"
          description="Hide the sidebar until you press [."
          control={id => (
            <Switch
              label="Minimised sidebar"
              labelledBy={id}
              checked={ui.sidebarMinimised}
              onChange={on => void actions.setUi({ sidebarMinimised: on })}
            />
          )}
        />
        {hasCapability(caps, 'loginItem') ? (
          <Row
            section="general"
            anchor="openAtLogin"
            description="Starts quietly so your mail is already in."
            control={id => (
              <Switch
                label="Open Aplos when you log in"
                labelledBy={id}
                checked={host.openAtLogin}
                onChange={on => void actions.set({ host: { openAtLogin: on } })}
              />
            )}
          />
        ) : (
          <NotAvailable section="general" anchor="openAtLogin" />
        )}
        {hasCapability(caps, 'menuBar') ? (
          <Row
            section="general"
            anchor="menuBar"
            description="Mail keeps syncing after the window closes."
            control={id => (
              <Switch
                label="Keep Aplos in the menu bar"
                labelledBy={id}
                checked={host.menuBar}
                onChange={on => void actions.set({ host: { menuBar: on } })}
              />
            )}
          />
        ) : (
          <NotAvailable section="general" anchor="menuBar" />
        )}
      </Group>

      <Tools {...{ data, actions }} />
    </>
  );
}

/** "Allow tools on this Mac" and the tools that may connect, each with Revoke (ARCH 12.3). The token never reaches this screen. */
function Tools({ data, actions }: Pick<SectionProps, 'data' | 'actions'>) {
  const listenerOn = hasCapability(data.session, 'listener');
  const clientsOn = hasCapability(data.session, 'clients');
  const enabled = data.listener?.enabled === true;
  const tools = toolRows(data.clients, data.now);
  return (
    <Group id="set-general-tools-group" label="Tools on this Mac">
      {listenerOn ? (
        <Row
          section="general"
          anchor="allowTools"
          description={listenerLine(data.listener)}
          control={id => (
            <Switch
              label="Allow tools on this Mac"
              labelledBy={id}
              checked={enabled}
              disabled={data.listener === undefined}
              onChange={on => void actions.setListener(on)}
            />
          )}
        />
      ) : (
        <NotAvailable section="general" anchor="allowTools" />
      )}
      {!clientsOn ? (
        <NotAvailable section="general" anchor="tools" />
      ) : !enabled ? (
        <Row
          section="general"
          anchor="tools"
          description="Turn on tools to see the ones that may connect."
        />
      ) : tools.length === 0 ? (
        <Row
          section="general"
          anchor="tools"
          description="No tools yet. Nothing has asked for access."
        />
      ) : (
        tools.map(t => (
          <Row
            key={t.id}
            section="general"
            anchor="tools"
            idSuffix={t.id}
            label={t.name}
            meta={t.kind}
            description={`${t.scopes} · ${t.lastSeen}`}
            control={
              <Button
                variant="text"
                label="Revoke"
                onPress={() => void actions.revokeClient(t.id)}
              />
            }
          />
        ))
      )}
    </Group>
  );
}
