/**
 * The Ask dock's view model, the parts that read the engine's stream: folding progress frames into a live run,
 * answer text and its paragraphs, citations, provider labels and the proposal cards. Pure. `ask.model.ts` re-exports
 * it.
 */
import { toIsoDateTime } from '../../data';
import type {
  AiProvider,
  Citation,
  ErrorBody,
  ModelRef,
  ProgressFrame,
  Proposal,
} from '../../data';
import type {
  AnswerParagraph,
  AnswerSegment,
  CitationData,
  ProposalCardProps,
} from '../../ui/props';
import { formatWhen, instant, type TodayCalendar } from '../today/today.model';
import type { Decision } from './ask.model';

/* ───────────────────────── frames ───────────────────────── */

/** What the live run's frames add up to. */
export interface LiveRun {
  readonly turnId?: string;
  readonly steps: readonly {
    readonly id: string;
    readonly text: string;
    readonly state: string;
    readonly count?: number;
  }[];
  readonly text: string;
  readonly citations: readonly { readonly citation: Citation; readonly at: number }[];
  readonly proposals: readonly Proposal[];
  readonly terminal?: 'done' | 'error';
  readonly problem?: { readonly reasonCode: string };
}

/** Folds a run's frames, oldest first. Frames of other runs are ignored. */
export function foldFrames(frames: readonly ProgressFrame[], runId: string | undefined): LiveRun {
  const steps = new Map<string, { id: string; text: string; state: string; count?: number }>();
  const citations = new Map<number, { citation: Citation; at: number }>();
  const proposals = new Map<string, Proposal>();
  let text = '';
  let turnId: string | undefined;
  let terminal: LiveRun['terminal'];
  let problem: LiveRun['problem'];
  if (runId !== undefined) {
    for (const frame of frames) {
      if (frame.runId !== runId || frame.source !== 'ask') continue;
      if (frame.turnId) turnId = frame.turnId;
      if (terminal) continue;
      switch (frame.kind) {
        case 'step':
          if (frame.step) steps.set(frame.step.id, { ...frame.step });
          break;
        case 'text':
          text += frame.delta ?? '';
          break;
        case 'citation':
          if (frame.citation) {
            citations.set(frame.citation.n, {
              citation: frame.citation,
              at: frame.at ?? text.length,
            });
          }
          break;
        case 'proposal':
          if (frame.proposal) proposals.set(frame.proposal.id, frame.proposal);
          break;
        case 'done':
          terminal = 'done';
          break;
        case 'error':
          terminal = 'error';
          problem = { reasonCode: frame.problem?.reasonCode ?? 'ai.failed' };
          break;
        default:
          break;
      }
    }
  }
  return {
    turnId,
    steps: [...steps.values()],
    text,
    citations: [...citations.values()],
    proposals: [...proposals.values()],
    terminal,
    problem,
  };
}

/* ───────────────────────── answer text ───────────────────────── */

type Block = {
  text: string;
  strong?: readonly { start: number; end: number }[];
  cites?: readonly { at: number; n: number }[];
  /** This block is one list item of a numbered (`number`) or bulleted list. */
  item?: { ordered: boolean; number?: number };
};

/** A list line: `1.`, `1)`, `-`, `*` or `•`, then the item's text. */
const LIST_LINE = /^[ \t]*(?:(\d{1,3})[.)]|[-*\u2022])[ \t]+/;

/** One paragraph or list item of a block: a range of its text. */
interface Part {
  start: number;
  end: number;
  item?: Block['item'];
}

function itemOf(number: string | undefined): NonNullable<Block['item']> {
  return number === undefined ? { ordered: false } : { ordered: true, number: Number(number) };
}

/** The block's lines grouped into parts: a list line opens an item, a plain line after text continues it. */
function partsOf(text: string): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    const mark = LIST_LINE.exec(line);
    const last = parts[parts.length - 1];
    const end = at + line.length;
    if (mark) parts.push({ start: at + mark[0].length, end, item: itemOf(mark[1]) });
    else if (line.trim() === '') parts.push({ start: end, end });
    else if (last && last.end > last.start) last.end = end;
    else parts.push({ start: at, end });
    at = end + 1;
  }
  return parts.filter(part => part.end > part.start);
}

