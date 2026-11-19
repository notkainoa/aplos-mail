/**
 * The first-sync screen's view model (DESIGN 7.12; plan 30 U8 "What ready means", acceptance 4; Appendix C F5, F8,
 * F10, F11). Pure: contract values in, the props the screen draws out, plus every decision the screen makes (can it
 * open, does it open by itself, what the one live region says, what each account's button does).
 *
 * The rules it keeps, so the screen tells the truth under Gmail's quota:
 * - Progress follows engine checkpoints: Connect → Find recent mail → Read your newest mail → Sort what matters.
 *   "about N" only with a provider estimate; "n of total" where total is the first window, never the mailbox.
 * - Counters never move backwards within a run (`runId`). A status from a run that a Retry replaced is ignored, so
 *   two runs' updates can never interleave on screen [F5].
 * - Nothing reads as finished early: a step still running never shows its full count, the read step is done only
 *   when the engine says the first window is committed, and a capped, failed or paused pass is never "done" [F10].
 * - Sort is omitted (never failed) with no AI provider or no stored consent.
 * - "Open Aplos" is enabled once one account's first window is in; Esc always opens Aplos [F8]; Aplos opens by itself
 *   only on a clean finish: every account ready, sorting done or omitted, nothing paused, failed, capped or erroring.
 * - The one `role="status"` text changes only when the phase changes (connected, found, ready, failed) [F11].
 */
import type { CommandHandlers, CommandId } from '../../commands';
import { toIsoDateTime, type SetupAccount, type SetupStatus } from '../../data';
import type { ErrorLineKind, SyncAccount, SyncCheckpoint, TagColor } from '../../ui/props';
import {
  aiSentence,
  isAdminBlock,
  needsReconnect,
  reasonSentence,
  type AnyReasonCode,
} from '../copy';
import type { FocusTarget, WindowNotice } from '../flow';
import { DRILL_LIST_ID } from './drill.model';

/* ───────────────────────── inputs ───────────────────────── */

/** What the screen needs to know about an account besides its setup status: the contract `Account` satisfies it. */
export interface AccountFacts {
  readonly id: string;
  readonly address: string;
  /** A DESIGN 4.2 colour name ("sky", or "tag-sky"); the engine sets it from the owner's choice or the stable hash. */
  readonly colorTag?: string;
}

export interface FirstSyncInput {
  /** `Setup/status`; undefined while it is still loading. */
  readonly status: SetupStatus | undefined;
  /** Addresses and colours by account id (`useAccounts()`). */
  readonly accounts: readonly AccountFacts[];
  /** The Summaries provider's display name ("Groq"), or null when there is no provider or background AI is off. */
  readonly aiProvider: string | null;
  /** Background-AI consent is granted and current (`Consent.granted && !needsReconsent`). */
  readonly consentStored: boolean;
  /** Epoch ms from `useNow`. */
  readonly now: number;
  /** The view this screen showed last, for counters that never move backwards within a run. */
  readonly previous?: FirstSyncView;
}

/* ───────────────────────── outputs ───────────────────────── */

/** What the whole screen is saying. */
export type FirstSyncOutcome =
  /** `Setup/status` has not arrived yet. */
  | 'starting'
  /** Something is still running. */
  | 'progress'
  /** Google (or the account's provider) asked Aplos to wait; nothing failed. */
  | 'paused'
  /** Everything stopped, the newest mail is in, but sorting was capped or failed, or something else is not clean. Waits. */
  | 'partial'
  /** The clean finish: the only outcome that opens Aplos by itself. */
  | 'ready'
  /** An account failed or is not connected: "Some mail didn't come through". */
  | 'failed'
  /** No account is in the setup at all. */
  | 'empty';

/** The phases the one live region announces (DESIGN 7.12 Accessibility). Counts never change it. */
export type FirstSyncPhase = 'waiting' | 'connected' | 'found' | 'ready' | 'failed';

/** What an account's button does. */
export type AccountAction = 'retry' | 'reconnect' | 'none';

/** One account's row. */
export interface FirstSyncRow {
  readonly accountId: string;
  readonly account: SyncAccount;
  /** Connect, find, read and (when shown) sort, for `ProgressSegments` 'checkpoints'. */
  readonly checkpoints: readonly SyncCheckpoint[];
  /** "Paused until 2:14 PM": only a resume time later today; otherwise the row says "Paused". */
  readonly pausedUntil?: string;
  /** The plain reason under the row: an account failure, a not-connected reason or the sorting failure. */
  readonly failure?: ErrorLineKind;
  /** Skipped or never connected: "Not connected · Try again", never an endless "Waiting". */
  readonly notConnected: boolean;
  /** Try again (`Setup/retry`), Reconnect (the reconnect sheet), or nothing (an administrator's block). */
  readonly action: AccountAction;
  /** The sorting pass failed: the row offers "Open Settings". */
  readonly sortFailed: boolean;
  /** This account's first window is committed. */
  readonly firstWindowIn: boolean;
  /** The ready line: "Newest 50 read · sorted 40 of 40" (sort only when it was shown and finished). */
  readonly ready: {
    readonly read: number;
    readonly sorted?: { readonly done: number; readonly of: number };
  };
}

