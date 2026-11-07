/**
 * The Ask dock's view model (DESIGN §7.7, §8 Ask, §9, §7.15; plan 30 U7 acceptance 4). Pure.
 *
 * It turns the stored `Conversation` and the live run's `progress` frames into what `AskDock` and `AskTurn` draw:
 * - one steady step line while working, folding into a dim step log "Read 14 emails from Jordan · 3 steps" (the
 *   headline is the step that read the most, else the last one);
 * - streamed text with one caret, split into paragraphs; citation chips placed where the engine put them, each with
 *   its quote and source for the hover and its open target for the click; chips that point at no source are dropped;
 * - every finished answer cites a source or says "No source in your mail" (`sourceLine` states which one shows);
 * - at most one decisive span (weight 500) per answer;
 * - proposals and their receipts: the dock's one card is the newest open proposal; a decision shows at once and
 *   reverts if the engine refuses it; nothing is applied without a confirmation;
 * - a stopped answer keeps its partial text, marked stopped, and offers no proposal;
 * - a daily-limit refusal pauses the turn ("Paused for today. Resumes tomorrow.") rather than erroring;
 * - queued follow-ups stay editable cards; they run in order after an answer finishes; ⌘Return sends now;
 * - the Esc ladder: a focused proposal's Not now, then stop, then clear, then dismiss the proposal, then close.
 *   It never navigates;
 * - no provider (Ask can't run) versus a provider error ("Groq didn't answer." with Retry and Use another provider);
 * - provenance for the hover: "Answer by Groq", "Answer by Ollama on this Mac".
 * The input is never disabled: while an answer streams, Return queues the question instead.
 */
import { toIsoDateTime } from '../../data';
import type {
  AiProvider,
  AskTurn as StoredTurn,
  Consent,
  Conversation,
  ErrorBody,
  ModelRef,
  ProgressFrame,
  Proposal,
} from '../../data';
import type {
  AnswerParagraph,
  AskEmptyData,
  AskTurnProps,
  CitationData,
  QueuedFollowUp,
  StepLogProps,
} from '../../ui/props';
import { type TodayCalendar } from '../today/today.model';
import {
  citationData,
  effectiveProposalState,
  foldFrames,
  isAccountExcluded,
  isDailyLimit,
  isNoProvider,
  openTarget,
  proposalCard,
  provenance,
  providerLabel,
  streamBlocks,
  toParagraphs,
  type LiveRun,
  type OpenTarget,
  type ProposalView,
} from './ask.frames';

export * from './ask.frames';

/* ───────────────────────── renderer state ───────────────────────── */

/** A follow-up waiting for the running answer; ⌘Return (or a ⌘Return while streaming) asks with search all mail. */
export interface QueuedQuestion extends QueuedFollowUp {
  readonly searchAll: boolean;
}

/** The run this dock started most recently. */
export interface RunRef {
  /** Our id for it, before the engine gives a run id. */
  readonly clientId: string;
  readonly question: string;
  readonly searchAll: boolean;
  /** From `Ask/run`; absent while the call is on its way. */
  readonly runId?: string;
  /** Esc or "send now" asked the engine to stop it. */
  readonly stopped: boolean;
  /** `Ask/run` itself was refused. */
  readonly refused?: Pick<ErrorBody, 'type' | 'reasonCode' | 'message'>;
  /** The terminal frame was seen and the queue advanced. */
  readonly settled: boolean;
}

/** A proposal decision the owner made here, shown before the engine confirms it. */
export interface Decision {
  readonly accept: boolean;
  readonly phase: 'sending' | 'applied' | 'failed';
  readonly eventId?: string;
  readonly draftId?: string;
}

export interface AskState {
  readonly field: string;
  readonly conversationId?: string;
  readonly run?: RunRef;
  /** Earlier runs of this chat whose turn the engine has not stored yet (a stopped answer stays on screen). */
  readonly past: readonly RunRef[];
  readonly queued: readonly QueuedQuestion[];
  /** Turns whose step log is open. */
  readonly expanded: readonly string[];
  /** By proposal id. */
  readonly decisions: Readonly<Record<string, Decision>>;
  /** ↑/↓ over suggestions and recents in the empty view. */
  readonly cursor?: number;
  /** ↑ in an empty field inside a conversation: how far back in its questions. */
  readonly history?: number;
  readonly seq: number;
  /** A question held for consent: the consent line's Allow sends it, "Not now" drops the hold and keeps the text. */
  readonly consentHeld?: { readonly question: string; readonly searchAll: boolean };
}

