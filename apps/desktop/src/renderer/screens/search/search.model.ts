/**
 * The Search page's view model (DESIGN §7.9, §7.14, §5 rule 12; plan 30 U7 acceptance 7). Pure, no React.
 *
 * Local results come from the `search` window as the owner types. Remote Gmail search runs only on Return, exactly
 * once per Return: the one place that can ask for it is `submit`, which returns a `remote` effect only when this
 * query has not already gone to Google (or its last try failed and may be retried). Typing, removing a token, a
 * window `reset`, a re-render and a second Return with the same query never ask again. While the account is paused
 * Return shows the pause line and asks nothing.
 *
 * `>` as the first character opens the palette with the rest as its query; the field keeps its previous text.
 */
import { toIsoDateTime } from '../../data';
import type { ErrorBody, ProgressFrame, SearchQuery, ThreadRow } from '../../data';
import type { SearchOperator } from '../../ui/props';
import {
  absorbTokens,
  currentSearch,
  formatSearch,
  isEmptyQuery,
  toSearchQuery,
  type SearchToken,
} from './parse';

/** A remote search on its way. `localIds` are the window's ids at Return, so ids that join later are Google's. */
export interface PendingRemote {
  readonly key: string;
  readonly at: number;
  readonly runId?: string;
  readonly localIds: readonly string[];
}

/** Where Return's remote search stands, for one query key. */
export type RemoteState =
  | { readonly phase: 'idle' }
  /** Return pressed; the call is on its way (`starting`) or answered with its run id (`running`). */
  | ({ readonly phase: 'starting' } & PendingRemote)
  | ({ readonly phase: 'running' } & PendingRemote)
  | {
      readonly phase: 'done';
      readonly key: string;
      readonly runId: string;
      readonly localIds: readonly string[];
    }
  /** Google asked us to slow down; `resumeAt` when known, `at` when the pause was recorded. */
  | {
      readonly phase: 'paused';
      readonly key: string;
      readonly resumeAt?: number;
      readonly at?: number;
    }
  | {
      readonly phase: 'failed';
      readonly key: string;
      readonly reason: 'offline' | 'needsReauth' | 'unavailable' | 'error';
    };

export interface SearchState {
  /** The free text in the field. */
  readonly field: string;
  /** Pills under the field. */
  readonly tokens: readonly SearchToken[];
  readonly remote: RemoteState;
}

export const initialSearch: SearchState = { field: '', tokens: [], remote: { phase: 'idle' } };

/** Something the container must do. */
export type SearchEffect =
  | { readonly kind: 'remote'; readonly query: SearchQuery; readonly key: string }
  | { readonly kind: 'openPalette'; readonly query: string };

export interface SearchStep {
  readonly state: SearchState;
  readonly effects: readonly SearchEffect[];
}

/** What the page needs to know about the account when Return is pressed. */
export interface RemoteContext {
  readonly now: number;
  /** The account (or every account) can search on the server (`capabilities.serverSearch`). */
  readonly supported: boolean;
  /** The account is paused until this time (rate limit, daily quota); Return asks nothing before it. */
  readonly pausedUntil?: number;
  /** The local window's ids at this moment. */
  readonly localIds: readonly string[];
  /** The account scope this remote search belongs to ('all' for every account): folded into the remote key. */
  readonly scope: string;
}

/** The remote key for a query in one account scope: the same query under another scope is a different remote search. */
export function remoteKey(scope: string, queryKey: string): string {
  return `${scope}|${queryKey}`;
}

/** The query the page searches for right now, and its key (the canonical text; equal keys are the same search). */
export function currentQuery(state: SearchState): {
  query: SearchQuery;
  key: string;
  empty: boolean;
} {
  const { tokens, free } = currentSearch(state.field, state.tokens);
  const query = toSearchQuery(tokens, free);
  return { query, key: formatSearch(tokens, query.text), empty: isEmptyQuery(query) };
}

/** Typing in the field. Never a remote effect. */
export function typeField(state: SearchState, text: string): SearchStep {
  if (text.startsWith('>')) {
    // The palette takes over; the field keeps what it had.
    return { state, effects: [{ kind: 'openPalette', query: text.slice(1).trimStart() }] };
  }
  const absorbed = absorbTokens(text, state.tokens);
  return { state: { ...state, field: absorbed.field, tokens: absorbed.tokens }, effects: [] };
}