/** The screen's one filled button. */
export interface PrimaryAction {
  readonly label: 'Open Aplos' | 'Open now' | 'Continue to Aplos';
  readonly enabled: boolean;
}

export interface FirstSyncView {
  readonly outcome: FirstSyncOutcome;
  /** Step title (sans `heading`). */
  readonly title: string;
  /** One sentence under the title. */
  readonly lede: string;
  readonly rows: readonly FirstSyncRow[];
  /** "Open Aplos" is enabled: one account's first window is in. */
  readonly canOpen: boolean;
  /** Only on a clean finish. Any pause, failure, cap or error waits for the owner. */
  readonly autoOpen: boolean;
  readonly primary: PrimaryAction;
  /** The quiet "Continue anyway" text button, shown while the filled button is not yet enabled. */
  readonly continueAnyway: boolean;
  /** "Try the keys while you wait" is offered while something is still running. */
  readonly offerDrill: boolean;
  readonly phase: FirstSyncPhase;
  /** The text of the one visually hidden `role="status"`; a function of `phase` only. */
  readonly announcement: string;
  /** What the next build needs to keep counters monotonic. Not for display. */
  readonly memory: FirstSyncMemory;
}

/** Per-account memory carried from one view to the next. */
export interface AccountMemory {
  readonly runId: string;
  /** Runs a Retry replaced; a status from one of them is stale and ignored. */
  readonly retired: readonly string[];
  readonly connectDone: boolean;
  readonly findDone: boolean;
  readonly readDone: boolean;
  /** The first window was committed in this setup, by this run or by a run a Retry retired (it stays committed). */
  readonly firstWindowIn: boolean;
  /** Sorting was shown complete in this run; it stays so (the auto-open still checks the current facts). */
  readonly sortDone: boolean;
  readonly found?: number;
  readonly read: number;
  readonly readOf: number;
  readonly sorted: number;
  readonly sortOf: number;
  /** When the screen first saw a state it doesn't know (the engine's states are an open enum). */
  readonly unknownSince?: number;
}

export interface FirstSyncMemory {
  readonly setupId?: string;
  readonly accounts: Readonly<Record<string, AccountMemory>>;
  readonly rows: Readonly<Record<string, FirstSyncRow>>;
}

/* ───────────────────────── copy ───────────────────────── */

/** Titles and ledes (DESIGN 7.12; onboarding-sync.html). */
export const COPY = {
  titleWorking: 'Getting your mail',
  titleIn: 'Your newest mail is in',
  titleFailed: 'Some mail didn’t come through',
  ledeWorking: 'Your newest mail comes first. Older mail follows once you are in.',
  ledeReady: 'Aplos opens by itself in a moment.',
  ledePartial: 'Aplos waits for you. Older mail follows after you open it.',
  ledeFailed: 'Nothing was lost. You can try again now or open Aplos.',
  ledeEmpty: 'No account is connected yet.',
  /** DESIGN 7.12's own sentence, kept for a pause with no known resume time (gap list 4 item 18). */
  pauseFallback: 'Google is asking us to go slowly.',
  pauseAfterWindow: 'Your newest mail is ready now; older mail will follow.',
  pauseBeforeWindow: 'Your newest mail will appear first.',
} as const;

const ANNOUNCE: Record<FirstSyncPhase, string> = {
  waiting: '',
  connected: 'Connected. Finding your recent mail.',
  found: 'Found your recent mail. Reading the newest first.',
  ready: 'Your newest mail is in. Aplos can open now.',
  failed: 'Some mail didn’t come through.',
};

/**
 * How long "Your mail is ready" stays before Aplos opens by itself (onboarding-sync.html waits 3.2 s; DESIGN is silent,
 * map-onboard UNCLEAR-10 asks for it to be pinned). A behaviour constant, not a motion.
 */
export const AUTO_OPEN_DELAY_MS = 3200;

/**
 * How long an account may sit in a state the screen doesn't know before its row offers Try again. Until then the row
 * shows nothing as running (never an endless "Connecting…").
 */
export const UNKNOWN_STATE_GRACE_MS = 30_000;

