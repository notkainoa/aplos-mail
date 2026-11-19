/**
 * The onboarding window's step machine (DESIGN 7.11; plan 30 U8; Appendix C F1, F9, F12). Pure: no React, no DOM,
 * no engine. The window root feeds it events and runs the effects it returns.
 *
 * Steps: Welcome → Accounts → AI → Voice and permissions → first sync. First sync follows only when a real account was
 * connected in this session; demo mail skips it and hands over at once.
 *
 * The rules it keeps:
 * - A connect that resolves never changes the step (F9). It only records the account, so the window knows a real
 *   account arrived (which decides whether first sync follows) even when the answer comes late.
 * - Every way the session ends asks for exactly one `Setup/end`, with the reason that ended it: `finished` (Finish
 *   setup with nothing to sync, or Open Aplos on first sync), `skipped` (Skip setup on Welcome), `demo` (Try demo
 *   mail), `closed` (the window closed at any moment) (F1, F2). After that nothing navigates. The handoff to the mail
 *   window is asked for once at a time: while it is in flight nothing asks again; once it failed, the step's main
 *   action, Esc, Open Aplos, Skip setup or the notice's Try again asks again, so a failed handoff never leaves the
 *   owner stuck. A closed window asks for nothing. The requested destination rides along: Try again repeats the
 *   destination the failed handoff asked for; a different way of going on asks for its own (first sync's "Open
 *   Settings" alone asks for Settings → AI), so a stale destination never reaches a plain handoff.
 * - Once a real account connected in this session, "Try demo mail" hides: demo mail would skip that account's first
 *   sync.
 * - Esc goes back a step; on Welcome it is "Skip setup"; on first sync it opens Aplos (F8).
 */

import { DEFAULT_KEY_PREFS, keyPrefsFromUi, type KeyPrefs, type UiKeyFields } from '../commands';
import type { OnboardingFooter } from '../ui/props';

/** The window's steps, in order. */
export type StepId = 'welcome' | 'accounts' | 'ai' | 'permissions' | 'firstSync';

/** The steps that show dashes ("Step 2 of 4"); first sync has none. */
export const SETUP_STEPS = ['welcome', 'accounts', 'ai', 'permissions'] as const;

/** Why the setup session ended: the contract's `Setup/end.reason`. */
export type EndReason = 'finished' | 'closed' | 'skipped' | 'demo';

/** Where the window is and what this session has seen. */
export interface FlowState {
  /** The step on screen. */
  readonly step: StepId;
  /** Real (non-demo) accounts connected during this session, in arrival order. */
  readonly connected: readonly string[];
  /** The connect the Accounts step started and is still waiting on, if any. */
  readonly pendingConnectId: string | null;
  /** A demo account exists, so "Try demo mail" hides. */
  readonly hasDemo: boolean;
  /** Set once `Setup/end` was asked for; from then on nothing navigates. */
  readonly ended: EndReason | null;
  /** The handoff to the mail window: not asked yet (or done), in flight, or failed and waiting for a retry. */
  readonly handoff: HandoffPhase;
  /** The destination the in-flight or failed handoff asks for; absent is the mail window's default screen. */
  readonly handoffTo?: 'settings.ai';
}

export type HandoffPhase = 'idle' | 'pending' | 'failed';

/** What the owner, the engine or the window did. */
export type FlowEvent =
  /** The step's main action finished: Add an account, Continue, Finish setup. */
  | { readonly type: 'next' }
  /** Footer Back. */
  | { readonly type: 'back' }
  /** Esc, after the step declined to handle it inside itself. */
  | { readonly type: 'esc' }
  /** "Skip setup" on Welcome. */
  | { readonly type: 'skip' }
  /** `Account/connect` answered with its `connectId`. */
  | { readonly type: 'connectStarted'; readonly connectId: string }
  /** A `connect` frame settled a flow, now or long after the owner moved on. */
  | {
      readonly type: 'connectResolved';
      readonly connectId: string;
      readonly outcome: 'connected' | 'failed' | 'cancelled';
      readonly accountId?: string;
      readonly demo?: boolean;
    }
  /** `Demo/load` finished. */
  | { readonly type: 'demoLoaded' }
  /** First sync's Open Aplos (Return, Esc, or by itself on a clean finish). */
  | { readonly type: 'open' }
  /** First sync's "Open Settings" after a sorting failure: hand over, with Settings → AI open in the mail window. */
  | { readonly type: 'openSettings' }
  /** `Window/finishOnboarding` answered. */
  | { readonly type: 'handoffDone' }
  /** `Window/finishOnboarding` was refused: the step says so and offers Try again. */
  | { readonly type: 'handoffFailed' }
  /** Try again on the handoff notice. */
  | { readonly type: 'retryHandoff' }
  /** The window is closing (red button, ⌘W, `pagehide`). */
  | { readonly type: 'close' };

