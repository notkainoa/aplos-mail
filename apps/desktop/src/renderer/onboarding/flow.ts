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
 *   mail), `closed` (the window closed at any moment) (F1, F2). After that nothing navigates, but a step that already
 *   asked for the mail window may ask again (Return, Esc), so a failed handoff never leaves the owner stuck.
 * - Esc goes back a step; on Welcome it is "Skip setup"; on first sync it opens Aplos (F8).
 */

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
}

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
  /** The window is closing (red button, ⌘W, `pagehide`). */
  | { readonly type: 'close' };

/** What the root must do. */
export type FlowEffect =
  /** Call `Setup/end {setupId, reason}` once. */
  | { readonly type: 'setupEnd'; readonly reason: EndReason }
  /** Ask main to show the mail window (`Window/finishOnboarding`). */
  | { readonly type: 'handoff' };

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

/** End the session once and hand over to the mail window. */
function finish(state: FlowState, reason: Exclude<EndReason, 'closed'>, patch: Partial<FlowState> = {}): FlowResult {
  return {
    state: { ...state, ...patch, ended: reason },
    effects: [{ type: 'setupEnd', reason }, { type: 'handoff' }],
  };
}

/** Records a connected account; never moves the step (F9). */
function recordConnect(state: FlowState, event: Extract<FlowEvent, { type: 'connectResolved' }>): FlowState {
  const pendingConnectId = state.pendingConnectId === event.connectId ? null : state.pendingConnectId;
  if (event.outcome !== 'connected') return { ...state, pendingConnectId };
  if (event.demo) return { ...state, pendingConnectId, hasDemo: true };
  const id = event.accountId;
  const connected = id && !state.connected.includes(id) ? [...state.connected, id] : state.connected;
  return { ...state, pendingConnectId, connected };
}

export function reduceFlow(state: FlowState, event: FlowEvent): FlowResult {
  // Engine answers are recorded at any moment, even after the session ended; they never navigate.
  if (event.type === 'connectResolved') return same(recordConnect(state, event));
  if (event.type === 'connectStarted') {
    return state.ended ? same(state) : same({ ...state, pendingConnectId: event.connectId });
  }

  if (state.ended) {
    // The session is over. A window that asked for the mail window may ask again (a failed handoff must not strand
    // the owner); a closed window asks for nothing.
    const retry =
      state.ended !== 'closed' && (event.type === 'next' || event.type === 'esc' || event.type === 'open');
    return { state, effects: retry ? [{ type: 'handoff' }] : [] };
  }

  switch (event.type) {
    case 'close':
      return { state: { ...state, ended: 'closed' }, effects: [{ type: 'setupEnd', reason: 'closed' }] };
    case 'demoLoaded':
      return finish(state, 'demo', { hasDemo: true });
    case 'skip':
      return state.step === 'welcome' ? finish(state, 'skipped') : same(state);
    case 'open':
      return state.step === 'firstSync' ? finish(state, 'finished') : same(state);
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
}

/** Step dashes: Welcome is 1 of 4 … permissions 4 of 4. */
export function dashesFor(step: StepId): { step: number; of: number } | undefined {
  const at = (SETUP_STEPS as readonly StepId[]).indexOf(step);
  return at < 0 ? undefined : { step: at + 1, of: SETUP_STEPS.length };
}

/** The label of each step's filled main action, where the step has one fixed action. */
export const MAIN_LABEL = {
  welcome: 'Add an account',
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
    tryDemo: (step === 'welcome' || step === 'accounts') && !state.hasDemo && !state.ended,
    esc,
    contexts: step === 'firstSync' ? ['onboarding', 'firstSync'] : ['onboarding'],
    welcome: step === 'welcome',
    focus:
      step === 'welcome'
        ? { kind: 'button', label: MAIN_LABEL.welcome }
        : step === 'permissions'
          ? { kind: 'button', label: MAIN_LABEL.permissions }
          : undefined,
  };
}

/** What the window gives every step: the dashes, the strip's demo button, Back, and a phase line to announce. */
export interface StepChrome {
  /** "Step 2 of 4". */
  readonly dashes?: { readonly step: number; readonly of: number };
  /** "Try demo mail"; absent hides it. */
  readonly onTryDemo?: () => void;
  /** Footer Back (Esc). Welcome's footer button is "Skip setup" instead. */
  readonly onBack: () => void;
  /** A window-level sentence for the one visually hidden `role="status"` (a failed demo load or handoff). */
  readonly status?: string;
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
}

/** The footer of every step after Welcome: dashes, the fixed note and Back (Esc, shown only with all key hints). */
export function backFooter(chrome: StepChrome): OnboardingFooter {
  return {
    ...(chrome.dashes ? { dashes: chrome.dashes } : {}),
    note: 'setupContinues',
    buttons: [{ label: 'Back', emphasis: 'text', keys: 'Esc', keyHint: 'hint', onSelect: chrome.onBack }],
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