export const initialAsk: AskState = {
  field: '',
  past: [],
  queued: [],
  expanded: [],
  decisions: {},
  seq: 0,
};

/** Something the container must do. */
export type AskEffect =
  | {
      readonly kind: 'run';
      readonly clientId: string;
      readonly question: string;
      readonly conversationId?: string;
      readonly searchAll: boolean;
    }
  | { readonly kind: 'cancel'; readonly runId: string }
  | {
      readonly kind: 'decide';
      readonly proposalId: string;
      readonly turnId: string;
      readonly conversationId: string;
      readonly accept: boolean;
    }
  | { readonly kind: 'close' }
  | { readonly kind: 'openConversation'; readonly conversationId: string };

export interface AskStep {
  readonly state: AskState;
  readonly effects: readonly AskEffect[];
}

const step = (state: AskState, ...effects: AskEffect[]): AskStep => ({ state, effects });

/* ───────────────────────── turns ───────────────────────── */

/** One turn as the dock draws it, before callbacks. */
export interface TurnView {
  readonly id: string;
  readonly question: string;
  readonly state: AskTurnProps['state'];
  readonly steps?: Omit<StepLogProps, 'onToggle'>;
  readonly answer?: readonly AnswerParagraph[];
  readonly citations: readonly CitationData[];
  readonly targets: ReadonlyMap<number, OpenTarget>;
  /** "Groq" for "Groq didn't answer." */
  readonly provider?: string;
  readonly provenance?: { provider: string; local: boolean };
  readonly proposal?: ProposalView;
  /** Which closing line shows: a citation, or "No source in your mail"; null while the answer is not finished. */
  readonly sourceLine: 'cited' | 'noSource' | null;
  /** Accounts left out of this answer because their mail is not used for AI. */
  readonly excludedNote?: string;
  /** Drawn from frames, not yet stored. */
  readonly live: boolean;
}

/** The step log: the live line while working, the dim fold after. */
export function stepLog(
  steps: readonly { text: string; state: string; count?: number }[],
  working: boolean,
  expanded: boolean,
): Omit<StepLogProps, 'onToggle'> | undefined {
  if (steps.length === 0) return undefined;
  const texts = steps.map(s => s.text);
  if (working) {
    const running = [...steps].reverse().find(s => s.state === 'running');
    return {
      current: (running ?? steps[steps.length - 1]).text,
      summary: '',
      steps: texts,
      expanded: false,
    };
  }
  let headline = steps[steps.length - 1];
  for (const s of steps) if ((s.count ?? -1) > (headline.count ?? -1)) headline = s;
  const summary = steps.length > 1 ? `${headline.text} · ${steps.length} steps` : headline.text;
  return { summary, steps: texts, expanded };
}

/** Inputs the dock reads besides its own state. */
export interface AskInputs {
  /** The open conversation, as stored. */
  readonly conversation?: Conversation;
  /** The live run's progress frames (any order of arrival; folded by run id). */
  readonly frames: readonly ProgressFrame[];
  readonly providers: readonly Pick<AiProvider, 'id' | 'label' | 'local' | 'status'>[];
  /** `Ai/status` for Ask: ready, and the model it would use. */
  readonly askReady: boolean;
  readonly askModel?: ModelRef;
  readonly calendars: ReadonlyMap<string, TodayCalendar>;
  /** Account names by id, for "left out" notes. */
  readonly accountNames?: ReadonlyMap<string, string>;
  readonly suggestions: readonly string[];
  readonly recents: readonly { id: string; title: string; updatedAt: number }[];
  /** The consent record still needs an Allow; a submitted question is held, not run. */
  readonly consentNeeded?: boolean;
}

function excludedNote(
  ids: readonly string[] | undefined,
  names?: ReadonlyMap<string, string>,
): string | undefined {
  if (!ids || ids.length === 0) return undefined;
  const list = ids.map(id => names?.get(id) ?? 'one account');
  const who =
    list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `Mail from ${who} was left out. Its AI setting is off.`;
}

