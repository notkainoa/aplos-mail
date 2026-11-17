/**
 * The ⌘K palette's view model (DESIGN §7.9, §8 Palette; plan 30 U7 acceptance 1). Pure, no React.
 *
 * - Scoring: exact, then prefix, then word boundary, then subsequence, case- and accent-insensitive. A keyword hit
 *   ("archive" for Done) counts as a word-boundary match and bolds nothing. Recent commands rank one and a half tiers
 *   up, but an exact label match always comes first, so a recent command never beats an exact one.
 * - First open: Suggested (the commands the registry marks suggested for this target) and Go to (places, the ones
 *   you went to recently first), at most nine rows so 1–9 reach all of them. Typing lists everything the registry
 *   offers in this context, Settings rows included, as one ranked list, and a last row "Ask about “x”".
 * - 1–9 pick a row only while the field is empty; otherwise a digit is text.
 * - Nested pages keep a breadcrumb trail; Esc goes up a level, then closes, and never navigates.
 * - A destructive command opens the two-row confirm with Cancel as the default: Return cancels, ⇧Return confirms.
 * - The context line is derived from the same `CommandContext` the commands run with, so it cannot drift from what
 *   they act on.
 */
import { contextLine, uiIconFor } from '../../commands';
import type {
  CommandContext,
  CommandId,
  PaletteChild,
  PaletteEntry,
  RunResult,
} from '../../commands';
import type { PaletteItem, PaletteSection } from '../../ui/props';

/* ───────────────────────── scoring ───────────────────────── */

/** 4 exact, 3 prefix, 2 word boundary (or a keyword), 1 subsequence. */
export type MatchTier = 1 | 2 | 3 | 4;

export interface LabelMatch {
  readonly tier: MatchTier;
  /** Code-point indices of the label to bold. */
  readonly indices: readonly number[];
}

/** Folded code points of a string, each with the index of the label code point it came from. */
function fold(text: string): { chars: string[]; from: number[] } {
  const chars: string[] = [];
  const from: number[] = [];
  Array.from(text).forEach((char, index) => {
    const folded = char.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US');
    for (const piece of Array.from(folded)) {
      chars.push(piece);
      from.push(index);
    }
  });
  return { chars, from };
}

/** The query as folded code points, inner whitespace collapsed. */
export function foldQuery(query: string): string[] {
  return fold(query.trim().replace(/\s+/g, ' ')).chars;
}

const WORDISH = /[\p{L}\p{N}]/u;

function startsAt(hay: readonly string[], needle: readonly string[], at: number): boolean {
  if (at + needle.length > hay.length) return false;
  for (let i = 0; i < needle.length; i += 1) if (hay[at + i] !== needle[i]) return false;
  return true;
}

/** How `query` matches `label`, or null. */
export function matchLabel(query: string, label: string): LabelMatch | null {
  const q = foldQuery(query);
  if (q.length === 0) return null;
  const { chars, from } = fold(label);
  // "Move to label…" is exactly "move to label".
  let core = chars.length;
  while (core > 0 && (chars[core - 1] === '…' || chars[core - 1] === '.')) core -= 1;
  const span = (at: number, length: number) => from.slice(at, at + length);

  let qCore = q.length;
  while (qCore > 0 && (q[qCore - 1] === '…' || q[qCore - 1] === '.')) qCore -= 1;
  if (qCore > 0 && core === qCore && startsAt(chars, q.slice(0, qCore), 0)) {
    return { tier: 4, indices: unique(span(0, qCore)) };
  }
  if (startsAt(chars, q, 0)) return { tier: 3, indices: unique(span(0, q.length)) };
  for (let at = 1; at + q.length <= chars.length; at += 1) {
    if (!WORDISH.test(chars[at - 1]) && WORDISH.test(chars[at]) && startsAt(chars, q, at)) {
      return { tier: 2, indices: unique(span(at, q.length)) };
    }
  }
  // Subsequence, the loosest tier: at least four letters, each either starting a word or following the
  // previous match within one — never scattered single letters across a label ("sett" finds "Settings",
  // not "Send the question").
  if (q.length < 4) return null;
  const picked: number[] = [];
  let at = 0;
  let prev = -1;
  for (const char of q) {
    while (at < chars.length && chars[at] !== char) at += 1;
    if (at === chars.length) return null;
    const wordStart = at === 0 || !WORDISH.test(chars[at - 1]);
    if (at !== prev + 1 && !wordStart) return null;
    picked.push(from[at]);
    prev = at;
    at += 1;
  }
  return { tier: 1, indices: unique(picked) };
}

function unique(indices: readonly number[]): number[] {
  return [...new Set(indices)];
}

