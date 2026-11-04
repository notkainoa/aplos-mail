/**
 * The composer's two overlays: ⋯ (DESIGN 7.6: "format, schedule, discard" on the inline reply, "send from, schedule,
 * discard" on the page) and the confirmation "Discard this draft?" (DESIGN 10 Confirms; catalog `compose.discard`).
 */
import { useState } from 'react';
import { Confirm, Menu } from '../../../ui/surfaces';
import type { Anchor, MenuEntry } from '../../../ui/props';
import type { SchedulePreset } from '../model/schedule';

/** The catalog's confirmation for `compose.discard`. */
export const DISCARD_CONFIRM = {
  question: 'Discard this draft?',
  consequence: 'This can’t be undone.',
  confirmLabel: 'Discard',
} as const;

export function DiscardConfirm(props: {
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Confirm
      {...DISCARD_CONFIRM}
      destructive
      presentation="dialog"
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}

const DISCARD_ID = 'discard';

/** The ⋯ entries: Send later with its presets, then Discard. */
export function menuEntries(presets: readonly SchedulePreset[]): readonly MenuEntry[] {
  return [
    { kind: 'label', label: 'Send later' },
    ...presets.map(preset => ({
      kind: 'item' as const,
      id: preset.id,
      label: preset.label,
      icon: 'clock' as const,
    })),
    { kind: 'separator' },
    { kind: 'item', id: DISCARD_ID, label: 'Discard draft', icon: 'trash', danger: true },
  ];
}

export interface ComposeMenuProps {
  readonly anchor: Anchor;
  readonly presets: readonly SchedulePreset[];
  readonly onSchedule: (at: number) => void;
  readonly onDiscard: () => void;
  readonly onClose: () => void;
}

export function ComposeMenu({ anchor, presets, onSchedule, onDiscard, onClose }: ComposeMenuProps) {
  const [activeId, setActiveId] = useState<string>(presets[0]?.id ?? DISCARD_ID);
  const select = (id: string) => {
    onClose();
    if (id === DISCARD_ID) return onDiscard();
    const preset = presets.find(p => p.id === id);
    if (preset) onSchedule(preset.at);
  };
  return (
    <Menu
      open={anchor !== null}
      anchor={anchor}
      label="More"
      entries={menuEntries(presets)}
      activeId={activeId}
      onActiveChange={setActiveId}
      onSelect={select}
      onClose={onClose}
    />
  );
}