function storedTurn(turn: StoredTurn, inputs: AskInputs, state: AskState): TurnView {
  const known = new Set(turn.citations.map(c => c.n));
  const answer = turn.answer ? toParagraphs(turn.answer.blocks, known) : [];
  const dailyLimit = isDailyLimit(turn.problem);
  const excluded = isAccountExcluded(turn.problem);
  // The same failure `liveTurn` reads from a terminal frame: a partial answer does not rescue a `problem`.
  const failed =
    Boolean(turn.problem) &&
    !dailyLimit &&
    !excluded &&
    !isNoProvider(turn.problem) &&
    !turn.stopped;
  const stopped = turn.stopped === true;
  const status: TurnView['state'] = stopped
    ? 'stopped'
    : dailyLimit
      ? 'paused'
      : excluded
        ? 'excluded'
        : failed
          ? 'failed'
          : 'answered';
  const citations = [...turn.citations].sort((a, b) => a.n - b.n);
  const decisionsFor = (p: Proposal) => state.decisions[p.id];
  const card = stopped
    ? undefined
    : pickProposal(turn.proposals, turn.id, inputs.calendars, decisionsFor);
  const hasAnswer = answer.length > 0;
  return {
    id: turn.id,
    question: turn.question,
    state: status,
    steps: stepLog(turn.steps, false, state.expanded.includes(turn.id)),
    answer: hasAnswer ? answer : undefined,
    citations: citations.map(citationData),
    targets: new Map(citations.map(c => [c.n, openTarget(c)])),
    provider: providerLabel(turn.model?.provider ?? inputs.askModel?.provider, inputs.providers),
    provenance: hasAnswer ? provenance(turn.model, inputs.providers) : undefined,
    proposal: card,
    sourceLine: hasAnswer && !failed ? (citations.length > 0 ? 'cited' : 'noSource') : null,
    excludedNote: excludedNote(turn.excludedAccountIds, inputs.accountNames),
    live: false,
  };
}

function pickProposal(
  proposals: readonly Proposal[],
  turnId: string,
  calendars: ReadonlyMap<string, TodayCalendar>,
  decisionFor: (p: Proposal) => Decision | undefined,
): ProposalView | undefined {
  const views = proposals
    .map(p => proposalCard(p, turnId, calendars, effectiveProposalState(p, decisionFor(p))))
    .filter((v): v is ProposalView => v !== null && v.state !== 'dismissed');
  return views.find(v => v.state === 'pending') ?? views[views.length - 1];
}

/**
 * The live turn's card, held until the run ends: the engine stores a turn's proposals only at finish, so a card the
 * owner could accept while the run streams would fail `Ask/decide` notFound and revert with a "Couldn't …" toast.
 */
function liveCard(
  run: RunRef,
  live: LiveRun,
  id: string,
  finished: boolean,
  inputs: AskInputs,
  state: AskState,
): ProposalView | undefined {
  if (run.stopped || !finished) return undefined;
  return pickProposal(live.proposals, id, inputs.calendars, p => state.decisions[p.id]);
}

/**
 * The live turn's state from the run's flags and its folded frames: a refusal or an error frame becomes the
 * quiet paused or excluded line, or a real failure — never counted as an answer.
 */
function liveStatus(run: RunRef, live: LiveRun, hasAnswer: boolean): TurnView['state'] {
  if (run.stopped) return 'stopped';
  const errored = live.terminal === 'error';
  if (isDailyLimit(run.refused) || (errored && isDailyLimit(live.problem))) return 'paused';
  if (isAccountExcluded(run.refused) || (errored && isAccountExcluded(live.problem)))
    return 'excluded';
  const refused = run.refused !== undefined && !isNoProvider(run.refused);
  if (refused || (errored && !isNoProvider(live.problem))) return 'failed';
  if (live.terminal !== undefined || run.refused !== undefined) return 'answered';
  return hasAnswer ? 'streaming' : 'working';
}