/** The part a chip belongs to: the last one that starts at or before it (a chip at a break ends the part before). */
function ownerOf(parts: readonly Part[], at: number): number {
  let owner = 0;
  parts.forEach((part, i) => {
    if (part.start <= at) owner = i;
  });
  return owner;
}

/**
 * A block as paragraphs and list items (`1.`, `-`), one block per item, with its emphasis and chips moved to the item
 * they sit in. A block with no list line comes back as it is.
 */
export function splitLists(block: Block): Block[] {
  const parts = partsOf(block.text);
  if (!parts.some(part => part.item)) return [block];
  const cites = block.cites ?? [];
  return parts.map((part, i) => {
    const length = part.end - part.start;
    const within = (offset: number) => Math.max(0, Math.min(length, offset - part.start));
    return {
      text: block.text.slice(part.start, part.end),
      strong: (block.strong ?? [])
        .map(range => ({ start: within(range.start), end: within(range.end) }))
        .filter(range => range.end > range.start),
      cites: cites.filter(c => ownerOf(parts, c.at) === i).map(c => ({ at: within(c.at), n: c.n })),
      ...(part.item ? { item: part.item } : {}),
    };
  });
}

/** Clamps an offset into the text without splitting a surrogate pair. */
function clampAt(text: string, at: number): number {
  let i = Math.max(0, Math.min(text.length, Math.floor(at)));
  if (i > 0 && i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) i += 1;
  }
  return i;
}

/**
 * Paragraphs of segments from answer blocks. Only the first emphasised range in the whole answer stays weight 500
 * (DESIGN §7.7: the decisive fact). Chips whose number has no citation are dropped.
 */
