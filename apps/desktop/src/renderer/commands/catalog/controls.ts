// DESIGN §8 commands: keys that operate the focused widget. Part of the catalog (../catalog.ts re-exports it).
import type { ControlSpec } from '../types';

const DIGITS_1_TO_9 = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Keys that operate the focused widget itself (see ControlSpec). */
export const CONTROLS: readonly ControlSpec[] = [
  {
    id: 'ask.previousSuggestion',
    label: 'Previous suggestion',
    keys: [{ chord: 'ArrowUp', inTextField: true }],
    contexts: ['ask'],
    repeat: true,
  },
  {
    id: 'ask.nextSuggestion',
    label: 'Next suggestion',
    keys: [{ chord: 'ArrowDown', inTextField: true }],
    contexts: ['ask'],
    repeat: true,
  },
  {
    id: 'ask.acceptProposal',
    label: 'Accept the proposal',
    keys: ['Enter'],
    contexts: ['ask'],
    onlyWhen: 'proposal',
  },
  {
    id: 'ask.declineProposal',
    label: 'Not now',
    keys: ['Escape'],
    contexts: ['ask'],
    onlyWhen: 'proposal',
  },

  {
    id: 'palette.next',
    label: 'Next result',
    keys: [{ chord: 'ArrowDown', inTextField: true }],
    contexts: ['palette'],
    repeat: true,
  },
  {
    id: 'palette.previous',
    label: 'Previous result',
    keys: [{ chord: 'ArrowUp', inTextField: true }],
    contexts: ['palette'],
    repeat: true,
  },
  {
    id: 'palette.choose',
    label: 'Run the command',
    keys: [{ chord: 'Enter', inTextField: true }],
    contexts: ['palette'],
  },
  {
    id: 'palette.pickNumber',
    label: 'Run that result',
    keys: DIGITS_1_TO_9.map(d => ({ chord: d, inTextField: true })),
    contexts: ['palette'],
    onlyWhen: 'emptyField',
  },
  {
    id: 'palette.confirmDestructive',
    label: 'Confirm a destructive command',
    keys: [{ chord: 'shift+Enter', inTextField: true }],
    contexts: ['palette'],
  },
  {
    id: 'palette.back',
    label: 'Go up a level, then close',
    keys: [{ chord: 'Escape', inTextField: true }],
    contexts: ['palette'],
  },

  { id: 'menu.next', label: 'Next item', keys: ['ArrowDown'], contexts: ['menu'], repeat: true },
  {
    id: 'menu.previous',
    label: 'Previous item',
    keys: ['ArrowUp'],
    contexts: ['menu'],
    repeat: true,
  },
  { id: 'menu.choose', label: 'Choose the item', keys: ['Enter'], contexts: ['menu'] },
  { id: 'menu.pickNumber', label: 'Choose that item', keys: DIGITS_1_TO_9, contexts: ['menu'] },
  { id: 'menu.close', label: 'Close the menu', keys: ['Escape'], contexts: ['menu'] },

  {
    id: 'datePicker.next',
    label: 'Next date',
    keys: ['ArrowDown'],
    contexts: ['datePicker'],
    repeat: true,
  },
  {
    id: 'datePicker.previous',
    label: 'Previous date',
    keys: ['ArrowUp'],
    contexts: ['datePicker'],
    repeat: true,
  },
  {
    id: 'datePicker.preset',
    label: 'Choose a preset',
    keys: ['1', '2', '3', '4', '5'],
    contexts: ['datePicker'],
  },
  { id: 'datePicker.confirm', label: 'Set the date', keys: ['Enter'], contexts: ['datePicker'] },
  {
    id: 'datePicker.close',
    label: 'Close the date picker',
    keys: ['Escape'],
    contexts: ['datePicker'],
  },

  // Destructive confirmations default to Cancel: Return cancels, ⇧Return confirms (DESIGN §7.9).
  {
    id: 'dialog.default',
    label: 'Choose the highlighted button',
    keys: ['Enter'],
    contexts: ['dialog'],
  },
  {
    id: 'dialog.confirmDestructive',
    label: 'Confirm',
    keys: ['shift+Enter'],
    contexts: ['dialog'],
  },
  { id: 'dialog.cancel', label: 'Cancel', keys: ['Escape'], contexts: ['dialog'] },

  // DESIGN §7.2: a tap of → marks the cursor row done, holding it marks everything done; the sheet keeps that state.
  {
    id: 'lowImportance.next',
    label: 'Next sender',
    keys: ['ArrowDown'],
    contexts: ['lowImportance'],
    repeat: true,
  },
  {
    id: 'lowImportance.previous',
    label: 'Previous sender',
    keys: ['ArrowUp'],
    contexts: ['lowImportance'],
    repeat: true,
  },
  {
    id: 'lowImportance.markAllDone',
    label: 'Mark done (hold to mark all)',
    keys: [{ chord: 'ArrowRight', followsSwipe: true }],
    contexts: ['lowImportance'],
  },
  {
    id: 'lowImportance.close',
    label: 'Close the sheet',
    keys: ['Escape'],
    contexts: ['lowImportance'],
  },

  { id: 'onboarding.continue', label: 'Continue', keys: ['Enter'], contexts: ['onboarding'] },
  { id: 'onboarding.back', label: 'Go back a step', keys: ['Escape'], contexts: ['onboarding'] },
  {
    id: 'onboarding.skipSetup',
    label: 'Skip setup',
    keys: ['Escape'],
    contexts: ['onboarding'],
    onlyWhen: 'welcome',
  },
  // DESIGN §7.12 [F8]: the first-sync screen owns Esc in every state, drill included.
  { id: 'onboarding.openAplos', label: 'Open Aplos', keys: ['Escape'], contexts: ['firstSync'] },

  // "Try the keys while you wait" (DESIGN §7.12): practice letters only, nothing real changes.
  {
    id: 'drill.next',
    label: 'Next practice letter',
    keys: ['j', 'ArrowDown'],
    contexts: ['drill'],
    repeat: true,
  },
  {
    id: 'drill.previous',
    label: 'Previous practice letter',
    keys: ['k', 'ArrowUp'],
    contexts: ['drill'],
    repeat: true,
  },
  { id: 'drill.suggested', label: 'Run the suggestion', keys: ['Space'], contexts: ['drill'] },
  { id: 'drill.done', label: 'Mark it Done', keys: ['e'], contexts: ['drill'] },
  { id: 'drill.ask', label: 'Ask about it', keys: ['a'], contexts: ['drill'] },
  { id: 'drill.undo', label: 'Bring it back', keys: ['z'], contexts: ['drill'] },
  { id: 'drill.leave', label: 'Back to progress', keys: ['Enter'], contexts: ['drill'] },

  // The reconnect and consent sheets the shell hosts (shell/index.ts openSheet).
  {
    id: 'sheet.default',
    label: 'Choose the highlighted button',
    keys: ['Enter'],
    contexts: ['sheet'],
  },
  { id: 'sheet.cancel', label: 'Cancel', keys: ['Escape'], contexts: ['sheet'] },
];