/** The remove button on a pill, or Backspace in an empty field (the last pill). Never a remote effect. */
export function removeToken(state: SearchState, index: number): SearchStep {
  if (index < 0 || index >= state.tokens.length) return { state, effects: [] };
  return { state: { ...state, tokens: state.tokens.filter((_, i) => i !== index) }, effects: [] };
}

/**
 * Esc in the field: the text and every token clear at once, so a second Esc on the empty field can go back
 * (`nav.back`). Never a remote effect; a remote search that is still running keeps its keyed state, so typing the
 * same query again finds it as it was.
 */
export function clearField(state: SearchState): SearchStep {
  if (state.field === '' && state.tokens.length === 0) return { state, effects: [] };
  return { state: { ...state, field: '', tokens: [] }, effects: [] };
}

/** Return may retry a pause that named no resume time once this much time has passed. */
export const PAUSE_GRACE_MS = 60_000;

/** True when this query already went to Google and needs nothing more from Return. */
function alreadyAsked(remote: RemoteState, key: string, now: number): boolean {
  if (remote.phase === 'idle' || !('key' in remote) || remote.key !== key) return false;
  if (remote.phase === 'failed') return remote.reason !== 'error' && remote.reason !== 'offline';
  if (remote.phase === 'paused') {
    if (remote.resumeAt !== undefined) return remote.resumeAt > now;
    // No resume time: block a short grace after the refusal, then let Return retry (it no longer blocks forever).
    return remote.at !== undefined && now - remote.at < PAUSE_GRACE_MS;
  }
  return true;
}

/** Return in the field: the only way remote search runs. */
export function submit(state: SearchState, ctx: RemoteContext): SearchStep {
  const { query, key, empty } = currentQuery(state);
  if (empty || !ctx.supported) return { state, effects: [] };
  const scoped = remoteKey(ctx.scope, key);
  if (ctx.pausedUntil !== undefined && ctx.pausedUntil > ctx.now) {
    return {
      state: {
        ...state,
        remote: { phase: 'paused', key: scoped, resumeAt: ctx.pausedUntil, at: ctx.now },
      },
      effects: [],
    };
  }
  if (alreadyAsked(state.remote, scoped, ctx.now)) return { state, effects: [] };
  return {
    state: {
      ...state,
      remote: { phase: 'starting', key: scoped, at: ctx.now, localIds: [...ctx.localIds] },
    },
    effects: [{ kind: 'remote', query, key: scoped }],
  };
}

/** `Search/remote` answered with its run id. */
export function remoteStarted(state: SearchState, key: string, runId: string): SearchState {
  const remote = state.remote;
  if (remote.phase !== 'starting' || remote.key !== key) return state;
  return { ...state, remote: { ...remote, phase: 'running', runId } };
}

/** Maps a refusal to the line the page shows; never the provider's text. `at` is when the refusal landed. */
function refusal(
  key: string,
  error: Pick<ErrorBody, 'type' | 'reasonCode' | 'resumeAt'>,
  at?: number,
): RemoteState {
  const code = error.reasonCode ?? '';
  if (error.type === 'paused' || code.startsWith('rate.') || code.startsWith('quota.')) {
    return { phase: 'paused', key, resumeAt: error.resumeAt, at };
  }
  if (code === 'net.offline') return { phase: 'failed', key, reason: 'offline' };
  if (error.type === 'needsReauth' || error.type === 'permission' || code.startsWith('auth.')) {
    return { phase: 'failed', key, reason: 'needsReauth' };
  }
  if (
    error.type === 'unsupported' ||
    error.type === 'unavailable' ||
    error.type === 'notImplemented'
  ) {
    return { phase: 'failed', key, reason: 'unavailable' };
  }
  return { phase: 'failed', key, reason: 'error' };
}

/** `Search/remote` was refused. `now` stamps a resume-less pause so Return can retry after a grace. */
export function remoteRejected(
  state: SearchState,
  key: string,
  error: ErrorBody,
  now?: number,
): SearchState {
  const remote = state.remote;
  if (remote.phase !== 'starting' || remote.key !== key) return state;
  return { ...state, remote: refusal(key, error, now) };
}