/** The engine's account states this screen knows; anything else is drawn neutrally. */
const KNOWN_STATES = new Set<string>([
  'connecting',
  'finding',
  'reading',
  'sorting',
  'ready',
  'paused',
  'failed',
  'notConnected',
]);

/* ───────────────────────── helpers ───────────────────────── */

const TAGS: readonly TagColor[] = ['sky', 'hill', 'stamp', 'dusk', 'sand', 'ember'];
/** AI codes that mean "no sorting pass for this account": omitted, never failed. */
const SORT_OMITTED = new Set<string>(['ai.noProvider', 'ai.noConsent', 'ai.accountExcluded']);
const SORT_PAUSED = new Set<string>(['ai.rateLimited']);
/** Pause reasons whose sentence already says when it resumes. */
const PAUSE_SAYS_WHEN = new Set<string>([
  'quota.daily',
  'quota.bandwidth',
  'quota.project',
  'quota.calendarAbuse',
]);
const MAX_RETIRED = 16;

/** The account's colour from its `colorTag`; "sky" when it has none the screen knows. */
export function tagColor(colorTag: string | undefined): TagColor {
  const name = (colorTag ?? '').replace(/^-*(tag-)?/, '') as TagColor;
  return TAGS.includes(name) ? name : 'sky';
}

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "at 2:14 PM", "tomorrow at 9:00 AM", "on Friday at 9:00 AM", in the owner's locale. */
export function resumePhrase(at: number, now: number): string {
  if (sameLocalDay(at, now)) return `at ${clockTime(at)}`;
  if (sameLocalDay(at, now + 86_400_000)) return `tomorrow at ${clockTime(at)}`;
  const day = new Date(at).toLocaleDateString(undefined, { weekday: 'long' });
  return `on ${day} at ${clockTime(at)}`;
}

/**
 * The paused lede: what Google asked, when it resumes, and what that means for the newest mail (DESIGN 7.12, 7.1, 7.15;
 * gap list 4 item 18). A slow-down with a known resume time uses the status line's words; without one, DESIGN 7.12's
 * own sentence. A reason with its own wording (the daily limit, offline) keeps it. "Ready now" is said only when the
 * newest mail really is in.
 */
export function pauseLede(
  code: AnyReasonCode | undefined,
  resumeAt: number | undefined,
  now: number,
  newestIn: boolean,
  aiProvider: string | null = null,
): string {
  const after = newestIn ? COPY.pauseAfterWindow : COPY.pauseBeforeWindow;
  // An AI pause is the AI provider's, never Google's: "Groq asked us to slow down."
  if (code !== undefined && code.startsWith('ai.')) {
    const when = resumeAt !== undefined ? ` Resuming ${resumePhrase(resumeAt, now)}.` : '';
    return `${aiSentence(code, aiProvider ? { aiProvider } : {})}${when} ${after}`;
  }
  const ownWords =
    code !== undefined &&
    !code.startsWith('ai.') &&
    !code.startsWith('rate.') &&
    reasonSentence(code) !== reasonSentence(undefined);
  if (ownWords) {
    const when =
      resumeAt !== undefined && !PAUSE_SAYS_WHEN.has(code)
        ? ` Resuming ${resumePhrase(resumeAt, now)}.`
        : '';
    return `${reasonSentence(code)}${when} ${after}`;
  }
  if (resumeAt === undefined) return `${COPY.pauseFallback} ${after}`;
  return `Google asked us to slow down. Resuming ${resumePhrase(resumeAt, now)}. ${after}`;
}

/**
 * One counter as the screen shows it. Within a run the shown count never decreases, and the total never shrinks while
 * the step runs, so the fraction never moves backwards either. A step that is not finished never shows its full count;
 * a finished read shows "n of n" (a 12-thread inbox reads "12 of 12", never "12 of 50" forever).
 */
function counter(
  prev: { shown: number; of: number },
  value: number,
  total: number,
  finished: 'no' | 'done-own' | 'done-total',
): { shown: number; of: number } {
  const seen = Math.max(prev.shown, value);
  if (finished === 'done-own') return { shown: seen, of: seen };
  if (finished === 'done-total') return { shown: seen, of: Math.max(total, seen) };
  const of = Math.max(prev.of, total);
  return { shown: of > 0 ? Math.min(seen, of - 1) : 0, of };
}

function latestError(status: SetupStatus, accountId: string) {
  let best: SetupStatus['errors'][number] | undefined;
  for (const e of status.errors) {
    if (e.accountId !== accountId || e.phase === 'backfill') continue;
    if (!best || e.at >= best.at) best = e;
  }
  return best;
}

function freshMemory(runId: string, retired: readonly string[]): AccountMemory {
  return {
    runId,
    retired,
    connectDone: false,
    findDone: false,
    readDone: false,
    firstWindowIn: false,
    sortDone: false,
    read: 0,
    readOf: 0,
    sorted: 0,
    sortOf: 0,
  };
}