/** What the root must do. */
export type FlowEffect =
  /** Call `Setup/end {setupId, reason}` once. */
  | { readonly type: 'setupEnd'; readonly reason: EndReason }
  /** Ask main to show the mail window (`Window/finishOnboarding`), with Settings → AI open when `to` says so. */
  | { readonly type: 'handoff'; readonly to?: 'settings.ai' };

/** One step of the reducer. */
export interface FlowResult {
  readonly state: FlowState;
  readonly effects: readonly FlowEffect[];
}

/** Where a fresh window starts. "Show welcome" from Settings starts on Welcome too. */
export function initialFlow(opts: { hasDemo?: boolean; step?: StepId } = {}): FlowState {
  return {
    step: opts.step ?? 'welcome',
    connected: [],
    pendingConnectId: null,
    hasDemo: opts.hasDemo ?? false,
    ended: null,
    handoff: 'idle',
  };
}

const PREVIOUS: Readonly<Record<StepId, StepId | null>> = {
  welcome: null,
  accounts: 'welcome',
  ai: 'accounts',
  permissions: 'ai',
  firstSync: null,
};

const same = (state: FlowState): FlowResult => ({ state, effects: [] });

const handoffEffect = (state: FlowState): FlowEffect =>
  state.handoffTo ? { type: 'handoff', to: state.handoffTo } : { type: 'handoff' };

/** End the session once and hand over to the mail window. */
function finish(
  state: FlowState,
  reason: Exclude<EndReason, 'closed'>,
  patch: Partial<FlowState> = {},
): FlowResult {
  const next: FlowState = { ...state, ...patch, ended: reason, handoff: 'pending' };
  return { state: next, effects: [{ type: 'setupEnd', reason }, handoffEffect(next)] };
}

/** The events that ask for the mail window again after a failed handoff. */
const RETRIES: ReadonlySet<FlowEvent['type']> = new Set([
  'next',
  'esc',
  'open',
  'openSettings',
  'skip',
  'retryHandoff',
]);

/** Records a connected account; never moves the step (F9). */
function recordConnect(
  state: FlowState,
  event: Extract<FlowEvent, { type: 'connectResolved' }>,
): FlowState {
  const pendingConnectId =
    state.pendingConnectId === event.connectId ? null : state.pendingConnectId;
  if (event.outcome !== 'connected') return { ...state, pendingConnectId };
  if (event.demo) return { ...state, pendingConnectId, hasDemo: true };
  const id = event.accountId;
  const connected =
    id && !state.connected.includes(id) ? [...state.connected, id] : state.connected;
  return { ...state, pendingConnectId, connected };
}

