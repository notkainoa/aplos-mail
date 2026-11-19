/**
 * The few icons the settings family draws, from the closed `IconName` set (DESIGN 4.7). Lucide is the fallback
 * source; size and stroke come from the stylesheet (`--icon`, `--icon-stroke`), never from props.
 * Replace with the shared Icon once the buttons-keys family lands.
 */
import { Check, ChevronDown, CircleAlert } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import type { IconName } from '../props';

type SettingsIconName = Extract<IconName, 'alert' | 'check' | 'chevron-down'>;

const ICONS: Record<SettingsIconName, ComponentType<SVGProps<SVGSVGElement>>> = {
  alert: CircleAlert,
  check: Check,
  'chevron-down': ChevronDown,
};

export function SetIcon({ name }: { name: SettingsIconName }) {
  const Glyph = ICONS[name];
  return <Glyph className="ui-set-icon" aria-hidden="true" focusable="false" />;
}