function liveTurn(run: RunRef, live: LiveRun, inputs: AskInputs, state: AskState): TurnView {
  const id = live.turnId ?? run.clientId;
  const known = new Set(live.citations.map(c => c.citation.n));
  const blocks = streamBlocks(
    live.text,
    live.citations.map(c => ({ at: c.at, n: c.citation.n })),
  );
  const answer = toParagraphs(blocks, known);
  const hasAnswer = answer.length > 0;
  const finished = run.stopped || live.terminal !== undefined || run.refused !== undefined;
  const status = liveStatus(run, live, hasAnswer);
  const citations = [...live.citations].map(c => c.citation).sort((a, b) => a.n - b.n);
  const card = liveCard(run, live, id, finished, inputs, state);
  return {
    id,
    question: run.question,
    state: status,
    steps: stepLog(live.steps, status === 'working', state.expanded.includes(id)),
    answer: hasAnswer ? answer : undefined,
    citations: citations.map(citationData),
    targets: new Map(citations.map(c => [c.n, openTarget(c)])),
    provider: providerLabel(inputs.askModel?.provider, inputs.providers),
    provenance: hasAnswer && finished ? provenance(inputs.askModel, inputs.providers) : undefined,
    proposal: card,
    sourceLine:
      hasAnswer && finished && status !== 'failed'
        ? citations.length > 0
          ? 'cited'
          : 'noSource'
        : null,
    live: true,
  };
}

/** Whether the live run has ended (a terminal frame, a refusal, or a stop). */
export function runEnded(run: RunRef | undefined, live: LiveRun): boolean {
  if (!run) return true;
  return run.stopped || run.refused !== undefined || live.terminal !== undefined;
}

/** Everything the dock draws. */
export interface DockView {
  readonly turns: readonly TurnView[];
  /** An answer is coming: Esc stops before it clears or closes. */
  readonly working: boolean;
  readonly providerReady: boolean;
  readonly empty?: Omit<AskEmptyData, 'onPickSuggestion' | 'onOpenRecent'>;
  readonly queued: readonly QueuedFollowUp[];
  readonly field: string;
  /** The newest open proposal, the one Return and Esc act on. */
  readonly pendingProposal?: ProposalView;
  /** A submitted question waits for the consent line's Allow rather than running at once. */
  readonly consentNeeded: boolean;
}

/** The turns the dock draws, oldest first: stored turns, earlier runs still on the wire, then the live run. */
function collectTurns(
  state: AskState,
  inputs: AskInputs,
  live: LiveRun,
  working: boolean,
): TurnView[] {
  const run = state.run;
  const stored = inputs.conversation?.turns ?? [];
  const turns: TurnView[] = [];
  for (const turn of stored) {
    // While its run is going, the live frames draw the turn even if the engine stored it early.
    if (working && live.turnId === turn.id) continue;
    turns.push(storedTurn(turn, inputs, state));
  }
  for (const past of state.past) {
    const old = foldFrames(inputs.frames, past.runId);
    const kept = old.turnId !== undefined && stored.some(t => t.id === old.turnId);
    if (!kept && !(past.refused && isNoProvider(past.refused))) {
      turns.push(liveTurn({ ...past, settled: true }, old, inputs, state));
    }
  }
  const settledInStore = live.turnId !== undefined && stored.some(t => t.id === live.turnId);
  if (run && (working || !settledInStore)) {
    if (!(run.refused && isNoProvider(run.refused))) turns.push(liveTurn(run, live, inputs, state));
  }
  return turns;
}

/** The dock's one card: only the newest pending proposal stays a card (the others are cleared in `turns`). */
function takePendingProposal(turns: TurnView[]): ProposalView | undefined {
  let pendingProposal: ProposalView | undefined;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const card = turns[i].proposal;
    if (card?.state !== 'pending') continue;
    if (!pendingProposal) pendingProposal = card;
    else turns[i] = { ...turns[i], proposal: undefined };
  }
  return pendingProposal;
}

function emptyView(state: AskState, inputs: AskInputs): DockView['empty'] {
  return {
    suggestions: inputs.suggestions.slice(0, 3),
    recents: inputs.recents
      .slice(0, 5)
      .map(r => ({ id: r.id, question: r.title, at: toIsoDateTime(r.updatedAt) })),
    cursorIndex: state.cursor,
  };
}

export function dockView(state: AskState, inputs: AskInputs): DockView {
  const run = state.run;
  const live = foldFrames(inputs.frames, run?.runId);
  const working = run !== undefined && !runEnded(run, live);
  const turns = collectTurns(state, inputs, live, working);
  const pendingProposal = takePendingProposal(turns);

  const noProvider =
    isNoProvider(run?.refused) || (live.terminal === 'error' && isNoProvider(live.problem));
  const providerReady = inputs.askReady && !noProvider;
  const showEmpty = turns.length === 0 && state.conversationId === undefined;
  return {
    turns,
    working,
    providerReady,
    empty: showEmpty ? emptyView(state, inputs) : undefined,
    queued: state.queued.map(({ id, text }) => ({ id, text })),
    field: state.field,
    pendingProposal,
    consentNeeded: inputs.consentNeeded === true,
  };
}

