/**
 * Recipient type-ahead, the pure part (DESIGN 7.6): which entries from `Contact/suggest` are offered, which one is
 * highlighted, and how the arrow keys move it. The engine answers from local data only, so a lookup here never asks
 * the mail provider anything. No React, no clock: the debounce lives in `runtime/useRecipientSuggest`.
 */
import type { Recipient } from '../../../ui/props';
import { containsAt, isValidAddress } from './recipients';

/** Wait this long after the last keystroke before asking: typing a name asks once, not once per letter. */
export const SUGGEST_DEBOUNCE_MS = 120;
/** How many matches the dropdown shows. */
export const SUGGEST_LIMIT = 6;

/** One row of `Contact/suggest`'s answer. */
export interface SuggestEntry {
  readonly address: string;
  readonly name?: string;
  readonly sentTo: number;
  readonly receivedFrom: number;
}

/**
 * The From account's correspondents first, then anyone the owner's other accounts know that it does not. Typing a name
 * must find the person whichever account the message happens to come from (the default From can be any account).
 */
export function withOtherAccounts(
  own: readonly SuggestEntry[],
  all: readonly SuggestEntry[],
): readonly SuggestEntry[] {
  const seen = new Set(own.map(e => e.address.toLowerCase()));
  const rest = all.filter(e => {
    const key = e.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...own, ...rest];
}

/** What asks the engine: the typed text and the From account whose correspondents count. */
export type SuggestFn = (query: string, accountId: string) => Promise<readonly SuggestEntry[]>;

/** The matches as recipients, in the engine's order, without anyone already on this row, repeats or odd addresses. */
export function toSuggestions(
  entries: readonly SuggestEntry[],
  taken: readonly Recipient[],
): readonly Recipient[] {
  const seen = new Set(taken.map(r => r.id));
  const out: Recipient[] = [];
  for (const e of entries) {
    const id = e.address.toLowerCase();
    if (seen.has(id) || !isValidAddress(e.address)) continue;
    seen.add(id);
    out.push(e.name ? { id, name: e.name, address: e.address } : { id, address: e.address });
  }
  return out.slice(0, SUGGEST_LIMIT);
}

/**
 * The highlight before any arrow key: the first match while a name is being typed, nothing once the typed text holds
 * an "@" (a whole address is being written, and Return must commit what was typed, not swap it for a neighbour; the fullwidth ＠ of a Japanese IME counts).
 */
export function initialActive(query: string, list: readonly Recipient[]): string | undefined {
  return containsAt(query) ? undefined : list[0]?.id;
}

/** The highlight after an arrow key: down from nothing is the first, up from nothing is the last; both wrap. */
export function moveActive(
  list: readonly Recipient[],
  activeId: string | undefined,
  delta: 1 | -1,
): string | undefined {
  if (list.length === 0) return undefined;
  const at = list.findIndex(r => r.id === activeId);
  if (at < 0) return list[delta === 1 ? 0 : list.length - 1]!.id;
  return list[(at + delta + list.length) % list.length]!.id;
}

/** What a key does while the dropdown is open. Return is the field's own (it accepts the highlighted match). */
export type SuggestKey =
  | { readonly type: 'highlight'; readonly id: string | undefined }
  | { readonly type: 'accept'; readonly id: string }
  | { readonly type: 'close' };

/**
 * The arrows move the highlight, Tab accepts it (with nothing highlighted Tab moves on as usual), Esc closes the list
 * and nothing else. Any other key is the field's own.
 */
export function suggestKey(
  key: string,
  shift: boolean,
  list: readonly Recipient[],
  active: string | undefined,
): SuggestKey | null {
  if (list.length === 0) return null;
  if (key === 'ArrowDown') return { type: 'highlight', id: moveActive(list, active, 1) };
  if (key === 'ArrowUp') return { type: 'highlight', id: moveActive(list, active, -1) };
  if (key === 'Tab' && !shift && active) return { type: 'accept', id: active };
  if (key === 'Escape') return { type: 'close' };
  return null;
}

/** What an answer was asked for: the trimmed text and the From account. */
export interface SuggestAsked {
  readonly query: string;
  readonly accountId: string;
}

/**
 * An answer counts only for the text and account it was asked for: while the next one is on its way nothing shows, so a
 * stale list under newer text can never be picked by a quick Return.
 */
export function freshEntries(
  answer: { readonly entries: readonly SuggestEntry[]; readonly asked: SuggestAsked } | null,
  query: string,
  accountId: string,
): readonly SuggestEntry[] {
  const fresh = answer?.asked.query === query.trim() && answer.asked.accountId === accountId;
  return fresh ? answer.entries : [];
}