/** A keyword hit: exact or prefix of any keyword (folded). */
export function matchKeyword(query: string, keywords: readonly string[]): boolean {
  const q = foldQuery(query);
  if (q.length === 0) return false;
  return keywords.some(word => {
    const { chars } = fold(word);
    return startsAt(chars, q, 0);
  });
}

/** One candidate the scorer ranks. */
export interface Candidate {
  readonly id: string;
  readonly label: string;
  readonly keywords: readonly string[];
}

export interface Scored<C extends Candidate> {
  readonly candidate: C;
  readonly tier: MatchTier;
  readonly exact: boolean;
  readonly indices: readonly number[];
  /** Position in the recents list, or -1. */
  readonly recent: number;
}

/** How far a recent command is lifted: one and a half tiers, never above an exact match (see the file comment). */
export const RECENT_BOOST = 1.5;

/** Ranks candidates for a query; those that do not match are left out. Stable on catalog order. */
export function rank<C extends Candidate>(
  query: string,
  candidates: readonly C[],
  recents: readonly string[] = [],
): Scored<C>[] {
  const scored: (Scored<C> & { order: number })[] = [];
  candidates.forEach((candidate, order) => {
    const label = matchLabel(query, candidate.label);
    const keyword = matchKeyword(query, candidate.keywords);
    if (!label && !keyword) return;
    const tier = (label && label.tier >= 2 ? label.tier : keyword ? 2 : label!.tier) as MatchTier;
    scored.push({
      candidate,
      tier,
      exact: label?.tier === 4,
      indices: label && label.tier === tier ? label.indices : [],
      recent: recents.indexOf(candidate.id),
      order,
    });
  });
  const effective = (s: Scored<C>) => s.tier + (s.recent >= 0 ? RECENT_BOOST : 0);
  scored.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      effective(b) - effective(a) ||
      (a.recent < 0 ? Infinity : a.recent) - (b.recent < 0 ? Infinity : b.recent) ||
      b.tier - a.tier ||
      a.order - b.order,
  );
  return scored.map(({ order: _order, ...rest }) => rest);
}

/* ───────────────────────── state ───────────────────────── */

/** What choosing a row does. */
export type RunTarget =
  | { readonly kind: 'command'; readonly id: CommandId }
  | { readonly kind: 'child'; readonly child: PaletteChild; readonly page: number }
  | { readonly kind: 'ask'; readonly question: string };

/** A nested page and what to restore when Esc leaves it. */
export interface PalettePage {
  readonly title: string;
  readonly items: readonly PaletteChild[];
  readonly parentQuery: string;
  readonly parentActive?: string;
}

/** The two-row confirm, before callbacks are attached. */
export interface PaletteConfirm {
  readonly title: string;
  readonly prompt: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
  readonly target: RunTarget;
}

export interface PaletteState {
  readonly open: boolean;
  readonly query: string;
  readonly activeId?: string;
  readonly pages: readonly PalettePage[];
  readonly confirm?: PaletteConfirm;
}

export const closedPalette: PaletteState = { open: false, query: '', pages: [] };

export function openPalette(query = ''): PaletteState {
  return { open: true, query, pages: [] };
}

/** ⌘K: opens, or closes when open. */
export function togglePalette(state: PaletteState): PaletteState {
  return state.open ? closedPalette : openPalette();
}

export function setQuery(state: PaletteState, query: string): PaletteState {
  if (state.confirm) return state; // the field is read-only while confirming
  return { ...state, query, activeId: undefined };
}

export function setActive(state: PaletteState, id: string): PaletteState {
  return { ...state, activeId: id };
}

/** Esc: confirm → list, nested page → its parent, top level → closed. It never runs or opens anything. */
export function escape(state: PaletteState): { state: PaletteState; closed: boolean } {
  if (state.confirm) return { state: { ...state, confirm: undefined }, closed: false };
  if (state.pages.length > 0) {
    const page = state.pages[state.pages.length - 1];
    return {
      state: {
        ...state,
        pages: state.pages.slice(0, -1),
        query: page.parentQuery,
        activeId: page.parentActive,
      },
      closed: false,
    };
  }
  return { state: closedPalette, closed: true };
}

/* ───────────────────────── the view ───────────────────────── */

/** Places offered under Go to on first open, in this order after the recent ones: the ⌃1–⌃6 places in key order, so
 * the keycaps count up without a gap, then the rest. */
export const FIRST_OPEN_PLACES: readonly CommandId[] = [
  'nav.home',
  'nav.later',
  'nav.allMail',
  'nav.drafts',
  'nav.sent',
  'nav.calendar',
  'nav.done',
  'nav.trash',
  'nav.spam',
  'nav.search',
];