/** The registry's conditions for the ask context (`onlyWhen`). */
export function askConditions(view: DockView, proposalFocused: boolean) {
  return {
    streaming: view.working,
    askText: view.field.length > 0,
    proposal: proposalFocused && view.pendingProposal !== undefined,
    queued: view.queued.length > 0,
  } as const;
}

/**
 * The shell key layer the mounted dock contributes: only the resolver's conditions. The 'ask' context itself
 * comes from the dock root's `data-keyctx="ask"`, so its commands answer while focus is inside the dock and
 * nowhere else — never in the mail list, a compose field or Settings.
 */
export function askKeyLayer(view: DockView, proposalFocused: boolean) {
  return { conditions: askConditions(view, proposalFocused) };
}

/**
 * The run ids whose `progress` frames the host subscribes to — the live run, then the remembered past ones — padded
 * to a fixed length (`undefined` = an unused slot) so the hook calls stay constant. A runId-scoped `useFrames`
 * subscription is seeded with every frame the run has sent (the bus keeps a per-run log for late subscribers), so a
 * dock reopened mid-run folds the whole stream, settles a finished run, and never draws a phantom live turn beside
 * the stored one. A source-wide subscription starts empty and can only fold what arrives after it opened.
 */
export function trackedRunIds(state: AskState): readonly (string | undefined)[] {
  const ids: (string | undefined)[] = [state.run?.runId];
  for (const past of state.past.slice(-PAST_RUNS)) ids.push(past.runId);
  while (ids.length < PAST_RUNS + 1) ids.push(undefined);
  return ids;
}

/* ───────────────────────── actions ───────────────────────── */

export function setField(state: AskState, text: string): AskState {
  return {
    ...state,
    field: text,
    history: undefined,
    cursor: text === '' ? state.cursor : undefined,
  };
}

function nextId(state: AskState, prefix: string): [AskState, string] {
  return [{ ...state, seq: state.seq + 1 }, `${prefix}-${state.seq + 1}`];
}

/** How many earlier runs stay drawn while the engine stores them. */
export const PAST_RUNS = 3;

function startRun(state: AskState, question: string, searchAll: boolean): AskStep {
  const [next, clientId] = nextId(state, 'ask');
  const past = state.run ? [...state.past, state.run].slice(-PAST_RUNS) : state.past;
  return step(
    {
      ...next,
      past,
      run: { clientId, question, searchAll, stopped: false, settled: false },
      cursor: undefined,
      history: undefined,
    },
    { kind: 'run', clientId, question, conversationId: state.conversationId, searchAll },
  );
}

/** Return ('ask') or ⌘Return ('searchAll') in the field. */
export function submit(state: AskState, view: DockView, mode: 'ask' | 'searchAll'): AskStep {
  const text = state.field.trim();
  if (text === '') {
    if (mode === 'ask' && view.pendingProposal) return decide(state, view, true);
    if (mode === 'ask' && view.empty && state.cursor !== undefined) return pickCursor(state, view);
    // ⌘Return with an empty field sends the first queued card now — while the run works it is stopped
    // first (sendNow), and after it stopped or failed it simply starts the card's run.
    if (mode === 'searchAll' && state.queued.length > 0)
      return sendNow(state, view, state.queued[0].id);
    return step(state);
  }
  if (view.working) {
    const [next, id] = nextId(state, 'queued');
    const queued: AskState = {
      ...next,
      field: '',
      queued: [...state.queued, { id, text, searchAll: mode === 'searchAll' }],
    };
    // ⌘Return while streaming sends the queue now (decision 8).
    return mode === 'searchAll' ? sendNow(queued, view, queued.queued[0].id) : step(queued);
  }
  // Before consent the question is held, not run: Allow sends it, "Not now" keeps the text in the field.
  if (view.consentNeeded) {
    return step({ ...state, consentHeld: { question: text, searchAll: mode === 'searchAll' } });
  }
  return startRun({ ...state, field: '' }, text, mode === 'searchAll');
}

/** A queued card's text changed. */
export function editQueued(state: AskState, id: string, text: string): AskState {
  return { ...state, queued: state.queued.map(q => (q.id === id ? { ...q, text } : q)) };
}