/* ───────────────────────── one account ───────────────────────── */

interface Derived {
  row: FirstSyncRow;
  memory: AccountMemory;
  paused: boolean;
  resumeAt?: number;
  pauseCode?: AnyReasonCode;
  hardFailed: boolean;
  settled: boolean;
  clean: boolean;
  connectDone: boolean;
  findDone: boolean;
}

function deriveAccount(
  a: SetupAccount,
  status: SetupStatus,
  facts: AccountFacts | undefined,
  input: FirstSyncInput,
  prev: AccountMemory | undefined,
): Derived {
  const { now, aiProvider, consentStored } = input;
  const address = facts?.address || 'Mail account';
  const account: SyncAccount = { address, color: tagColor(facts?.colorTag) };
  const fw = a.firstWindow;
  const state = a.state;

  // Memory is per run: a new runId starts clean and retires the old one — except the committed first
  // window, which stays committed within the setup, so "Open Aplos" never turns back off after a Retry.
  const mem0 =
    prev && prev.runId === a.runId
      ? prev
      : {
          ...freshMemory(a.runId, prev ? [...prev.retired, prev.runId].slice(-MAX_RETIRED) : []),
          firstWindowIn: prev?.firstWindowIn ?? false,
        };

  const notConnected = state === 'notConnected';
  const err = latestError(status, a.accountId);
  const code: AnyReasonCode | undefined = a.reasonCode ?? err?.reasonCode;
  const evidence =
    fw.done ||
    fw.read > 0 ||
    fw.found !== undefined ||
    ['finding', 'reading', 'sorting', 'ready', 'paused'].includes(state);
  // A state the screen doesn't know shows nothing as running; once it has lasted, the row offers Try again.
  const unknown = !KNOWN_STATES.has(state);
  const unknownSince = unknown ? (mem0.unknownSince ?? now) : undefined;
  const unknownStuck =
    unknown &&
    unknownSince !== undefined &&
    now - unknownSince >= UNKNOWN_STATE_GRACE_MS &&
    !(mem0.readDone || fw.done);
  const stateFailed = state === 'failed' || unknownStuck;
  // Where the failure happened: the engine's error for this account when it has one (backfill is never part of this
  // screen), else the account's own reason code: an AI code is the sorting pass, anything else is the account. The
  // committed first window never decides it: an account can fail after its window is in (a sign-in that expired).
  const failPhase: 'connect' | 'firstWindow' | 'ai' | undefined = stateFailed
    ? err
      ? (err.phase as 'connect' | 'firstWindow' | 'ai')
      : code !== undefined && code.startsWith('ai.')
        ? 'ai'
        : evidence || mem0.connectDone
          ? 'firstWindow'
          : 'connect'
    : undefined;
  const hardFailed = stateFailed && failPhase !== 'ai';

  const paused =
    !notConnected &&
    !hardFailed &&
    (state === 'paused' || (a.pausedUntil !== undefined && a.pausedUntil > now));
  const resumeAt = a.pausedUntil !== undefined && a.pausedUntil > now ? a.pausedUntil : undefined;

  // Stage completion is sticky within a run: the engine said it once.
  const readDone = mem0.readDone || (fw.done && !notConnected);
  // The window a retired run committed counts too: it is still in.
  const firstWindowIn = readDone || mem0.firstWindowIn;
  const findDone =
    mem0.findDone ||
    readDone ||
    fw.read > 0 ||
    state === 'reading' ||
    state === 'sorting' ||
    state === 'ready' ||
    (fw.found !== undefined && state !== 'finding');
  const connectDone =
    mem0.connectDone ||
    findDone ||
    (!notConnected &&
      !(hardFailed && failPhase === 'connect') &&
      state !== 'connecting' &&
      // A failure the engine places after Connect is itself the sign that Connect happened.
      (evidence || paused || (stateFailed && failPhase !== 'connect')));
  // Nothing runs in a state the screen doesn't know: the step it would be on waits instead of spinning.
  const running: SyncCheckpoint['state'] = unknown ? 'pending' : 'current';

  // Read: n of the first window, never the mailbox.
  const read = counter(
    { shown: mem0.read, of: mem0.readOf },
    fw.read,
    fw.total,
    readDone ? 'done-own' : 'no',
  );
  const found = fw.found !== undefined ? Math.max(mem0.found ?? 0, fw.found) : mem0.found;

  // Connect.
  const connectState: SyncCheckpoint['state'] = notConnected
    ? 'pending'
    : connectDone
      ? 'done'
      : hardFailed && failPhase === 'connect'
        ? 'failed'
        : paused
          ? 'paused'
          : running;

  // Find, and whether the read step has a total to count against yet.
  const readCountable = readDone || read.of > 0;
  const stuckInFind = !readDone && (!findDone || !readCountable);
  const findState: SyncCheckpoint['state'] =
    findDone && readCountable
      ? 'done'
      : notConnected || !connectDone
        ? 'pending'
        : hardFailed
          ? 'failed'
          : paused
            ? 'paused'
            : running;

  const readState: SyncCheckpoint['state'] = readDone
    ? 'done'
    : stuckInFind || notConnected
      ? 'pending'
      : hardFailed
        ? 'failed'
        : paused
          ? 'paused'
          : running;

  // Sort: only with a provider, stored consent and an AI block from the engine; omitted, never failed, otherwise.
  const ai = a.ai;
  const aiCode = ai?.reasonCode as string | undefined;
  const aiReady =
    !!ai && aiProvider !== null && consentStored && !(aiCode && SORT_OMITTED.has(aiCode));
  const aiFailure =
    aiReady &&
    !!ai &&
    (ai.failed > 0 ||
      (!!aiCode && !SORT_PAUSED.has(aiCode)) ||
      (stateFailed && failPhase === 'ai'));
  const aiCapped = aiReady && !!ai && ai.capped > 0 && !aiFailure;
  const aiPaused = aiReady && !!aiCode && SORT_PAUSED.has(aiCode);
  const aiAccounted = ai ? ai.sorted + ai.capped + ai.failed >= ai.total : false;
  // Nothing to sort once the pass ended with zero candidates: the segment is left out rather than "0 of 0".
  const sortEmpty =
    aiReady && !!ai && ai.total === 0 && readDone && state !== 'sorting' && !aiFailure;
  const sortShown = aiReady && !sortEmpty;

  // Sorting shown complete stays complete, unless the engine later says there is more to sort than was shown sorted:
  // a larger total, a cap or a failure [F10]. Then the pass shows its true count again ("Sorted 10 of 40").
  const sortReopened =
    mem0.sortDone &&
    !!ai &&
    (aiFailure || aiCapped || ai.total > mem0.sortOf) &&
    ai.total > mem0.sorted;
  const sortComplete =
    !!ai && !aiFailure && !aiCapped && state !== 'sorting' && ai.sorted >= ai.total && ai.total > 0;

  let sortState: SyncCheckpoint['state'] = 'pending';
  let sort = { shown: mem0.sorted, of: mem0.sortOf };
  if (sortShown && ai) {
    if (mem0.sortDone && !sortReopened) sortState = 'done';
    // A finished pass stays finished when the account fails later (an expired sign-in after the window was in).
    else if (readDone && !notConnected && sortComplete) sortState = 'done';
    else if (!readDone || notConnected || hardFailed) sortState = 'pending';
    else if (aiFailure) sortState = 'failed';
    else if (aiCapped) sortState = 'partial';
    else if (aiPaused) sortState = 'paused';
    else if (state !== 'sorting' && (aiAccounted || state === 'ready')) sortState = 'partial';
    else sortState = ai.total > 0 ? running : 'pending';
    sort = counter(
      { shown: mem0.sorted, of: mem0.sortOf },
      ai.sorted,
      ai.total,
      sortState === 'done' ? 'done-total' : 'no',
    );
    // A capped or failed pass keeps its true count ("Sorted 12 of 40"); it is never shown as complete.
    if (sortState === 'pending' && sort.of === 0) sort = { shown: 0, of: 0 };
  }

  const checkpoints: SyncCheckpoint[] = [
    { step: 'connect', state: connectState },
    found !== undefined
      ? { step: 'find', state: findState, estimate: found }
      : { step: 'find', state: findState },
    { step: 'read', state: readState, read: read.shown, of: read.of },
  ];
  if (sortShown)
    checkpoints.push({ step: 'sort', state: sortState, sorted: sort.shown, of: sort.of });

  // What the row offers.
  let action: AccountAction = 'none';
  if (hardFailed || notConnected) {
    action = isAdminBlock(code) ? 'none' : needsReconnect(code) ? 'reconnect' : 'retry';
  }

  let failure: ErrorLineKind | undefined;
  if (hardFailed) {
    failure = {
      kind: 'reason',
      text: reasonSentence(code, { address }),
      retryable: action === 'retry',
    };
  } else if (notConnected && code) {
    failure = {
      kind: 'reason',
      text: reasonSentence(code, { address }),
      retryable: action === 'retry',
    };
  } else if (sortShown && sortState === 'failed') {
    failure = sortFailure(
      aiCode ?? (code?.startsWith('ai.') ? code : undefined),
      aiProvider ?? 'your AI provider',
    );
  }

  const pausedUntil =
    paused && resumeAt !== undefined && sameLocalDay(resumeAt, now)
      ? toIsoDateTime(resumeAt)
      : undefined;

  const sortFinished =
    !sortShown || sortState === 'done' || sortState === 'partial' || sortState === 'failed';
  const settled = notConnected || hardFailed || (readDone && sortFinished);
  const clean =
    readDone &&
    !paused &&
    !notConnected &&
    !stateFailed &&
    !aiFailure &&
    !aiCapped &&
    // Any capped or failed summary the engine reports keeps the screen waiting, even where Sort is not shown.
    !(ai && (ai.capped > 0 || ai.failed > 0)) &&
    state === 'ready' &&
    a.reasonCode === undefined &&
    (!sortShown || sortState === 'done');

  const row: FirstSyncRow = {
    accountId: a.accountId,
    account,
    checkpoints,
    pausedUntil,
    failure,
    notConnected,
    action,
    sortFailed: sortShown && sortState === 'failed',
    firstWindowIn,
    ready: {
      read: read.shown,
      sorted: sortShown && sortState === 'done' ? { done: sort.shown, of: sort.of } : undefined,
    },
  };

  const memory: AccountMemory = {
    runId: a.runId,
    retired: mem0.retired,
    connectDone,
    findDone,
    readDone,
    firstWindowIn,
    sortDone: sortShown ? sortState === 'done' : mem0.sortDone,
    found,
    read: read.shown,
    readOf: read.of,
    sorted: sort.shown,
    sortOf: sort.of,
    ...(unknownSince !== undefined ? { unknownSince } : {}),
  };

  return {
    row,
    memory,
    paused,
    resumeAt,
    // An AI-provider pause names the AI provider (the ai block carries its reasonCode, not the account).
    pauseCode: paused ? (aiPaused ? (aiCode as AnyReasonCode) : code) : undefined,
    hardFailed,
    settled,
    clean,
    connectDone,
    findDone,
  };
}

