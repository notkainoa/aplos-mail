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
import type { TagColor } from '../../ui/props';
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
  | { readonly phase: 'done'; readonly key: string; readonly runId: string; readonly localIds: readonly string[] }
  /** Google asked us to slow down; `resumeAt` when known. */
  | { readonly phase: 'paused'; readonly key: string; readonly resumeAt?: number }
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
}

/** The query the page searches for right now, and its key (the canonical text; equal keys are the same search). */
export function currentQuery(state: SearchState): { query: SearchQuery; key: string; empty: boolean } {
  const { tokens, free } = currentSearch(state.field, state.tokens);
  const query = toSearchQuery(tokens, free);
  return { query, key: formatSearch(tokens, query.text), empty: isEmptyQuery(query) };
}

/** Typing in the field. Never a remote effect. */
export function typeField(state: SearchState, text: string): SearchStep {
  if (text.startsWith('>')) {
    // The palette takes over; the field keeps what it had (map-ask decision).
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

/** True when this query already went to Google and needs nothing more from Return. */
function alreadyAsked(remote: RemoteState, key: string, now: number): boolean {
  if (remote.phase === 'idle' || !('key' in remote) || remote.key !== key) return false;
  if (remote.phase === 'failed') return remote.reason !== 'error' && remote.reason !== 'offline';
  if (remote.phase === 'paused') return remote.resumeAt === undefined || remote.resumeAt > now;
  return true;
}

/** Return in the field: the only way remote search runs. */
export function submit(state: SearchState, ctx: RemoteContext): SearchStep {
  const { query, key, empty } = currentQuery(state);
  if (empty || !ctx.supported) return { state, effects: [] };
  if (ctx.pausedUntil !== undefined && ctx.pausedUntil > ctx.now) {
    return { state: { ...state, remote: { phase: 'paused', key, resumeAt: ctx.pausedUntil } }, effects: [] };
  }
  if (alreadyAsked(state.remote, key, ctx.now)) return { state, effects: [] };
  return {
    state: {
      ...state,
      remote: { phase: 'starting', key, at: ctx.now, localIds: [...ctx.localIds] },
    },
    effects: [{ kind: 'remote', query, key }],
  };
}

/** `Search/remote` answered with its run id. */
export function remoteStarted(state: SearchState, key: string, runId: string): SearchState {
  const remote = state.remote;
  if (remote.phase !== 'starting' || remote.key !== key) return state;
  return { ...state, remote: { ...remote, phase: 'running', runId } };
}

/** Maps a refusal to the line the page shows; never the provider's text. */
function refusal(key: string, error: Pick<ErrorBody, 'type' | 'reasonCode' | 'resumeAt'>): RemoteState {
  const code = error.reasonCode ?? '';
  if (error.type === 'paused' || code.startsWith('rate.') || code.startsWith('quota.')) {
    return { phase: 'paused', key, resumeAt: error.resumeAt };
  }
  if (code === 'net.offline') return { phase: 'failed', key, reason: 'offline' };
  if (error.type === 'needsReauth' || error.type === 'permission' || code.startsWith('auth.')) {
    return { phase: 'failed', key, reason: 'needsReauth' };
  }
  if (error.type === 'unsupported' || error.type === 'unavailable' || error.type === 'notImplemented') {
    return { phase: 'failed', key, reason: 'unavailable' };
  }
  return { phase: 'failed', key, reason: 'error' };
}

/** `Search/remote` was refused. */
export function remoteRejected(state: SearchState, key: string, error: ErrorBody): SearchState {
  const remote = state.remote;
  if (remote.phase !== 'starting' || remote.key !== key) return state;
  return { ...state, remote: refusal(key, error) };
}

/** A `progress` frame of the remote run. */
export function remoteFrame(state: SearchState, frame: ProgressFrame): SearchState {
  const remote = state.remote;
  if ((remote.phase !== 'running' && remote.phase !== 'starting') || remote.runId !== frame.runId) return state;
  if (frame.kind === 'done') return { ...state, remote: { phase: 'done', key: remote.key, runId: frame.runId, localIds: remote.localIds } };
  if (frame.kind === 'error') {
    return {
      ...state,
      remote: refusal(remote.key, { type: 'providerError', reasonCode: frame.problem?.reasonCode }),
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

/** The line under the results about Google. */
export type RemoteLine =
  | { readonly kind: 'offer'; readonly text: string }
  | { readonly kind: 'busy'; readonly text: string }
  | { readonly kind: 'none'; readonly text: string }
  | { readonly kind: 'paused'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string; readonly retry: boolean };

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

/** The page's view of the state, the local window and the clock. */
export function searchPage(state: SearchState, local: LocalResults, now: number, supported = true): SearchPageModel {
  const { query, key, empty } = currentQuery(state);
  const remote = 'key' in state.remote && state.remote.key === key ? state.remote : ({ phase: 'idle' } as const);
  const before =
    remote.phase === 'running' || remote.phase === 'starting' || remote.phase === 'done'
      ? new Set(remote.localIds)
      : null;
  const localIds = before ? local.ids.filter(id => before.has(id)) : [...local.ids];
  const remoteIds = before ? local.ids.filter(id => !before.has(id)) : [];
  const localCount = before ? Math.max(0, local.total - remoteIds.length) : local.total;

  let remoteLine: RemoteLine | null = null;
  if (!empty && supported) {
    if (local.status === 'failed' && local.error && refusal(key, local.error).phase === 'paused') {
      remoteLine = { kind: 'paused', text: pausedText(local.error.resumeAt) };
    } else if (remote.phase === 'idle') {
      remoteLine = { kind: 'offer', text: SEARCH_GOOGLE };
    } else if (remote.phase === 'starting' || remote.phase === 'running') {
      remoteLine = now - remote.at >= BUSY_DELAY_MS ? { kind: 'busy', text: 'Searching Google…' } : null;
    } else if (remote.phase === 'done') {
      remoteLine = remoteIds.length === 0 ? { kind: 'none', text: 'Nothing on Google either. Try fewer words.' } : null;
    } else if (remote.phase === 'paused') {
      remoteLine = { kind: 'paused', text: pausedText(remote.resumeAt) };
    } else {
      remoteLine = {
        kind: 'failed',
        text: FAILED_TEXT[remote.reason],
        retry: remote.reason === 'error' || remote.reason === 'offline',
      };
    }
  }

  const settled = local.status === 'live' || local.status === 'reset' || local.status === 'failed';
  const nothing = settled && localCount === 0 && remoteIds.length === 0;
  const shown = formatSearch(currentSearch(state.field, state.tokens).tokens, query.text);
  const noMatch = !empty && nothing ? `No mail matches ‘${shown}’.` : null;
  // The no-match line carries the offer itself (EmptyLine's action), so the separate offer row hides.
  const line = noMatch && remoteLine?.kind === 'offer' ? null : remoteLine;

  let announce = '';
  if (!empty && settled) {
    announce =
      localCount === 0 ? 'No results.' : `${localCount} ${localCount === 1 ? 'result' : 'results'} in your mail.`;
  }

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
    remoteLine: line,
    announce,
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
  readonly account?: { readonly label: string; readonly color: TagColor };
  /** Remote rows carry the same actions (map-ask UNCLEAR-13): they are real Gmail threads. */
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

/** One row from a thread. */
export function resultRow(
  thread: Pick<ThreadRow, 'id' | 'fromName' | 'subject' | 'snippet' | 'unread' | 'lastDate' | 'hasAttachments' | 'workflow' | 'accountId'>,
  query: SearchQuery,
  remote: boolean,
  account?: { label: string; color: TagColor },
): ResultRow {
  return {
    id: `search-row-${thread.id.replace(/[^A-Za-z0-9_-]/g, '_')}`,
    threadId: thread.id,
    sender: thread.fromName || '(no sender)',
    primary: thread.subject || '(no subject)',
    secondary: thread.snippet || undefined,
    highlight: highlightTerms(query),
    unread: thread.unread,
    date: toIsoDateTime(thread.lastDate),
    marks: { attachment: thread.hasAttachments || undefined, bookmarked: thread.workflow.bookmarked || undefined },
    account,
    remote,
  };
}
