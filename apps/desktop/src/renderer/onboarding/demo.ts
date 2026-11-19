/**
 * Demo mail on request (plan 30 §4.5 row 8; U8 acceptance 3; DESIGN 7.10 Accounts, 7.11 step 1, 7.14). Pure rules plus
 * three ports over `api.demo`.
 *
 * Isolation rules, kept at this level so every caller (Welcome's "Try demo mail", the zero-accounts state, Settings →
 * Accounts and Help) gets them:
 * - Nothing here calls the engine until one of `loadDemo`, `resetDemo` or `removeDemo` is called, and each call comes
 *   from an explicit click. Importing this file, rendering a control or reading `demoControls` never does.
 * - "Load demo mail" is offered only when there is no demo account; Reset and Remove only when there is one. A call
 *   the snapshot says does not apply is refused without reaching the engine.
 * - `removeDemo` has no Undo, so it cannot run without an explicit confirm, and anything but a clear yes cancels.
 * - The engine's own rule (`Demo/*` touch only demo accounts; a 0.2.x folder with demo or real data is never seeded
 *   or wiped) is not repeated here; the contract log test for it lives with the engine and the harness.
 */
import { api } from '../data';

/** The three calls. Defaults come from `renderer/data`; tests pass their own. */
export interface DemoPorts {
  load(): Promise<unknown>;
  reset(): Promise<unknown>;
  remove(): Promise<unknown>;
}

export const defaultDemoPorts: DemoPorts = {
  load: async () => api.demo.load({}),
  reset: async () => api.demo.reset({}),
  remove: async () => api.demo.remove({}),
};

/** What the rules read from an account. */
export interface DemoAccountFacts {
  readonly demo: boolean;
}

/** Which demo controls to show. */
export interface DemoControls {
  /** "Load demo mail": only when no demo account exists. */
  readonly load: boolean;
  /** "Reset demo mail": only with a demo account. */
  readonly reset: boolean;
  /** "Remove demo mail": only with a demo account. */
  readonly remove: boolean;
}

export function hasDemo(accounts: readonly DemoAccountFacts[]): boolean {
  return accounts.some(a => a.demo);
}

export function demoControls(accounts: readonly DemoAccountFacts[]): DemoControls {
  const demo = hasDemo(accounts);
  return { load: !demo, reset: demo, remove: demo };
}

/** What a demo action did. `exists` and `none` mean it was refused without reaching the engine. */
export type DemoResult =
  'loaded' | 'reset' | 'removed' | 'exists' | 'none' | 'cancelled' | 'failed';

/** `Demo/load`, for an explicit click. Refused when a demo account already exists. */
export async function loadDemo(
  ports: Pick<DemoPorts, 'load'>,
  accounts: readonly DemoAccountFacts[] = [],
): Promise<DemoResult> {
  if (hasDemo(accounts)) return 'exists';
  try {
    await ports.load();
    return 'loaded';
  } catch {
    return 'failed';
  }
}

/** `Demo/reset`, for an explicit click. Refused when there is no demo account. */
export async function resetDemo(
  ports: Pick<DemoPorts, 'reset'>,
  accounts: readonly DemoAccountFacts[],
): Promise<DemoResult> {
  if (!hasDemo(accounts)) return 'none';
  try {
    await ports.reset();
    return 'reset';
  } catch {
    return 'failed';
  }
}

/**
 * `Demo/remove`, for an explicit click. It cannot be undone, so `confirm` is required and must answer `true`; the
 * two-row Confirm (`REMOVE_DEMO_CONFIRM`, Cancel is the default row) is what calls `confirm`'s answer.
 */
export async function removeDemo(
  ports: Pick<DemoPorts, 'remove'>,
  accounts: readonly DemoAccountFacts[],
  confirm: () => boolean | Promise<boolean>,
): Promise<DemoResult> {
  if (!hasDemo(accounts)) return 'none';
  let yes: boolean;
  try {
    yes = (await confirm()) === true;
  } catch {
    yes = false;
  }
  if (!yes) return 'cancelled';
  try {
    await ports.remove();
    return 'removed';
  } catch {
    return 'failed';
  }
}

/**
 * The confirm for "Remove demo mail" (no Undo; two rows, Cancel is the default, ⇧Return confirms). The shape is
 * `ConfirmProps` minus the callbacks, for ui-settings to spread into `Confirm`.
 */
export const REMOVE_DEMO_CONFIRM = {
  question: 'Remove demo mail?',
  consequence:
    "The demo accounts and their mail are deleted from this Mac. This can't be undone. Your own accounts aren't touched.",
  confirmLabel: 'Remove',
  cancelLabel: 'Cancel',
  destructive: true,
  presentation: 'dialog',
} as const;

/** Toast and notice sentences for the demo actions (demo.html, DESIGN 7.13). */
export const DEMO_NOTICE = {
  /** After "Try demo mail" hands over to the mail window, and after Load in Settings. */
  loaded: 'Demo mail loaded. Remove it any time in Settings.',
  reset: 'Demo mail reset',
  removed: 'Demo mail removed',
  failed: "Couldn't change demo mail. Try again.",
} as const;

/** The zero-accounts state's two actions' labels (DESIGN 7.14; no-accounts in empty.html). */
export const ZERO_ACCOUNTS = {
  text: 'Add an account to bring in your mail',
  add: 'Add account',
  tryDemo: 'Try demo mail',
  /** Shown instead while a first sync runs (DESIGN 7.14; plan 30 §4.5 rows 8 and 10). */
  firstSync: 'Your first mail is on its way',
  /** What Aplos does, one sentence — Welcome's own words (DESIGN 7.11 step 1). */
  lede: 'Aplos puts the email that needs you on top, sums each one up in a line, and keeps every action on a key.',
  /** Three facts, one line each, drawn as quiet rows under the lede. */
  rows: [
    { icon: 'tray', text: 'Newest mail first, summed up in a line.' },
    { icon: 'keyboard', text: 'Every action on a key.' },
    { icon: 'lock', text: 'Your mail stays on this Mac.' },
  ],
  /** The quiet line under the actions: what signing in means, in Accounts' own words. */
  privacy: 'Sign-in is with Google in your browser; Aplos reads your mail on this Mac.',
} as const;

/**
 * What the main pane's empty state is. With accounts, neither line applies ("none": Home and the lists have their own
 * empties, DESIGN 7.14). With none, a running first sync always wins, so the zero-accounts line is never shown while
 * one runs (§4.5 row 8): "firstSync" is "Your first mail is on its way.", else "zero" is the no-accounts line.
 */
export function zeroAccountsMode(input: {
  accountCount: number;
  firstSyncRunning: boolean;
}): 'zero' | 'firstSync' | 'none' {
  if (input.accountCount > 0) return 'none';
  return input.firstSyncRunning ? 'firstSync' : 'zero';
}

/**
 * Whether "no accounts" is proven: a loaded account list wins (it is what the callers already proved, and
 * `Session/get` is re-read only on Session frames, so a stale `hasAccounts: true` must not blank Home with no way to
 * add an account); before the list has loaded the session's own word counts. While neither has answered nothing is
 * proven, so the pane stays blank rather than guess.
 */
export function zeroAccountsProven(input: {
  hasAccounts: boolean | undefined;
  accountsLoaded: boolean;
  accountCount: number;
}): boolean {
  if (input.accountsLoaded) return input.accountCount === 0;
  return input.hasAccounts === false;
}