/** The sorting failure line (DESIGN 7.12: "Couldn't sort with Groq: the key was refused. Mail is ready; sorting will retry."). */
function sortFailure(code: AnyReasonCode | undefined, provider: string): ErrorLineKind {
  if (code === 'ai.missingKey') return { kind: 'sortFailed', provider, cause: 'keyRefused' };
  if (code === 'ai.unreachable') return { kind: 'sortFailed', provider, cause: 'unreachable' };
  if (code === 'ai.dailyCap') return { kind: 'sortFailed', provider, cause: 'cap' };
  if (code === 'ai.trainsOnInputs')
    return {
      kind: 'reason',
      text: `${aiSentence(code, { aiProvider: provider })} Mail is ready.`,
      retryable: false,
    };
  return {
    kind: 'reason',
    text: `${aiSentence(code ?? 'ai.failed', { aiProvider: provider })} Mail is ready; sorting will retry.`,
    retryable: false,
  };
}

/* ───────────────────────── the screen ───────────────────────── */

const EMPTY_MEMORY: FirstSyncMemory = { accounts: {}, rows: {} };

/** Builds the screen from one `Setup/status` and the view shown before it. */
export function buildFirstSyncView(input: FirstSyncInput): FirstSyncView {
  const { status, now } = input;
  // Memory is per setup session. A status that first arrives without a `setupId` and then with one is the same run;
  // only a different id starts clean.
  const prevId = input.previous?.memory.setupId;
  const prevMemory =
    input.previous &&
    (!status || prevId === undefined || status.setupId === undefined || prevId === status.setupId)
      ? input.previous.memory
      : EMPTY_MEMORY;

  if (!status) {
    return finish({
      outcome: 'starting',
      rows: [],
      canOpen: false,
      phase: 'waiting',
      lede: COPY.ledeWorking,
      title: COPY.titleWorking,
      memory: prevMemory,
    });
  }

  const facts = new Map(input.accounts.map(f => [f.id, f]));
  const derived: Derived[] = [];
  const rows: FirstSyncRow[] = [];
  const accounts: Record<string, AccountMemory> = {};
  const rowMemo: Record<string, FirstSyncRow> = {};

  for (const a of status.accounts) {
    const prev = prevMemory.accounts[a.accountId];
    const prevRow = prevMemory.rows[a.accountId];
    // A late update from a run that a Retry already replaced: keep what the screen showed [F5].
    if (prev && prev.runId !== a.runId && prev.retired.includes(a.runId) && prevRow) {
      accounts[a.accountId] = prev;
      rowMemo[a.accountId] = prevRow;
      rows.push(prevRow);
      derived.push(staleDerived(prevRow, prev, a, now));
      continue;
    }
    const d = deriveAccount(a, status, facts.get(a.accountId), input, prev);
    derived.push(d);
    rows.push(d.row);
    accounts[a.accountId] = d.memory;
    rowMemo[a.accountId] = d.row;
  }
  const setupId = status.setupId ?? prevMemory.setupId;
  const memory: FirstSyncMemory = {
    ...(setupId !== undefined ? { setupId } : {}),
    accounts,
    rows: rowMemo,
  };

  if (rows.length === 0) {
    return finish({
      outcome: 'empty',
      rows,
      canOpen: false,
      phase: 'waiting',
      title: COPY.titleWorking,
      lede: COPY.ledeEmpty,
      memory,
    });
  }

  const canOpen = rows.some(r => r.firstWindowIn);
  const anyFailed = derived.some(d => d.hardFailed || d.row.notConnected);
  const pausedOnes = derived.filter(d => d.paused);
  const allSettled = derived.every(d => d.settled);
  const clean =
    derived.every(d => d.clean) &&
    status.done &&
    !status.partial &&
    // Backfill errors are never part of this screen (latestError already ignores them): a transient one
    // does not turn a clean finish partial.
    status.errors.every(e => e.phase === 'backfill');

  const outcome: FirstSyncOutcome = anyFailed
    ? 'failed'
    : clean
      ? 'ready'
      : pausedOnes.length > 0
        ? 'paused'
        : allSettled
          ? 'partial'
          : 'progress';

  const phase: FirstSyncPhase =
    outcome === 'failed'
      ? 'failed'
      : canOpen
        ? 'ready'
        : derived.some(d => d.findDone)
          ? 'found'
          : derived.some(d => d.connectDone)
            ? 'connected'
            : 'waiting';

  const everyWindowIn = rows.every(r => r.firstWindowIn);
  let title: string = COPY.titleWorking;
  let lede: string = COPY.ledeWorking;
  if (outcome === 'failed') {
    title = COPY.titleFailed;
    lede = COPY.ledeFailed;
  } else if (outcome === 'ready') {
    lede = COPY.ledeReady;
  } else if (outcome === 'partial') {
    title = COPY.titleIn;
    lede = COPY.ledePartial;
  } else if (outcome === 'paused') {
    // The earliest known resume speaks for the screen; each row carries its own.
    const first = [...pausedOnes].sort(
      (x, y) => (x.resumeAt ?? Infinity) - (y.resumeAt ?? Infinity),
    )[0];
    const newestIn = first.row.firstWindowIn;
    if (everyWindowIn) title = COPY.titleIn;
    lede = pauseLede(first.pauseCode, first.resumeAt, now, newestIn, input.aiProvider);
  }

  return finish({ outcome, rows, canOpen, phase, title, lede, memory });
}

