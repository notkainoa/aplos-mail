// Every command in DESIGN §8, declared once. Screens attach run/when through the
// registry; nothing else may bind a key. Labels follow DESIGN §10 (plain, no
// exclamation marks); icons come from DESIGN §4.7.
import { ASK_COMMANDS } from './catalog/ask';
import { CALENDAR_COMMANDS } from './catalog/calendar';
import { COMPOSE_COMMANDS } from './catalog/compose';
import { CONTROLS } from './catalog/controls';
import { GLOBAL_COMMANDS } from './catalog/global';
import { LIST_COMMANDS } from './catalog/list';
import { READER_COMMANDS } from './catalog/reader';
import { SEARCH_COMMANDS } from './catalog/search';
import {
  createRegistry,
  type KeymapIssue,
  type Registry,
  type RegistryErrorHandler,
} from './registry';
import { APP_SETTINGS } from './settings';
import {
  DEFAULT_KEY_PREFS,
  type CommandId,
  type CommandSpec,
  type ContextName,
  type KeyPrefs,
  type Keymap,
} from './types';

export {
  ASK_COMMANDS,
  CALENDAR_COMMANDS,
  COMPOSE_COMMANDS,
  CONTROLS,
  GLOBAL_COMMANDS,
  LIST_COMMANDS,
  READER_COMMANDS,
  SEARCH_COMMANDS,
};

/** Every palette command, in catalog order. */
export const COMMANDS: readonly CommandSpec[] = [
  ...GLOBAL_COMMANDS,
  ...SEARCH_COMMANDS,
  ...LIST_COMMANDS,
  ...READER_COMMANDS,
  ...COMPOSE_COMMANDS,
  ...ASK_COMMANDS,
  ...CALENDAR_COMMANDS,
];

/**
 * Commands that are off while a context is on the stack, whatever keys they have
 * after remapping. DESIGN §7.4: Done and Later do nothing on done rows, also in
 * a reader opened from Done (so → / ← do nothing there too).
 */
export const DISABLED_IN: Readonly<Partial<Record<ContextName, readonly CommandId[]>>> = {
  done: ['mail.done', 'mail.later'],
};

/** The app's registry over the full catalog and the registered Settings rows, with the user's prefs applied. */
export function createAppRegistry(prefs?: KeyPrefs, onError?: RegistryErrorHandler): Registry {
  return createRegistry(COMMANDS, {
    controls: CONTROLS,
    disabledIn: DISABLED_IN,
    prefs,
    onError,
    settings: APP_SETTINGS,
  });
}

/**
 * Checks a keymap against the whole catalog without touching the live registry:
 * unreadable entries, reserved chords, clashes ("Already used by Later": the
 * issue's `with`) and shadowing. Settings → Keyboard calls it before saving.
 */
export function conflicts(
  keymap: Keymap,
  prefs: KeyPrefs = DEFAULT_KEY_PREFS,
): readonly KeymapIssue[] {
  return createRegistry(COMMANDS, {
    controls: CONTROLS,
    disabledIn: DISABLED_IN,
    prefs: { ...prefs, keymap },
  }).keymapIssues;
}
