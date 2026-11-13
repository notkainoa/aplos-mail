// The catalog names icons as SF Symbols (DESIGN §4.7); the UI draws the closed set in ui/props.ts. A screen building a
// PaletteItem or a menu row from a command passes `uiIconFor(spec.icon)`. Type-only import: no UI code loads here.
import type { IconName as UiIconName } from '../ui/props';
import type { IconName } from './types';

export const UI_ICON_FOR_COMMAND: Readonly<Record<IconName, UiIconName>> = {
  checkmark: 'check',
  'checkmark.circle': 'check-circle',
  clock: 'clock',
  bookmark: 'bookmark',
  trash: 'trash',
  'square.and.pencil': 'compose',
  'text.bubble': 'bubble',
  calendar: 'calendar',
  'arrowshape.turn.up.left': 'reply',
  'arrowshape.turn.up.left.2': 'reply-all',
  'arrowshape.turn.up.right': 'forward',
  'arrow.right': 'arrow-right',
  magnifyingglass: 'search',
  paperclip: 'paperclip',
  link: 'link',
  cart: 'cart',
  phone: 'phone',
  doc: 'file',
  gearshape: 'settings',
  house: 'home',
  tray: 'tray',
  paperplane: 'send',
  shield: 'spam',
  keyboard: 'keyboard',
};

/** The UI icon for a command's icon; undefined when the command has none (the palette keeps its icon column empty). */
export function uiIconFor(icon: IconName | undefined): UiIconName | undefined {
  return icon ? UI_ICON_FOR_COMMAND[icon] : undefined;
}