/** A `progress` frame of the remote run. `now` stamps a resume-less pause, as in `remoteRejected`. */
export function remoteFrame(state: SearchState, frame: ProgressFrame, now?: number): SearchState {
  const remote = state.remote;
  if ((remote.phase !== 'running' && remote.phase !== 'starting') || remote.runId !== frame.runId)
    return state;
  if (frame.kind === 'done')
    return {
      ...state,
      remote: { phase: 'done', key: remote.key, runId: frame.runId, localIds: remote.localIds },
    };
  if (frame.kind === 'error') {
    return {
      ...state,
      remote: refusal(
        remote.key,
        { type: 'providerError', reasonCode: frame.problem?.reasonCode },
        now,
      ),
    };
  }
  return state;
}

/* ───────────────────────── the page ───────────────────────── */

/** The local `search` window as the page reads it. */
export interface LocalResults {
  readonly status: 'opening' | 'live' | 'reset' | 'failed';
  readonly ids: readonly string[];
  readonly total: number;
  readonly error?: Pick<ErrorBody, 'type' | 'reasonCode' | 'resumeAt'> | null;
}

/**
 * Whether a saved cursor may land yet: its row is in the list, else the local window has settled (so the row really is
 * gone and its neighbour is right). Landing earlier would put a Google result's cursor on a local neighbour when the
 * local rows arrive before the rows the saved search had added.
 */
export function returnReady(
  savedId: string | null | undefined,
  ids: readonly string[],
  status: LocalResults['status'],
): boolean {
  if (savedId && ids.includes(savedId)) return true;
  return status === 'live' || status === 'reset' || status === 'failed';
}

/** The line under the results about Google. */
export type RemoteLine =
  | { readonly kind: 'offer'; readonly text: string }
  | { readonly kind: 'busy'; readonly text: string }
  | { readonly kind: 'none'; readonly text: string }
  | { readonly kind: 'paused'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string; readonly retry: boolean };

/**
 * The one banner a failed window draws (#322). Every kind carries Try again, and Try again always reopens the
 * view — a dead window must never dead-end, not even on sign-in or a pause.
 */
export type LocalLine =
  /** The window's error has no sentence it can safely borrow: "Couldn’t load this list." (DESIGN §7.15). */
  | { readonly kind: 'list' }
  /** A sentence that truthfully names the window's failure: the sign-in line, or the pause notice. */
  | { readonly kind: 'reason'; readonly text: string };

export interface SearchPageModel {
  readonly field: string;
  readonly tokens: readonly SearchToken[];
  readonly query: SearchQuery;
  readonly empty: boolean;
  /** "In your mail": the window's ids that were there before Google answered. */
  readonly localIds: readonly string[];
  readonly localCount: number;
  /** "From Google": ids that joined the window after Return, only hits not already local. */
  readonly remoteIds: readonly string[];
  /** "No mail matches ‘dentist’." when nothing local matches and Google has nothing new. */
  readonly noMatch: string | null;
  /** The no-match line carries "Search all mail on Google · Return" itself (DESIGN §7.14). */
  readonly noMatchOffer: boolean;
  /** The local window failed (status 'failed'): its own banner (`localLine`) is the page's one failure line —
   * "No mail matches" never draws, the remote's line hides until the window stands again, and Try again always
   * reopens the view. */
  readonly localFailed: boolean;
  /** The failed window's banner, or null while the window stands. */
  readonly localLine: LocalLine | null;
  /** The window failed with no reason it can safely name: the generic list line draws (§7.15). */
  readonly listFailed: boolean;
  readonly remoteLine: RemoteLine | null;
  /** The polite live region's sentence. */
  readonly announce: string;
}

/** Spinners wait 150 ms (DESIGN §5 rule 12). */
export const BUSY_DELAY_MS = 150;

export const SEARCH_GOOGLE = 'Search all mail on Google';

/** "2:14 PM" in the machine's locale clock (en-US in the harness). */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function pausedText(resumeAt?: number): string {
  return resumeAt !== undefined
    ? `Google asked us to slow down. Search again at ${clockTime(resumeAt)}.`
    : 'Google asked us to slow down. Search again in a few minutes.';
}

const FAILED_TEXT = {
  offline: 'You’re offline. Your mail on this Mac is still searched.',
  needsReauth: 'Google needs you to sign in again before it can search.',
  unavailable: 'This account can’t search on Google.',
  error: 'Google didn’t answer. Try again.',
} as const;