/** A stale run's status keeps the previous row and contributes what that row already said. */
function staleDerived(
  row: FirstSyncRow,
  memory: AccountMemory,
  a: SetupAccount,
  now: number,
): Derived {
  const states = row.checkpoints.map(c => c.state);
  const paused = states.includes('paused');
  const hardFailed = row.failure?.kind === 'reason' && !row.sortFailed && !row.notConnected;
  const sort = row.checkpoints.find(c => c.step === 'sort');
  void a;
  void now;
  return {
    row,
    memory,
    paused,
    hardFailed,
    settled:
      row.notConnected || hardFailed || (row.firstWindowIn && (!sort || sort.state !== 'current')),
    // A stale update never makes the screen clean.
    clean: false,
    connectDone: memory.connectDone,
    findDone: memory.findDone,
  };
}

function finish(parts: {
  outcome: FirstSyncOutcome;
  rows: readonly FirstSyncRow[];
  canOpen: boolean;
  phase: FirstSyncPhase;
  title: string;
  lede: string;
  memory: FirstSyncMemory;
}): FirstSyncView {
  const { outcome, canOpen } = parts;
  const primary: PrimaryAction =
    outcome === 'failed' || outcome === 'empty'
      ? { label: 'Continue to Aplos', enabled: true }
      : outcome === 'ready'
        ? { label: 'Open now', enabled: true }
        : outcome === 'partial'
          ? { label: 'Open Aplos', enabled: true }
          : { label: 'Open Aplos', enabled: canOpen };
  return {
    ...parts,
    autoOpen: outcome === 'ready',
    primary,
    continueAnyway: !primary.enabled,
    offerDrill: outcome === 'starting' || outcome === 'progress' || outcome === 'paused',
    announcement: ANNOUNCE[parts.phase],
  };
}

