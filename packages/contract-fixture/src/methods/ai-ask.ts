import type { AskTurn, Citation, Proposal, ThreadRow } from '@aplos/contract';
import type { AskScript } from '../control-types';
import { clean } from './util';

export type Block = NonNullable<AskTurn['answer']>['blocks'][number];

/** The found threads as one paragraph each, with its chip wherever the paragraph ends. */
export function fallbackBlocks(found: ThreadRow[]): Block[] {
  if (!found.length) return [{ text: 'I could not find anything about that in your mail.' }];
  return found.map((t, i) => {
    const said = (t.summary.text ?? t.subject).replace(/[.\s]+$/, '');
    return { text: `${said}.`, cites: [{ at: said.length, n: i + 1 }] };
  });
}

export const askBlocks = (script: AskScript | undefined, found: ThreadRow[]): Block[] =>
  script?.blocks ?? fallbackBlocks(found);

export const askCitations = (
  script: AskScript | undefined,
  found: ThreadRow[],
  cite: (t: ThreadRow, n: number) => Citation,
): Citation[] => script?.citations ?? found.map((t, i) => cite(t, i + 1));

/** A reply draft for a reply-shaped question, unless the script replaced the proposals. */
export function askProposals(
  script: AskScript | undefined,
  target: ThreadRow | undefined,
  turnId: string,
  question: string,
): Proposal[] {
  if (script?.proposals) return script.proposals;
  if (!target || !/\b(reply|answer|respond|write back)\b/i.test(question)) return [];
  return [
    {
      kind: 'reply',
      id: `${turnId}-p1`,
      consequence: 'Creates a draft reply. Nothing is sent.',
      state: 'open',
      draft: {
        accountId: target.accountId,
        mode: 'reply',
        threadId: target.id,
        to: target.participants
          .filter(p => !p.me && p.address)
          .map(p => clean({ address: p.address!, name: p.name })),
        subject: `Re: ${target.subject}`,
        html: `<p>Hi ${target.fromName.split(' ')[0]},</p><p>Thanks for this. I will get back to you shortly.</p>`,
      },
    },
  ];
}

export interface AskTimelineOptions {
  failAt: AskScript['failAt'];
  found: ThreadRow[];
  blocks: Block[];
  citations: Citation[];
  proposals: Proposal[];
  noSource: boolean;
  step: { id: string; text: string };
  progress: (frame: Record<string, unknown>) => void;
  fails: (stepState: 'running' | 'done', shown: Block[]) => () => void;
  finish: (patch: Partial<AskTurn>) => void;
}

/** The fake provider's frame schedule: search step, paragraphs with their chips, cards, then done. */
export function askTimeline(o: AskTimelineOptions): [number, () => void][] {
  const timeline: [number, () => void][] = [
    [100, () => o.progress({ kind: 'step', step: { ...o.step, state: 'running' } })],
  ];
  if (o.failAt === 'step') {
    timeline.push([400, o.fails('running', [])]);
    return timeline;
  }
  timeline.push([
    400,
    () => o.progress({ kind: 'step', step: { ...o.step, state: 'done', count: o.found.length } }),
  ]);
  // Each paragraph streams, then its chips at their offsets in the text streamed so far.
  let streamed = 0;
  o.blocks.forEach((b, i) => {
    const sep = i ? '\n\n' : '';
    const base = streamed + sep.length;
    streamed = base + b.text.length;
    timeline.push([
      550 + 150 * i,
      () => {
        o.progress({ kind: 'text', delta: `${sep}${b.text}` });
        for (const c of b.cites ?? []) {
          const citation = o.citations.find(x => x.n === c.n);
          if (citation) o.progress({ kind: 'citation', citation, at: base + c.at });
        }
      },
    ]);
    if (o.failAt === 'text' && i === 0) timeline.push([560, o.fails('done', [b])]);
  });
  const end = 550 + 150 * o.blocks.length;
  const placed = new Set(o.blocks.flatMap(b => (b.cites ?? []).map(c => c.n)));
  timeline.push(
    [
      end,
      () => {
        // Chips and cards appear as each becomes known, before the turn is stored.
        for (const citation of o.citations)
          if (!placed.has(citation.n)) o.progress({ kind: 'citation', citation });
        for (const proposal of o.proposals) o.progress({ kind: 'proposal', proposal });
      },
    ],
    [
      end + 100,
      () =>
        o.finish({
          answer: { blocks: o.blocks },
          citations: o.citations,
          noSource: o.noSource,
          proposals: o.proposals,
          steps: [{ ...o.step, state: 'done', count: o.found.length }],
        }),
    ],
  );
  return timeline;
}