export function toParagraphs(
  blocks: readonly Block[],
  known: ReadonlySet<number>,
): AnswerParagraph[] {
  let decisiveUsed = false;
  const out: AnswerParagraph[] = [];
  for (const block of blocks.flatMap(splitLists)) {
    const text = block.text;
    let strong: { start: number; end: number } | undefined;
    if (!decisiveUsed) {
      const first = (block.strong ?? [])
        .map(r => ({ start: clampAt(text, r.start), end: clampAt(text, r.end) }))
        .find(r => r.end > r.start);
      if (first) {
        strong = first;
        decisiveUsed = true;
      }
    }
    const cites = (block.cites ?? [])
      .filter(c => known.has(c.n))
      .map(c => ({ at: clampAt(text, c.at), n: c.n }))
      .sort((a, b) => a.at - b.at || a.n - b.n);
    const cuts = new Set<number>([0, text.length, ...cites.map(c => c.at)]);
    if (strong) {
      cuts.add(strong.start);
      cuts.add(strong.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const segments: AnswerSegment[] = block.item
      ? [
          {
            kind: 'item',
            ordered: block.item.ordered,
            ...(block.item.number !== undefined ? { number: block.item.number } : {}),
          },
        ]
      : [];
    const seen = new Set<number>();
    for (let i = 0; i < points.length; i += 1) {
      const at = points[i];
      for (const cite of cites) {
        if (cite.at === at && !seen.has(cite.n)) {
          seen.add(cite.n);
          segments.push({ kind: 'cite', index: cite.n });
        }
      }
      const next = points[i + 1];
      if (next === undefined || next <= at) continue;
      const piece = text.slice(at, next);
      const bold = strong !== undefined && at >= strong.start && next <= strong.end;
      segments.push(
        bold ? { kind: 'text', text: piece, strong: true } : { kind: 'text', text: piece },
      );
    }
    if (segments.some(s => s.kind !== 'item')) out.push(segments);
  }
  return out;
}

/** Streamed text as blocks: paragraphs split on blank lines, chips mapped from offsets in the joined text. */
export function streamBlocks(text: string, cites: readonly { at: number; n: number }[]): Block[] {
  const blocks: { text: string; start: number; cites: { at: number; n: number }[] }[] = [];
  const breaks = /\n[ \t]*\n\s*/g;
  let start = 0;
  let hit: RegExpExecArray | null;
  while ((hit = breaks.exec(text)) !== null) {
    blocks.push({ text: text.slice(start, hit.index), start, cites: [] });
    start = hit.index + hit[0].length;
  }
  blocks.push({ text: text.slice(start), start, cites: [] });
  for (const cite of cites) {
    // A chip belongs to the paragraph it falls in; one at a break sits at the end of the paragraph before.
    let owner = blocks[0];
    for (const block of blocks) if (cite.at >= block.start) owner = block;
    owner.cites.push({
      at: Math.max(0, Math.min(cite.at - owner.start, owner.text.length)),
      n: cite.n,
    });
  }
  return blocks
    .filter(b => b.text.trim() !== '' || b.cites.length > 0)
    .map(b => ({ text: b.text, cites: b.cites }));
}

/* ───────────────────────── citations ───────────────────────── */

/** Where a citation's click goes. */
export type OpenTarget =
  | { readonly kind: 'thread'; readonly threadId: string; readonly messageId: string }
  | { readonly kind: 'event'; readonly eventId: string };

export function citationData(citation: Citation): CitationData {
  if (citation.kind === 'event') {
    const start = instant(citation.start);
    return {
      index: citation.n,
      kind: 'event',
      eventId: citation.eventId,
      quote: citation.title,
      from: 'Calendar',
      date: Number.isFinite(start) ? toIsoDateTime(start) : '',
      subject: citation.title,
      threadId: '',
    };
  }
  return {
    index: citation.n,
    kind: 'message',
    quote: citation.quote,
    from: citation.fromName?.trim() || 'Email',
    date: citation.date !== undefined ? toIsoDateTime(citation.date) : '',
    subject: citation.subject?.trim() || '(no subject)',
    threadId: citation.threadId,
  };
}

export function openTarget(citation: Citation): OpenTarget {
  return citation.kind === 'event'
    ? { kind: 'event', eventId: citation.eventId }
    : { kind: 'thread', threadId: citation.threadId, messageId: citation.messageId };
}

/* ───────────────────────── providers ───────────────────────── */

/** Fallback labels while `Ai/providers` has not answered; they mirror the contract's `askProviders` table. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  groq: 'Groq',
  openai: 'ChatGPT',
  anthropic: 'Claude',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  'opencode-go': 'OpenCode Go',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'Custom',
};

export function providerLabel(
  id: string | undefined,
  providers: readonly Pick<AiProvider, 'id' | 'label'>[] = [],
): string | undefined {
  if (!id) return undefined;
  return providers.find(p => p.id === id)?.label ?? PROVIDER_LABELS[id] ?? id;
}

/** The hover provenance ("Answer by Groq", "…on this Mac" via `AskTurn`'s title); local only when the provider table says so (FR-5). */
export function provenance(
  model: ModelRef | undefined,
  providers: readonly Pick<AiProvider, 'id' | 'label' | 'local'>[] = [],
): { provider: string; local: boolean } | undefined {
  if (!model) return undefined;
  return {
    provider: providerLabel(model.provider, providers) ?? model.provider,
    local: providers.find(p => p.id === model.provider)?.local === true,
  };
}

/** Reason codes that mean Ask has no provider to ask, rather than a provider that failed. */
const NO_PROVIDER = new Set(['ai.noProvider', 'ai.missingKey']);

export function isNoProvider(
  error:
    Pick<ErrorBody, 'type' | 'reasonCode'> | { reasonCode?: string; type?: string } | undefined,
): boolean {
  if (!error) return false;
  return error.type === 'notConfigured' || NO_PROVIDER.has(error.reasonCode ?? '');
}

/**
 * Reason codes that mean the chosen model is done for today (ARCH §8.4): the turn says "Paused for today. Resumes
 * tomorrow." instead of an error, with "Use another provider".
 */
const DAILY_LIMIT = new Set(['ai.dailyCap', 'ai.dailyLimit', 'ai.paused']);

export function isDailyLimit(
  error:
    Pick<ErrorBody, 'type' | 'reasonCode'> | { reasonCode?: string; type?: string } | undefined,
): boolean {
  return DAILY_LIMIT.has(error?.reasonCode ?? '');
}

/** The refusal for a draft (or every account) left out of AI: a quiet line, not a provider failure. */
export function isAccountExcluded(
  error:
    Pick<ErrorBody, 'type' | 'reasonCode'> | { reasonCode?: string; type?: string } | undefined,
): boolean {
  return error?.reasonCode === 'ai.accountExcluded';
}

/** "Use another provider": ready providers other than the one that failed. */
export function otherProviders<P extends Pick<AiProvider, 'id' | 'status'>>(
  providers: readonly P[],
  failing?: string,
): P[] {
  return providers.filter(p => p.status === 'ready' && p.id !== failing);
}

/* ───────────────────────── proposals ───────────────────────── */

/** The card for one proposal, before callbacks. */
export interface ProposalView extends Omit<ProposalCardProps, 'onConfirm' | 'onDismiss'> {
  readonly proposalId: string;
  readonly turnId: string;
}

const TRIAGE: Readonly<Record<string, { kicker: string; confirm: string; applied: string }>> = {
  done: { kicker: 'Mark Done', confirm: 'Mark Done', applied: 'Marked Done' },
  later: { kicker: 'Move to Later', confirm: 'Move', applied: 'Moved to Later' },
  trash: { kicker: 'Move to Trash', confirm: 'Move', applied: 'Moved to Trash' },
  bookmark: { kicker: 'Bookmark', confirm: 'Bookmark', applied: 'Bookmarked' },
  read: { kicker: 'Mark as read', confirm: 'Mark read', applied: 'Marked as read' },
};

function emails(n: number): string {
  return `${n} ${n === 1 ? 'email' : 'emails'}`;
}

/** The card's words for a proposal, or null for a kind this build does not know. */
export function proposalCard(
  proposal: Proposal,
  turnId: string,
  calendars: ReadonlyMap<string, TodayCalendar>,
  state: ProposalCardProps['state'],
): ProposalView | null {
  const base = { proposalId: proposal.id, turnId, state };
  switch (proposal.kind) {
    case 'addEvent': {
      const event = proposal.event;
      const calendar = proposal.calendarId ? calendars.get(proposal.calendarId) : undefined;
      const start = instant(event.start);
      const end = instant(event.end);
      const when =
        Number.isFinite(start) && Number.isFinite(end) ? formatWhen(start, end, event.allDay) : '';
      const consequence =
        [when, calendar?.name].filter(Boolean).join(' · ') || proposal.consequence;
      return {
        ...base,
        kicker: 'Add to Calendar',
        title: event.title,
        consequence,
        color: calendar?.color,
        confirmLabel: 'Add',
        appliedText: `Added to Calendar · ${consequence}`,
      };
    }
    case 'reply': {
      const subject = proposal.draft.subject?.trim();
      return {
        ...base,
        kicker: 'Reply',
        title: subject || 'Reply',
        consequence: proposal.consequence,
        confirmLabel: 'Open draft',
        appliedText: `Saved as a draft${subject ? ` · ${subject}` : ''}`,
      };
    }
    case 'triage': {
      const words = TRIAGE[proposal.action.type];
      if (!words) return null;
      return {
        ...base,
        kicker: words.kicker,
        title: emails(proposal.threadIds.length),
        consequence: proposal.consequence,
        confirmLabel: words.confirm,
        appliedText: `${words.applied} · ${emails(proposal.threadIds.length)}`,
      };
    }
    default:
      return null;
  }
}

/** A proposal's state after the owner's decisions here: a decision shows at once; a refused one reverts. */
export function effectiveProposalState(
  proposal: Proposal,
  decision: Decision | undefined,
): 'pending' | 'applied' | 'dismissed' {
  if (decision && decision.phase !== 'failed') return decision.accept ? 'applied' : 'dismissed';
  if (proposal.state === 'accepted') return 'applied';
  if (proposal.state === 'dismissed') return 'dismissed';
  return 'pending';
}