/* ───────────────────────── keys and actions ───────────────────────── */

/** What a key does on this screen (DESIGN 7.12, 8): Esc always opens Aplos [F8]; Return opens it when the button is on. */
export function keyIntent(view: FirstSyncView, key: 'Escape' | 'Enter'): 'open' | 'none' {
  if (key === 'Escape') return 'open';
  return view.primary.enabled ? 'open' : 'none';
}

/**
 * Whether a Try again press should reach the engine: only for a row that offers it, and never while that account's
 * retry is still in flight. `Setup/retry` is idempotent anyway; this keeps a double click from sending twice [F5].
 */
export function shouldSendRetry(
  view: FirstSyncView,
  accountId: string,
  inFlight: ReadonlySet<string>,
): boolean {
  if (inFlight.has(accountId)) return false;
  const row = view.rows.find(r => r.accountId === accountId);
  return !!row && row.action === 'retry';
}

/**
 * Where focus goes on this screen and when it moves (F12). Entering first sync focuses the filled button when it is
 * enabled, else "Continue anyway" (both in the footer, which never focuses itself); the key changes when the filled
 * button turns on or changes its label, and on entering or leaving the drill, whose practice list takes focus so its
 * letters and Space reach the drill rather than a button. These changes come from the engine, so the window moves
 * focus only from nowhere or from the footer (`keepUserFocus`), never from a row's Try again the owner went to.
 */