/** The line under the results about Google, for a remote state that belongs to the current query. */
function remoteLineFor(remote: RemoteState, now: number, remoteCount: number): RemoteLine | null {
  switch (remote.phase) {
    case 'idle':
      return { kind: 'offer', text: SEARCH_GOOGLE };
    case 'starting':
    case 'running':
      return now - remote.at >= BUSY_DELAY_MS ? { kind: 'busy', text: 'Searching Google…' } : null;
    case 'done':
      return remoteCount === 0
        ? { kind: 'none', text: 'Nothing on Google either. Try fewer words.' }
        : null;
    case 'paused':
      return { kind: 'paused', text: pausedText(remote.resumeAt) };
    default:
      return {
        kind: 'failed',
        text: FAILED_TEXT[remote.reason],
        retry: remote.reason === 'error' || remote.reason === 'offline',
      };
  }
}

/**
 * The failed window's banner: a needsReauth error borrows the sign-in sentence and a pause the pause notice
 * (with its resume time) — both true of the window — while anything else, named or not, gets the generic list
 * line. The remote's own copy would describe a failure the window never had (a dead local view is not "this
 * account can't search on Google", and "your mail on this Mac is still searched" is false when that search is
 * what failed).
 */
function localLineFor(local: LocalResults): LocalLine | null {
  if (local.status !== 'failed') return null;
  if (local.error) {
    const declined = refusal('', local.error);
    if (declined.phase === 'paused') return { kind: 'reason', text: pausedText(declined.resumeAt) };
    if (declined.phase === 'failed' && declined.reason === 'needsReauth') {
      return { kind: 'reason', text: FAILED_TEXT.needsReauth };
    }
  }
  return { kind: 'list' };
}

/** The polite live region's sentence. */
function announceText(settled: boolean, empty: boolean, localCount: number): string {
  if (empty || !settled) return '';
  return localCount === 0
    ? 'No results.'
    : `${localCount} ${localCount === 1 ? 'result' : 'results'} in your mail.`;
}

/** The remote state for this query in this scope, or idle when it belongs to another scope or query. */
function scopedRemote(remote: RemoteState, scoped: string): RemoteState {
  return 'key' in remote && remote.key === scoped ? remote : { phase: 'idle' };
}

/** A failure banner's Try again: reopen the window while it is down, re-ask Google once it stands. */
export function retryTarget(model: Pick<SearchPageModel, 'localFailed'>): 'results' | 'submit' {
  return model.localFailed ? 'results' : 'submit';
}

/**
 * The Google line while the window stands. While the window is down its own banner is the page's one failure
 * line and the remote's hides with it; it returns once the window stands again (#322). Also null on an empty
 * query or an account that cannot search on Google.
 */
function shownRemoteLine(
  localFailed: boolean,
  empty: boolean,
  supported: boolean,
  remote: RemoteState,
  now: number,
  remoteCount: number,
): RemoteLine | null {
  if (empty || !supported || localFailed) return null;
  return remoteLineFor(remote, now, remoteCount);
}

/** The page's view of the state, the local window and the clock. `scope` is the account scope the page shows. */
export function searchPage(
  state: SearchState,
  local: LocalResults,
  now: number,
  supported = true,
  scope = 'all',
): SearchPageModel {
  const { query, key, empty } = currentQuery(state);
  const remote = scopedRemote(state.remote, remoteKey(scope, key));
  const before =
    remote.phase === 'running' || remote.phase === 'starting' || remote.phase === 'done'
      ? new Set(remote.localIds)
      : null;
  const localIds = before ? local.ids.filter(id => before.has(id)) : [...local.ids];
  const remoteIds = before ? local.ids.filter(id => !before.has(id)) : [];
  const localCount = before ? Math.max(0, local.total - remoteIds.length) : local.total;

  const localFailed = local.status === 'failed';
  const localLine = localLineFor(local);
  const remoteLine = shownRemoteLine(localFailed, empty, supported, remote, now, remoteIds.length);
  const listFailed = localLine?.kind === 'list';

  const settled = local.status === 'live' || local.status === 'reset' || localFailed;
  // A failed window is not "no mail": the error line says so, and the region announces nothing wrong.
  const nothing = settled && !localFailed && localCount === 0 && remoteIds.length === 0;
  const shown = formatSearch(currentSearch(state.field, state.tokens).tokens, query.text);
  const noMatch = !empty && nothing ? `No mail matches ‘${shown}’` : null;
  // The no-match line carries the offer itself (EmptyLine's action), so the separate offer row hides.
  const line = noMatch && remoteLine?.kind === 'offer' ? null : remoteLine;

  return {
    field: state.field,
    tokens: state.tokens,
    query,
    empty,
    localIds,
    localCount,
    remoteIds,
    noMatch,
    noMatchOffer: noMatch !== null && remoteLine?.kind === 'offer',
    localFailed,
    localLine,
    listFailed,
    remoteLine: line,
    announce: announceText(settled && !localFailed, empty, localCount),
  };
}