/** The Ask row's id and the command whose key (Return) it shows. */
export const ASK_ROW_ID = 'palette-ask';
const ASK_ROW_COMMAND = 'ask.submit';

export interface PaletteInput {
  /** The context the commands run with; the context line is read from it. */
  readonly ctx: CommandContext;
  /** `registry.commandsForPalette(ctx)`. */
  readonly entries: readonly PaletteEntry[];
  /** Recent command ids, newest first (`Settings.ui.palette.recents`). */
  readonly recents: readonly string[];
}

export interface PaletteView {
  readonly sections: readonly PaletteSection[];
  /** Every row id in display order (1–9 count along it). */
  readonly order: readonly string[];
  readonly activeId?: string;
  readonly trail: readonly string[];
  /** The context line without "For: ", or undefined when there is no target. */
  readonly context?: string;
  readonly targets: ReadonlyMap<string, RunTarget>;
  readonly confirm?: PaletteConfirm;
}

/** The palette's "For: …" text for a context, without the "For: " the component writes. */
export function paletteContext(
  ctx: Pick<CommandContext, 'target' | 'selection'>,
): string | undefined {
  const target = ctx.target;
  if (ctx.selection.length <= 1 && (!target || target.title.trim() === '')) return undefined;
  const line = contextLine(target, ctx.selection.length);
  return line.replace(/^For: /, '') || undefined;
}

function domId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function entryItem(entry: PaletteEntry, indices?: readonly number[]): PaletteItem {
  return {
    id: domId('palette-cmd', entry.id),
    commandId: entry.id,
    label: entry.label,
    icon: uiIconFor(entry.icon),
    matches: indices && indices.length > 0 ? indices : undefined,
    group: entry.group,
    destructive: entry.destructive || undefined,
    detail: entry.detail,
    opensPage: entry.page || undefined,
  };
}

function pageSection(
  state: PaletteState,
  query: string,
  targets: Map<string, RunTarget>,
): PaletteSection[] {
  const page = state.pages[state.pages.length - 1];
  if (!page) return [];
  const depth = state.pages.length;
  const children = page.items.map(child => ({
    id: child.id,
    label: child.label,
    keywords: child.keywords ?? [],
    child,
  }));
  const listed =
    query.trim() !== ''
      ? rank(query, children).map(s => ({ child: s.candidate.child, indices: s.indices }))
      : children.map(c => ({ child: c.child, indices: [] as readonly number[] }));
  const items = listed.map(({ child, indices }) => {
    const id = domId(`palette-page${depth}`, child.id);
    targets.set(id, { kind: 'child', child, page: depth });
    const item: PaletteItem = {
      id,
      commandId: child.id,
      label: child.label,
      icon: uiIconFor(child.icon),
      matches: indices.length > 0 ? indices : undefined,
      detail: child.detail,
      destructive: child.confirm?.destructive || undefined,
      opensPage: child.children ? true : undefined,
    };
    return item;
  });
  return items.length > 0 ? [{ id: 'page', label: page.title, items }] : [];
}

/** The plain command a named suggestion already is: "Reply to Jordan Park" is Reply, "Mark done" is Done. */
const NAMED_TWINS: readonly (readonly [string, RegExp])[] = [
  ['mail.reply', /^Reply to /],
  ['mail.done', /^Mark done$/],
];

/** Suggested rows without a command that "Run the suggested action" already names (one action, one row). */
export function suggestedEntries(entries: readonly PaletteEntry[]): readonly PaletteEntry[] {
  const named = entries.find(e => e.id === 'mail.suggested')?.label ?? '';
  const twins = new Set(NAMED_TWINS.filter(([, name]) => name.test(named)).map(([id]) => id));
  return entries.filter(e => e.suggested && !twins.has(e.id));
}

function firstOpenSections(input: PaletteInput, targets: Map<string, RunTarget>): PaletteSection[] {
  // At most nine rows: 1–9 must reach every row, so Suggested is capped before Go to fills what is left.
  const suggested = suggestedEntries(input.entries).slice(0, 9);
  const room = Math.max(0, 9 - suggested.length);
  const places = input.entries
    .filter(e => e.group === 'Go to' && FIRST_OPEN_PLACES.includes(e.id) && !e.suggested)
    .sort((a, b) => {
      const ra = input.recents.indexOf(a.id);
      const rb = input.recents.indexOf(b.id);
      return (
        (ra < 0 ? Infinity : ra) - (rb < 0 ? Infinity : rb) ||
        FIRST_OPEN_PLACES.indexOf(a.id) - FIRST_OPEN_PLACES.indexOf(b.id)
      );
    })
    .slice(0, room);
  const sections: PaletteSection[] = [];
  for (const [id, label, list] of [
    ['suggested', 'Suggested', suggested],
    ['goto', 'Go to', places],
  ] as const) {
    if (list.length === 0) continue;
    const items = list.map(entry => {
      const item = entryItem(entry);
      targets.set(item.id, { kind: 'command', id: entry.id });
      return item;
    });
    sections.push({ id, label, items });
  }
  return sections;
}