export function firstSyncFocus(
  view: FirstSyncView,
  drillOpen: boolean,
): { readonly focusKey: string; readonly focus: FocusTarget; readonly keepUserFocus: true } {
  if (drillOpen)
    return {
      focusKey: 'firstSync:drill',
      focus: { kind: 'field', id: DRILL_LIST_ID },
      keepUserFocus: true,
    };
  if (view.primary.enabled) {
    return {
      focusKey: `firstSync:${view.primary.label}`,
      focus: { kind: 'button', label: view.primary.label },
      keepUserFocus: true,
    };
  }
  return {
    focusKey: 'firstSync:waiting',
    focus: { kind: 'button', label: CONTINUE_ANYWAY },
    keepUserFocus: true,
  };
}

/** The quiet text button shown while the filled button is not enabled yet. */
export const CONTINUE_ANYWAY = 'Continue anyway';

/** The callbacks the registry handlers call. */
export interface FirstSyncKeyCallbacks {
  /** The current view (read at key time, so the handlers never go stale). */
  readonly view: () => FirstSyncView;
  /** Whether the drill is showing. */
  readonly drillOpen: () => boolean;
  /**
   * The window's failed handoff, while the screen draws it (the slot's `notice`). Return on it is
   * the notice's Try again — it retries the handoff the failed one asked for — so the screen's
   * `onboarding.continue` stays disabled and the key falls through to the window's own listener.
   * Esc is unaffected: it always opens plainly.
   */
  readonly notice: () => WindowNotice | undefined;
  readonly onOpen: () => void;
  readonly onDrill: (key: 'next' | 'previous' | 'suggested' | 'done' | 'ask' | 'undo') => void;
  readonly onLeaveDrill: () => void;
}

/**
 * Handlers for the catalog's first-sync and drill commands, for the window's registry to `attach` (the screen binds no
 * keys itself). Esc (`onboarding.openAplos`) is always enabled, in every state and inside the drill [F8]. While the
 * window's failed handoff is on screen (`notice`), Return is the notice's Try again: `onboarding.continue` resolves
 * to nothing, so nothing calls preventDefault and the window's own listener retries with the failed destination.
 */
export function firstSyncCommands(cb: FirstSyncKeyCallbacks): Record<CommandId, CommandHandlers> {
  const inDrill = () => cb.drillOpen();
  return {
    'onboarding.openAplos': { run: () => cb.onOpen() },
    'onboarding.continue': {
      when: () => !inDrill() && !cb.notice() && keyIntent(cb.view(), 'Enter') === 'open',
      run: () => cb.onOpen(),
    },
    'drill.next': { when: inDrill, run: () => cb.onDrill('next') },
    'drill.previous': { when: inDrill, run: () => cb.onDrill('previous') },
    'drill.suggested': { when: inDrill, run: () => cb.onDrill('suggested') },
    'drill.done': { when: inDrill, run: () => cb.onDrill('done') },
    'drill.ask': { when: inDrill, run: () => cb.onDrill('ask') },
    'drill.undo': { when: inDrill, run: () => cb.onDrill('undo') },
    'drill.leave': { when: inDrill, run: () => cb.onLeaveDrill() },
  };
}

/** Every string the screen shows for a view, for copy checks in tests (titles, ledes, buttons, the live region). */
export function screenStrings(view: FirstSyncView): string[] {
  const out = [view.title, view.lede, view.primary.label, view.announcement];
  if (view.continueAnyway) out.push(CONTINUE_ANYWAY);
  return out.filter(Boolean);
}