/** ⌘Return in a queued card: stop the running answer (its partial text stays) and ask this one now. */
export function sendNow(state: AskState, view: DockView, id: string): AskStep {
  const card = state.queued.find(q => q.id === id);
  if (!card) return step(state);
  const rest = { ...state, queued: state.queued.filter(q => q.id !== id) };
  if (card.text.trim() === '') return step(rest);
  const effects: AskEffect[] = [];
  let base = rest;
  if (view.working && state.run) {
    if (state.run.runId) effects.push({ kind: 'cancel', runId: state.run.runId });
    base = { ...rest, run: { ...state.run, stopped: true, settled: true } };
  }
  // A held card still stops the answer it jumped ahead of: Allow then runs only the held question.
  if (view.consentNeeded) {
    return step(
      { ...base, consentHeld: { question: card.text.trim(), searchAll: card.searchAll } },
      ...effects,
    );
  }
  const started = startRun(base, card.text.trim(), card.searchAll);
  return step(started.state, ...effects, ...started.effects);
}

/**
 * `Ask/run` answered. A run stopped before its id came back (Esc, send now) is cancelled now; so is a run the state
 * no longer knows — ⌘N or a recent chat dropped it while the call was in flight, so nothing else watches it.
 */
export function runStarted(
  state: AskState,
  clientId: string,
  runId: string,
  conversationId: string,
): AskStep {
  if (state.run?.clientId === clientId) {
    const run = { ...state.run, runId };
    return step(
      { ...state, conversationId, run },
      ...(run.stopped ? [{ kind: 'cancel', runId } as const] : []),
    );
  }
  const past = state.past.find(p => p.clientId === clientId);
  if (!past) return step(state, { kind: 'cancel', runId });
  return step(
    { ...state, conversationId, past: state.past.map(p => (p === past ? { ...p, runId } : p)) },
    { kind: 'cancel', runId },
  );
}

/** `Ask/run` was refused. */
export function runRefused(
  state: AskState,
  clientId: string,
  error: Pick<ErrorBody, 'type' | 'reasonCode' | 'message'>,
): AskState {
  if (state.run?.clientId !== clientId) return state;
  // With no provider the question never became a turn: it goes back in the field, so nothing typed is lost.
  // An excluded draft's account hands it back too, so the owner can ask from another account.
  const field =
    (isNoProvider(error) || isAccountExcluded(error)) && state.field === ''
      ? state.run.question
      : state.field;
  return { ...state, field, run: { ...state.run, refused: error } };
}

/**
 * Call when the frames change. Once the run ends it settles, and if it finished normally the next queued question
 * runs — unless consent came due mid-run, in which case the card is held for the line's Allow like any other run
 * start. A stopped or failed run leaves the queue for the owner (⌘Return sends a card).
 */
export function advance(
  state: AskState,
  frames: readonly ProgressFrame[],
  consentNeeded: boolean,
): AskStep {
  const run = state.run;
  if (!run || run.settled) return step(state);
  const live = foldFrames(frames, run.runId);
  if (!runEnded(run, live)) return step(state);
  // With no provider the question never became an answer: it goes back in the field, so nothing typed is
  // lost. An exclusion refusal hands it back the same way, so the owner can ask from another account.
  const giveBack =
    live.terminal === 'error' &&
    (isNoProvider(live.problem) || isAccountExcluded(live.problem)) &&
    state.field === '';
  const settled: AskState = {
    ...state,
    field: giveBack ? run.question : state.field,
    run: { ...run, settled: true },
  };
  const ok = !run.stopped && run.refused === undefined && live.terminal === 'done';
  if (!ok) return step(settled);
  const [first, ...rest] = settled.queued;
  if (!first) return step(settled);
  if (first.text.trim() === '') return advance({ ...settled, queued: rest }, frames, consentNeeded);
  if (consentNeeded) {
    return step({
      ...settled,
      queued: rest,
      consentHeld: { question: first.text.trim(), searchAll: first.searchAll },
    });
  }
  return startRun({ ...settled, queued: rest }, first.text.trim(), first.searchAll);
}

/** Esc's next rung (DESIGN §8 Ask; mockup adds the proposal before close). */
export type EscRung = 'declineProposal' | 'stop' | 'clear' | 'dismissProposal' | 'close';