export function reduceFlow(state: FlowState, event: FlowEvent): FlowResult {
  // Engine answers are recorded at any moment, even after the session ended; they never navigate.
  if (event.type === 'connectResolved') return same(recordConnect(state, event));
  if (event.type === 'connectStarted') {
    return state.ended ? same(state) : same({ ...state, pendingConnectId: event.connectId });
  }

  // The handoff's answer. A closed window's state no longer matters; it is kept as it is.
  if (event.type === 'handoffDone') {
    return state.handoff === 'pending'
      ? same({ ...state, handoff: 'idle', handoffTo: undefined })
      : same(state);
  }
  if (event.type === 'handoffFailed') {
    return state.handoff === 'pending' && state.ended !== 'closed'
      ? same({ ...state, handoff: 'failed' })
      : same(state);
  }

  if (state.ended) {
    // Closing after the session already ended still marks the window gone: its Setup/end went out with the ending
    // event, and nothing may ask for the mail window again afterwards.
    if (event.type === 'close') {
      return state.ended === 'closed' ? same(state) : same({ ...state, ended: 'closed' });
    }
    // The session is over. Once the handoff failed, any way of going on asks for the mail window again (a failed
    // handoff must not strand the owner); while one is in flight nothing asks twice; a closed window asks for nothing.
    if (state.ended === 'closed' || state.handoff !== 'failed' || !RETRIES.has(event.type))
      return same(state);
    // The retry asks again: Try again repeats the failed handoff's destination, "Open Settings" asks for
    // Settings → AI, and every other way of going on asks plainly — a stale `to` never rides into a handoff the
    // owner did not ask it on.
    const handoffTo =
      event.type === 'openSettings'
        ? ('settings.ai' as const)
        : event.type === 'retryHandoff'
          ? state.handoffTo
          : undefined;
    const next: FlowState = { ...state, handoff: 'pending', handoffTo };
    return { state: next, effects: [handoffEffect(next)] };
  }

  switch (event.type) {
    case 'close':
      return {
        state: { ...state, ended: 'closed' },
        effects: [{ type: 'setupEnd', reason: 'closed' }],
      };
    case 'demoLoaded':
      // A real account connected in this session keeps its first sync: the demo account is only recorded.
      return state.connected.length > 0
        ? same({ ...state, hasDemo: true })
        : finish(state, 'demo', { hasDemo: true });
    case 'skip':
      return state.step === 'welcome' ? finish(state, 'skipped') : same(state);
    case 'open':
      return state.step === 'firstSync' ? finish(state, 'finished') : same(state);
    case 'openSettings':
      return state.step === 'firstSync'
        ? finish(state, 'finished', { handoffTo: 'settings.ai' })
        : same(state);
    case 'retryHandoff':
      return same(state);
    case 'esc':
      if (state.step === 'welcome') return finish(state, 'skipped');
      if (state.step === 'firstSync') return finish(state, 'finished');
      return same({ ...state, step: PREVIOUS[state.step] ?? state.step });
    case 'back': {
      const previous = PREVIOUS[state.step];
      return previous ? same({ ...state, step: previous }) : same(state);
    }
    case 'next':
      switch (state.step) {
        case 'welcome':
          return same({ ...state, step: 'accounts' });
        case 'accounts':
          return same({ ...state, step: 'ai' });
        case 'ai':
          return same({ ...state, step: 'permissions' });
        case 'permissions':
          return state.connected.length > 0
            ? same({ ...state, step: 'firstSync' })
            : finish(state, 'finished');
        case 'firstSync':
          return finish(state, 'finished');
      }
  }
  return same(state);
}

/** What Esc means on a step once the step itself has nothing to undo. */
export type EscIntent = 'back' | 'skipSetup' | 'openAplos' | 'none';

/** A control the window moves focus to (F12): a button by its visible label, or a field by its id. */
export type FocusTarget =
  | { readonly kind: 'button'; readonly label: string }
  | { readonly kind: 'field'; readonly id: string };

/** The derived facts the window draws from the flow. */
export interface FlowView {
  readonly step: StepId;
  /** Short dashes for "Step 2 of 4"; absent on first sync. */
  readonly dashes?: { readonly step: number; readonly of: number };
  /** "Try demo mail" in the top strip: only on Welcome and Accounts while no demo account exists. */
  readonly tryDemo: boolean;
  /** What Esc does when the step has nothing of its own to close. */
  readonly esc: EscIntent;
  /** The command-registry context stack for this step. */
  readonly contexts: readonly ('onboarding' | 'firstSync')[];
  /** The registry condition that turns Esc into "Skip setup". */
  readonly welcome: boolean;
  /** The step-level main action to focus, when the step has no internal states (Welcome, permissions). */
  readonly focus?: FocusTarget;
  /** The handoff to the mail window failed: the step shows the notice with Try again, and Return retries. */
  readonly handoffFailed: boolean;
}

/** Step dashes: Welcome is 1 of 4 … permissions 4 of 4. */
export function dashesFor(step: StepId): { step: number; of: number } | undefined {
  const at = (SETUP_STEPS as readonly StepId[]).indexOf(step);
  return at < 0 ? undefined : { step: at + 1, of: SETUP_STEPS.length };
}

/** The label of each step's filled main action, where the step has one fixed action. */
export const MAIN_LABEL = {
  welcome: 'Add account',
  permissions: 'Finish setup',
} as const;

export function flowView(state: FlowState): FlowView {
  const { step } = state;
  const esc: EscIntent = state.ended
    ? 'none'
    : step === 'welcome'
      ? 'skipSetup'
      : step === 'firstSync'
        ? 'openAplos'
        : 'back';
  return {
    step,
    dashes: dashesFor(step),
    tryDemo:
      (step === 'welcome' || step === 'accounts') &&
      !state.hasDemo &&
      !state.ended &&
      state.connected.length === 0,
    esc,
    contexts: step === 'firstSync' ? ['onboarding', 'firstSync'] : ['onboarding'],
    welcome: step === 'welcome',
    focus:
      step === 'welcome'
        ? { kind: 'button', label: MAIN_LABEL.welcome }
        : step === 'permissions'
          ? { kind: 'button', label: MAIN_LABEL.permissions }
          : undefined,
    handoffFailed: state.ended !== null && state.ended !== 'closed' && state.handoff === 'failed',
  };
}

