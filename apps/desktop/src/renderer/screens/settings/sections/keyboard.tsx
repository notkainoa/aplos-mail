/**
 * Settings → Keyboard (DESIGN 7.10, 8, 11.4). Generated from the command registry, so it cannot drift from the real
 * keys. Click a row's keys to record new ones: every key is swallowed until Esc, a taken chord shows "Already used
 * by …" with Replace, and a chord macOS owns is refused with a reason. The single-key switch (WCAG 2.1.4) turns the
 * single-letter shortcuts off; remapping stays available.
 */
import { Switch } from '../../../ui/controls';
import { ErrorLine } from '../../../ui/list';
import { KeyRecorder } from '../../../ui/settings';
import { Anchor, Group, Row, Select } from '../parts';
import { shortcutGroups, SINGLE_KEY_LINE } from '../keyboard.model';
import type { Option } from '../settings.model';
import type { SectionProps } from './types';

const HOLD_OPTIONS: readonly Option[] = [150, 250, 400, 600].map(ms => ({
  id: String(ms),
  label: `${ms} ms`,
}));

export function Keyboard({ data, view, actions, host }: SectionProps) {
  const ui = data.settings.ui;
  const groups = shortcutGroups(ui);
  const anyChanged = Object.keys(ui.keymap).length > 0;
  const rec = view.recording;
  return (
    <>
      <Group
        id="set-keyboard-switches"
        label="Shortcuts"
        action={
          anyChanged
            ? { label: 'Reset all', onSelect: () => actions.resetAllShortcuts() }
            : undefined
        }
      >
        <Row
          section="keyboard"
          anchor="singleKeys"
          description={SINGLE_KEY_LINE}
          control={id => (
            <Switch
              label="Single-key shortcuts"
              labelledBy={id}
              checked={ui.singleKeys}
              onChange={on => actions.setSingleKeys(on)}
            />
          )}
        />
        <Row
          section="keyboard"
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
          section="keyboard"
          anchor="holdMs"
          description="How long to hold R (reply) or A (Ask) before dictation starts."
          control={
            <Select
              label="Hold time"
              options={
                HOLD_OPTIONS.some(o => o.id === String(ui.holdMs))
                  ? HOLD_OPTIONS
                  : [{ id: String(ui.holdMs), label: `${ui.holdMs} ms` }, ...HOLD_OPTIONS]
              }
              value={String(ui.holdMs)}
              onChange={v => void actions.setUi({ holdMs: Number(v) })}
            />
          }
        />
      </Group>

      <Anchor section="keyboard" anchor="shortcuts">
        {groups.map(g => (
          <Group
            key={g.group}
            id={`set-keyboard-${g.group.replace(/\W+/g, '-').toLowerCase()}`}
            label={g.group}
          >
            {g.rows.map(row => {
              const mine = rec && rec.commandId === row.commandId ? rec : null;
              return (
                <div key={row.commandId}>
                  <KeyRecorder
                    commandId={row.commandId}
                    label={row.label}
                    chords={row.shown}
                    changed={row.changed}
                    state={mine ? mine.state : 'idle'}
                    pendingChord={mine?.pendingChord}
                    conflictWith={mine ? mine.conflictWith : row.conflictWith}
                    onStart={() => actions.startRecording(row.commandId)}
                    onChord={chord => actions.recordChord(chord)}
                    onReplace={() => actions.replaceConflict()}
                    onCancel={() => actions.cancelRecording()}
                    onReset={() => actions.resetShortcut(row.commandId)}
                    announce={host.announce}
                  />
                  {mine?.refused ? (
                    <ErrorLine
                      kind="reason"
                      text={mine.refused}
                      retryable={false}
                      placement="settings"
                      onAction={() => {}}
                    />
                  ) : null}
                </div>
              );
            })}
          </Group>
        ))}
      </Anchor>
    </>
  );
}