export function escRung(state: AskState, view: DockView, proposalFocused: boolean): EscRung {
  if (proposalFocused && view.pendingProposal) return 'declineProposal';
  if (view.working) return 'stop';
  if (state.field.length > 0) return 'clear';
  if (view.pendingProposal) return 'dismissProposal';
  return 'close';
}

/** Esc. Stops, clears, declines or closes; never navigates. */
export function escape(state: AskState, view: DockView, proposalFocused = false): AskStep {
  switch (escRung(state, view, proposalFocused)) {
    case 'declineProposal':
    case 'dismissProposal':
      return decide(state, view, false);
    case 'stop':
      return stop(state);
    case 'clear':
      return step({ ...state, field: '', history: undefined });
    case 'close':
      return step(state, { kind: 'close' });
  }
}

/** Stop the running answer; its partial text stays. */
export function stop(state: AskState): AskStep {
  const run = state.run;
  if (!run || run.stopped || run.settled) return step(state);
  const stopped: AskState = { ...state, run: { ...run, stopped: true } };
  return run.runId ? step(stopped, { kind: 'cancel', runId: run.runId }) : step(stopped);
}

/** Accept (Return, Add) or dismiss (Esc, Not now) the newest open proposal. Applies at once; the engine confirms. */
export function decide(
  state: AskState,
  view: DockView,
  accept: boolean,
  proposalId?: string,
): AskStep {
  const card = proposalId
    ? view.turns.map(t => t.proposal).find(p => p?.proposalId === proposalId)
    : view.pendingProposal;
  if (!card || card.state !== 'pending' || !state.conversationId) return step(state);
  return step(
    {
      ...state,
      decisions: { ...state.decisions, [card.proposalId]: { accept, phase: 'sending' } },
    },
    {
      kind: 'decide',
      proposalId: card.proposalId,
      turnId: card.turnId,
      conversationId: state.conversationId,
      accept,
    },
  );
}

/** The engine's answer to a decision. A refusal returns the card to pending. */
export function decided(
  state: AskState,
  proposalId: string,
  outcome: { ok: true; eventId?: string; draftId?: string } | { ok: false },
): AskState {
  const decision = state.decisions[proposalId];
  if (!decision) return state;
  const next: Decision = outcome.ok
    ? { ...decision, phase: 'applied', eventId: outcome.eventId, draftId: outcome.draftId }
    : { ...decision, phase: 'failed' };
  return { ...state, decisions: { ...state.decisions, [proposalId]: next } };
}

/** ⌘N: a new chat, empty, with the field focused. Queued questions belong to the old chat and go. */
export function newChat(state: AskState): AskStep {
  const effects: AskEffect[] = [];
  if (state.run && !state.run.settled && !state.run.stopped && state.run.runId) {
    effects.push({ kind: 'cancel', runId: state.run.runId });
  }
  return step({ ...initialAsk, seq: state.seq }, ...effects);
}

/** A recent chat was opened. */
export function openConversation(state: AskState, conversationId: string): AskStep {
  const fresh = newChat(state);
  return step({ ...fresh.state, conversationId }, ...fresh.effects, {
    kind: 'openConversation',
    conversationId,
  });
}

/** ↑/↓: through suggestions and recents in the empty view; in a conversation with an empty field, earlier questions. */
export function arrow(state: AskState, view: DockView, dir: 1 | -1): AskState {
  if (view.empty) {
    const total = view.empty.suggestions.length + view.empty.recents.length;
    if (total === 0) return state;
    const at = state.cursor;
    const next = at === undefined ? (dir === 1 ? 0 : total - 1) : (at + dir + total) % total;
    return { ...state, cursor: next };
  }
  const questions = view.turns.map(t => t.question);
  if (questions.length === 0) return state;
  if (state.field !== '' && state.history === undefined) return state;
  const back = (state.history ?? 0) + (dir === -1 ? 1 : -1);
  if (back <= 0) return { ...state, history: undefined, field: '' };
  const index = Math.max(0, questions.length - back);
  return { ...state, history: Math.min(back, questions.length), field: questions[index] };
}

/** Return on the empty view's cursor: ask that suggestion or open that recent chat. */
export function pickCursor(state: AskState, view: DockView): AskStep {
  if (!view.empty || state.cursor === undefined) return step(state);
  const { suggestions, recents } = view.empty;
  if (state.cursor < suggestions.length) {
    const question = suggestions[state.cursor];
    if (view.consentNeeded) {
      return step({ ...state, consentHeld: { question, searchAll: false } });
    }
    return startRun(state, question, false);
  }
  const recent = recents[state.cursor - suggestions.length];
  return recent ? openConversation(state, recent.id) : step(state);
}