/* ───────────────────────── rows ───────────────────────── */

/** A result row's facts for `ListRow`, before callbacks (DESIGN §6 ListRow, §7.9: ordinary rows). */
export interface ResultRow {
  readonly id: string;
  readonly threadId: string;
  readonly sender: string;
  readonly primary: string;
  readonly secondary?: string;
  readonly highlight: readonly string[];
  readonly unread: boolean;
  readonly date: string;
  readonly marks: { readonly attachment?: boolean; readonly bookmarked?: boolean };
  readonly account?: { readonly label: string };
  /** Remote rows carry the same actions: they are real Gmail threads. */
  readonly remote: boolean;
}

/** The free words to bold in subjects and snippets; quoted phrases stay whole, operators never bold. */
export function highlightTerms(query: SearchQuery): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"?|(\S+)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(query.text)) !== null) {
    const term = (hit[1] ?? hit[2] ?? '').trim();
    if (term.length > 0) terms.push(term);
  }
  if (query.subject) terms.push(query.subject);
  return [...new Set(terms)];
}

/** How many characters of snippet may come before the first match; the rest of the cell is for the match itself. */
const SNIPPET_LEAD = 20;
/** A subject cell is narrower: its match may start this far in before the subject is cut to show it. */
const SUBJECT_FITS = 18;
const SUBJECT_LEAD = 6;

/**
 * The snippet with its first match near the left edge, so the one ellipsis the cell draws at its end never hides the
 * matched word. A leading "…" marks the cut; text with no match or a match already near the start is unchanged.
 */
export function snippetAround(
  text: string,
  terms: readonly string[],
  lead = SNIPPET_LEAD,
  fits = SNIPPET_LEAD,
): string {
  const words = terms.map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
  const lower = text.toLowerCase();
  const found = words.map(w => lower.indexOf(w)).filter(i => i >= 0);
  if (found.length === 0) return text;
  const at = Math.min(...found);
  if (at <= fits) return text;
  const boundary = text.indexOf(' ', at - lead);
  const start = boundary >= 0 && boundary < at ? boundary + 1 : at - lead;
  return `…${text.slice(start)}`;
}

/** One row from a thread. */
export function resultRow(
  thread: Pick<
    ThreadRow,
    | 'id'
    | 'fromName'
    | 'subject'
    | 'snippet'
    | 'unread'
    | 'lastDate'
    | 'hasAttachments'
    | 'workflow'
    | 'accountId'
  >,
  query: SearchQuery,
  remote: boolean,
  account?: { label: string },
): ResultRow {
  const highlight = highlightTerms(query);
  return {
    id: `search-row-${thread.id.replace(/[^A-Za-z0-9_-]/g, '_')}`,
    threadId: thread.id,
    sender: thread.fromName || '(no sender)',
    primary: thread.subject
      ? snippetAround(thread.subject, highlight, SUBJECT_LEAD, SUBJECT_FITS)
      : '(no subject)',
    secondary: thread.snippet ? snippetAround(thread.snippet, highlight) : undefined,
    highlight,
    unread: thread.unread,
    date: toIsoDateTime(thread.lastDate),
    marks: {
      attachment: thread.hasAttachments || undefined,
      bookmarked: thread.workflow.bookmarked || undefined,
    },
    account,
    remote,
  };
}

/** The tokens as the field's pills; `is:` rides a one-place cast until the props union gains it (REQUESTS.md). */
export function fieldTokens(
  tokens: readonly SearchToken[],
): readonly { operator: SearchOperator; value: string }[] {
  return tokens as readonly { operator: SearchOperator; value: string }[];
}
