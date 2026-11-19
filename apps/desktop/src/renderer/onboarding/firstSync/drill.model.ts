/**
 * "Try the keys while you wait" (DESIGN 7.12; onboarding-drill.html step1, step3, done): a short practice on invented
 * letters, J/K, Space, E, A, each step with its keycap. Pure: no data calls, no engine, nothing real changes. The
 * drill is a mode of the first-sync screen, so progress stays visible; it is skippable and never blocks.
 */
import type { CommandId, SuggestionIcon } from '../../ui/props';

/** DOM id of the practice list (one drill on screen at a time): the window focuses it on entering the drill (F12). */
export const DRILL_LIST_ID = 'fs-drill-list';

/** One practice letter. Invented names and subjects only. */
export interface DrillLetter {
  readonly id: string;
  readonly sender: string;
  readonly subject: string;
  /** The serif line, written as Aplos writes a summary. */
  readonly summary: string;
  /** The suggestion's literal verb and its action icon (never an AI mark). */
  readonly suggestion: { readonly verb: string; readonly icon: SuggestionIcon };
  /** Hours before the drill's clock, for the date column. */
  readonly hoursAgo: number;
}

export const DRILL_LETTERS: readonly DrillLetter[] = [
  {
    id: 'drill-hollow-creek',
    sender: 'Jordan Park',
    subject: 'Hollow Creek: pick a layout by tomorrow',
    summary: 'Jordan needs your pick of a homepage layout by tomorrow.',
    suggestion: { verb: 'Reply with option B', icon: 'reply' },
    hoursAgo: 1,
  },
  {
    id: 'drill-header-options',
    sender: 'Mina Cho',
    subject: 'Header options, round two',
    summary: 'Mina sent two header options and asks which one you prefer.',
    suggestion: { verb: 'Reply with the second one', icon: 'reply' },
    hoursAgo: 3,
  },
  {
    id: 'drill-review-deck',
    sender: 'Priya Raman',
    subject: 'Q4 review deck',
    summary: 'Priya wants your slides before Friday at 11:00 AM.',
    suggestion: { verb: 'Reply with Thursday', icon: 'reply' },
    hoursAgo: 5,
  },
];

/** The four steps, in order. Keycaps come from these registry commands (drill context). */
export const DRILL_STEPS: readonly {
  readonly commands: readonly CommandId[];
  readonly say: string;
  readonly sub: string;
}[] = [
  {
    commands: ['drill.next', 'drill.previous'],
    say: 'Move through the letters',
    sub: 'J goes down, K goes up.',
  },
  {
    commands: ['drill.suggested'],
    say: 'Run the suggestion',
    sub: 'Space does the one thing Aplos recommends.',
  },
  { commands: ['drill.done'], say: 'Mark it Done', sub: 'E puts it away. Z brings it back.' },
  { commands: ['drill.ask'], say: 'Ask about it', sub: 'A opens Ask beside your mail.' },
];

export const DRILL_COPY = {
  heading: 'Try the keys while you wait',
  sub: 'Practice letters. Nothing real changes.',
  ran: 'Draft ready. Nothing is sent.',
  finished: 'That is the whole loop. Press ? in Aplos any time to see every key.',
  leave: 'Back to progress',
  listLabel: 'Practice letters',
} as const;

/** Where the drill stands. `step` 4 is the end. */
export interface DrillState {
  readonly step: 0 | 1 | 2 | 3 | 4;
  /** Ids still in the list, in order. */
  readonly ids: readonly string[];
  /** Index of the letter under the cursor. */
  readonly cursor: number;
  /** The suggestion ran on the current letter. */
  readonly ran: boolean;
  /** Letters marked Done, newest last, for Z. */
  readonly removed: readonly { readonly id: string; readonly at: number }[];
}

export type DrillKey = 'next' | 'previous' | 'suggested' | 'done' | 'ask' | 'undo';

export const DRILL_START: DrillState = {
  step: 0,
  ids: DRILL_LETTERS.map(l => l.id),
  cursor: 0,
  ran: false,
  removed: [],
};

/** The named states of onboarding-drill.html. */
export function drillPreset(name: 'step1' | 'step2' | 'step3' | 'step4' | 'done'): DrillState {
  const all = DRILL_LETTERS.map(l => l.id);
  const without = all.filter((_, i) => i !== 1);
  const gone = [{ id: all[1], at: 1 }];
  switch (name) {
    case 'step1':
      return DRILL_START;
    case 'step2':
      return { step: 1, ids: all, cursor: 1, ran: false, removed: [] };
    case 'step3':
      return { step: 2, ids: all, cursor: 1, ran: true, removed: [] };
    case 'step4':
      return { step: 3, ids: without, cursor: 1, ran: false, removed: gone };
    case 'done':
      return { step: 4, ids: without, cursor: 1, ran: false, removed: gone };
  }
}

/**
 * One key. J/K move at any step (the first move finishes step 1); Space runs the suggestion on step 2; E marks the
 * letter Done on step 3; A finishes on step 4; Z brings back the last letter marked Done. After the end, keys do
 * nothing. Never touches real mail.
 */
export function drillReduce(state: DrillState, key: DrillKey): DrillState {
  if (state.step >= 4) return state;
  switch (key) {
    case 'next':
    case 'previous': {
      if (state.ids.length === 0) return state;
      const delta = key === 'next' ? 1 : -1;
      const cursor = Math.max(0, Math.min(state.ids.length - 1, state.cursor + delta));
      return {
        ...state,
        cursor,
        ran: cursor === state.cursor ? state.ran : false,
        step: state.step === 0 ? 1 : state.step,
      };
    }
    case 'suggested':
      return state.step === 1 ? { ...state, ran: true, step: 2 } : state;
    case 'done': {
      if (state.step !== 2 || state.ids.length === 0) return state;
      const id = state.ids[state.cursor];
      const ids = state.ids.filter((_, i) => i !== state.cursor);
      return {
        ...state,
        ids,
        cursor: Math.max(0, Math.min(state.cursor, ids.length - 1)),
        ran: false,
        step: 3,
        removed: [...state.removed, { id, at: state.cursor }],
      };
    }
    case 'ask':
      return state.step === 3 ? { ...state, step: 4 } : state;
    case 'undo': {
      const last = state.removed[state.removed.length - 1];
      if (!last) return state;
      const ids = [...state.ids];
      const at = Math.min(last.at, ids.length);
      ids.splice(at, 0, last.id);
      return { ...state, ids, cursor: at, ran: false, removed: state.removed.slice(0, -1) };
    }
  }
}

export function drillLetter(id: string): DrillLetter {
  const letter = DRILL_LETTERS.find(l => l.id === id);
  if (!letter) throw new Error(`Unknown practice letter ${id}`);
  return letter;
}

/** "2 of 4" under the prompt. */
export function drillCount(state: DrillState): string {
  return `${Math.min(state.step, 3) + 1} of ${DRILL_STEPS.length}`;
}

/** A click on a practice row: the cursor moves there, as J/K would. */
export function drillPick(state: DrillState, index: number): DrillState {
  if (state.step >= 4 || index < 0 || index >= state.ids.length || index === state.cursor)
    return state;
  return { ...state, cursor: index, ran: false, step: state.step === 0 ? 1 : state.step };
}