/**
 * The `setupId` a new connect carries: the session's, until the session ended. A connect after a demo or a skipped
 * setup (the handoff failed, so the window is still here) belongs to no session.
 */
export function sessionSetupId(state: FlowState, setupId: string | undefined): string | undefined {
  return state.ended ? undefined : setupId;
}

/** A failure the window shows visibly in the step (and announces once): the words and, when it can be retried, how. */
export interface WindowNotice {
  readonly text: string;
  readonly onRetry?: () => void;
}

/** The owner's key settings for the window's listeners: the single-key switch, remaps and hold time (WCAG 2.1.4). */
export function keyPrefsFor(ui: UiKeyFields | undefined): KeyPrefs {
  return ui ? keyPrefsFromUi(ui) : DEFAULT_KEY_PREFS;
}

/** Where focus is when a step's focus key changes. */
export type ActiveFocus =
  /** Nothing has focus (the body), or the focused control left the page. */
  | 'none'
  /** One of the step's own footer buttons (Continue anyway, Open Aplos, Back to progress). */
  | 'footer'
  /** A control the owner moved to: a row's Try again, a field, an open sheet. */
  | 'elsewhere';

/**
 * Whether the window moves focus for a new focus key (F12). A new step always does. Within a step, a key change the
 * engine caused (`keepUserFocus`, e.g. first sync's Open Aplos becoming enabled) moves focus only from nowhere or from
 * the step's own footer, never away from a control the owner chose.
 */
export function shouldMoveFocus(
  newStep: boolean,
  keepUserFocus: boolean,
  active: ActiveFocus,
): boolean {
  return newStep || !keepUserFocus || active !== 'elsewhere';
}

/** What the window gives every step: the dashes, the strip's demo button, Back, and a phase line to announce. */
export interface StepChrome {
  /** "Step 2 of 4". */
  readonly dashes?: { readonly step: number; readonly of: number };
  /** An account is connected (this session or already): only then is anything setting up in the background. */
  readonly connected?: boolean;
  /** "Try demo mail"; absent hides it. */
  readonly onTryDemo?: () => void;
  /** Footer Back (Esc). Welcome's footer button is "Skip setup" instead. */
  readonly onBack: () => void;
  /** A window-level sentence for the one visually hidden `role="status"` (demo loading, a failed demo load or handoff). */
  readonly status?: string;
  /** A failed demo load or handoff, drawn visibly in the step with Try again (DESIGN 7.15). */
  readonly notice?: WindowNotice;
}

/**
 * What a step tells the window about its keys and focus: the control to focus and when (F12), what Return does when
 * focus is not on a control, and whether it handled Esc itself (true) or the window should go back a step.
 */
export interface StepKeys {
  /** Focus moves whenever this changes: a new step or a new internal state. Never on a late engine answer. */
  readonly focusKey: string;
  readonly focus?: FocusTarget;
  readonly main?: () => void;
  readonly esc?: () => boolean;
  /** Focus-key changes within the step come from the engine: never pull focus from a control the owner chose. */
  readonly keepUserFocus?: boolean;
}

/**
 * The footer of every step after Welcome: dashes, the note and Back (Esc, shown only with all key hints). "Setup continues
 * in the background." only once an account is connected: before that nothing is being set up, so it would be a promise
 * about nothing.
 */
export function backFooter(chrome: StepChrome): OnboardingFooter {
  return {
    ...(chrome.dashes ? { dashes: chrome.dashes } : {}),
    note: chrome.connected ? 'setupContinues' : 'none',
    buttons: [
      { label: 'Back', emphasis: 'text', keys: 'Esc', keyHint: 'hint', onSelect: chrome.onBack },
    ],
  };
}

/** Runs a sequence of events and collects every effect; for tests and for replaying a session. */
export function runFlow(
  events: readonly FlowEvent[],
  start: FlowState = initialFlow(),
): { state: FlowState; effects: FlowEffect[] } {
  let state = start;
  const effects: FlowEffect[] = [];
  for (const event of events) {
    const out = reduceFlow(state, event);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

/**
 * The rejection a port gives while its contract method is not on `renderer/data`'s `api` yet. The window keeps
 * working without it: the step shows the quiet fallback and the owner can always go on or skip.
 */
export function missingMethod(method: string): Error {
  return new Error(`${method} is not on renderer/data's api yet (REQUEST to ui-shell).`);
}