export function toggleSteps(state: AskState, turnId: string): AskState {
  const open = state.expanded.includes(turnId);
  return {
    ...state,
    expanded: open ? state.expanded.filter(id => id !== turnId) : [...state.expanded, turnId],
  };
}

/** Retry after a provider error: the same question again, in the same conversation. */
export function retry(state: AskState, view: DockView, turnId: string): AskStep {
  const turn = view.turns.find(t => t.id === turnId);
  if (!turn || turn.state !== 'failed' || view.working) return step(state);
  if (view.consentNeeded) {
    return step({
      ...state,
      consentHeld: { question: turn.question, searchAll: state.run?.searchAll ?? false },
    });
  }
  return startRun(state, turn.question, state.run?.searchAll ?? false);
}

/**
 * The consent half of every run start's gate: only a granted, current record lets a question run;
 * ungranted, stale or still-unloaded records all hold it — unknown is never consent. "Not now" is
 * not consulted here at all: it hides only the line (`consentLineNeeded`), it is not consent.
 */
export function consentGate(consent: Consent | undefined): boolean {
  return !consent || !consent.granted || consent.needsReconsent;
}

/**
 * The `consentNeeded` input a submit answers to. Once the sources answer with no model at all the
 * gate steps aside — there is nothing to consent to — and the run is refused so the no-provider
 * pane shows instead.
 */
export function consentNeededInput(
  sourcesLoaded: boolean,
  model: ModelRef | undefined,
  consent: Consent | undefined,
): boolean {
  return consentGate(consent) && !(sourcesLoaded && model === undefined);
}

/**
 * The consent line's visibility: the record is known and still owes consent, unless "Not now"
 * dismissed it for this version — but a question held behind the gate brings the line back, so a
 * further Return after "Not now" re-shows it rather than failing silently.
 */
export function consentLineNeeded(
  consent: Consent | undefined,
  dismissed: number | undefined,
  held: boolean,
): boolean {
  if (consent === undefined || !consentGate(consent)) return false;
  if (held) return true;
  return dismissed === undefined || dismissed < consent.currentVersion;
}

/**
 * When the palette's pending question may leave the store: the sources have answered and the
 * consent record is known — earlier there is no gate to hold it behind and it would run past
 * consent entirely.
 */
export function pendingQuestionReady(
  sourcesLoaded: boolean,
  consent: Consent | undefined,
): boolean {
  return sourcesLoaded && consent !== undefined;
}

/** The consent line's Allow (the grant already landed): the held question runs now. */
export function consentGranted(state: AskState): AskStep {
  const held = state.consentHeld;
  if (!held) return step(state);
  return startRun(
    {
      ...state,
      consentHeld: undefined,
      field: state.field === held.question ? '' : state.field,
    },
    held.question,
    held.searchAll,
  );
}

/** "Not now" drops the hold; the question's text stays in the field. */
export function consentDropped(state: AskState): AskState {
  return state.consentHeld ? { ...state, consentHeld: undefined } : state;
}

/** Static suggestions when `Ask/suggestions` has none; plain questions, no name the owner did not give. */
export const FALLBACK_SUGGESTIONS: readonly string[] = [
  'What needs a reply from me today?',
  'When am I free tomorrow afternoon?',
  'What did I miss this week?',
];

/**
 * Drops decisions the stored conversation now reflects (the proposal is no longer open there), so the store rules
 * again: an Undo that reopens the proposal in the engine brings the card back.
 */
export function pruneDecisions(state: AskState, conversation: Conversation | undefined): AskState {
  if (!conversation) return state;
  const stored = new Map<string, Proposal>();
  for (const turn of conversation.turns) for (const p of turn.proposals) stored.set(p.id, p);
  let changed = false;
  const next: Record<string, Decision> = {};
  for (const [id, decision] of Object.entries(state.decisions)) {
    const proposal = stored.get(id);
    if (decision.phase === 'applied' && proposal && proposal.state !== 'open') {
      changed = true;
      continue;
    }
    next[id] = decision;
  }
  return changed ? { ...state, decisions: next } : state;
}