function filteredSections(
  state: PaletteState,
  input: PaletteInput,
  targets: Map<string, RunTarget>,
): PaletteSection[] {
  const ranked = rank(state.query, input.entries, input.recents);
  const items = ranked.map(s => {
    const item = entryItem(s.candidate, s.indices);
    targets.set(item.id, { kind: 'command', id: s.candidate.id });
    return item;
  });
  const question = state.query.trim();
  targets.set(ASK_ROW_ID, { kind: 'ask', question });
  items.push({
    id: ASK_ROW_ID,
    commandId: ASK_ROW_COMMAND,
    label: `Ask about “${question}”`,
    icon: 'bubble',
    group: 'Ask',
  });
  return [{ id: 'results', label: 'Results', items }];
}

/** The palette's sections and run targets for a state. */
export function paletteView(state: PaletteState, input: PaletteInput): PaletteView {
  const targets = new Map<string, RunTarget>();
  const typed = state.query.trim() !== '';
  const sections = state.pages.length
    ? pageSection(state, state.query, targets)
    : typed
      ? filteredSections(state, input, targets)
      : firstOpenSections(input, targets);

  const order = sections.flatMap(section => section.items.map(item => item.id));
  const activeId = state.activeId && order.includes(state.activeId) ? state.activeId : order[0];
  return {
    sections,
    order,
    activeId,
    trail: state.pages.map(p => p.title),
    context: paletteContext(input.ctx),
    targets,
    confirm: state.confirm,
  };
}

/** Return or a click on a row. */
export function choose(view: PaletteView, id: string): RunTarget | null {
  return view.targets.get(id) ?? null;
}

/** A digit 1–9: the Nth row, only while the field is empty; otherwise null and the digit is typed. */
export function pickNumber(
  state: PaletteState,
  view: PaletteView,
  digit: number,
): RunTarget | null {
  if (state.query !== '' || state.confirm || !Number.isInteger(digit) || digit < 1 || digit > 9)
    return null;
  const id = view.order[digit - 1];
  return id ? choose(view, id) : null;
}

/** What the palette does after the registry answered a run. */
export interface Applied {
  readonly state: PaletteState;
  /** The palette closes (the command ran, or a setting opened). */
  readonly closed: boolean;
  /** A command id to record as recent. */
  readonly recent?: CommandId;
}

/** Folds the registry's answer (or the Ask row's own run) into the palette. */
export function applyRun(
  state: PaletteState,
  target: RunTarget,
  result: RunResult | { readonly status: 'ask' },
): Applied {
  switch (result.status) {
    case 'confirm':
      return {
        state: {
          ...state,
          confirm: {
            title: result.title,
            prompt: result.prompt,
            confirmLabel: result.confirmLabel,
            destructive: result.destructive,
            target,
          },
        },
        closed: false,
      };
    case 'page':
      return {
        state: {
          ...state,
          confirm: undefined,
          query: '',
          activeId: undefined,
          pages: [
            ...state.pages,
            {
              title: result.title,
              items: result.items,
              parentQuery: state.query,
              parentActive: state.activeId,
            },
          ],
        },
        closed: false,
      };
    case 'ran':
    case 'navigate':
    case 'ask': {
      const top = target.kind === 'command' ? target.id : undefined;
      return { state: closedPalette, closed: true, recent: top };
    }
    default:
      // failed, disabled, unhandled, unknown: stay open; the registry already reported a failure.
      return { state: { ...state, confirm: undefined }, closed: false };
  }
}

/** Return / ⇧Return on the confirm. Destructive: Return cancels and ⇧Return confirms; otherwise Return confirms. */
export function confirmKey(
  confirm: Pick<PaletteConfirm, 'destructive'>,
  shift: boolean,
): 'confirm' | 'cancel' {
  if (!confirm.destructive) return 'confirm';
  return shift ? 'confirm' : 'cancel';
}

/** Records a run in the recents list, newest first, at most `max`. */
export function pushRecent(recents: readonly string[], id: string, max = 20): string[] {
  return [id, ...recents.filter(r => r !== id)].slice(0, max);
}

/** The live-region sentence for the confirm (DESIGN §11.3); the component announces it on entry. */
export function confirmAnnouncement(confirm: PaletteConfirm): string {
  return confirm.destructive
    ? `${confirm.title} Cancel is selected. Return cancels, Shift Return confirms.`
    : `${confirm.title} Return confirms, Escape cancels.`;
}
