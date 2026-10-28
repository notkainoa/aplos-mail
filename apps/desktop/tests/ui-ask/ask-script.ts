// Twenty scripted Ask answers (plan 30 U7 acceptance 4): cited, no-source, multi-step, proposals of each kind,
// stopped, provider errors, no provider, event sources, non-Latin, emoji offsets, long streams. Original demo data:
// invented people on example domains.
import type { AskTurn, Citation, ProgressFrame, Proposal } from '../../src/renderer/data';

export const NOW = new Date(2026, 9, 29, 10, 0).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();

let seq = 0;
export function frame(
  runId: string,
  kind: ProgressFrame['kind'],
  extra: Partial<ProgressFrame> = {},
): ProgressFrame {
  seq += 1;
  return {
    frame: 'progress',
    dbEpoch: 'demo',
    seq,
    runId,
    source: 'ask',
    kind,
    ...extra,
  } as ProgressFrame;
}

export function message(
  n: number,
  fromName: string,
  subject: string,
  quote: string,
  day = 27,
): Citation {
  return {
    kind: 'message',
    n,
    messageId: `m${n}-${subject.length}`,
    threadId: `t-${subject.toLowerCase().replace(/\W+/g, '-')}`,
    quote,
    fromName,
    date: at(day, 9, 12),
    subject,
  };
}

export interface Script {
  readonly name: string;
  readonly question: string;
  /** Frames after `Ask/run` returned (runId 'r'). */
  readonly frames: (runId: string, turnId: string) => ProgressFrame[];
  /** What the engine stores at the end; absent when nothing is stored (no provider). */
  readonly stored?: (turnId: string) => AskTurn;
  /** The test stops the run after this many frames. */
  readonly stopAfter?: number;
  /** The run ends in an error the dock shows as a failed turn, or as "no provider". */
  readonly ends: 'answer' | 'failed' | 'noProvider' | 'stopped';
}

const steps3 = (runId: string, turnId: string) => [
  frame(runId, 'step', {
    turnId,
    step: { id: 's1', text: 'Searching mail for “design review”', state: 'running' },
  }),
  frame(runId, 'step', {
    turnId,
    step: { id: 's1', text: 'Searched mail for “design review”', state: 'done' },
  }),
  frame(runId, 'step', {
    turnId,
    step: { id: 's2', text: 'Reading 14 emails from Jordan', state: 'running', count: 14 },
  }),
  frame(runId, 'step', {
    turnId,
    step: { id: 's2', text: 'Read 14 emails from Jordan', state: 'done', count: 14 },
  }),
  frame(runId, 'step', {
    turnId,
    step: { id: 's3', text: 'Checking your calendars', state: 'running' },
  }),
  frame(runId, 'step', {
    turnId,
    step: { id: 's3', text: 'Checked your Work and Hollow Creek calendars', state: 'done' },
  }),
];
const doneSteps = [
  { id: 's1', text: 'Searched mail for “design review”', state: 'done' },
  { id: 's2', text: 'Read 14 emails from Jordan', state: 'done', count: 14 },
  { id: 's3', text: 'Checked your Work and Hollow Creek calendars', state: 'done' },
];

function stream(runId: string, turnId: string, text: string, pieces = 6): ProgressFrame[] {
  const out: ProgressFrame[] = [];
  const size = Math.max(1, Math.ceil(text.length / pieces));
  for (let i = 0; i < text.length; i += size)
    out.push(frame(runId, 'text', { turnId, delta: text.slice(i, i + size) }));
  return out;
}

function turn(turnId: string, question: string, rest: Partial<AskTurn>): AskTurn {
  return {
    id: turnId,
    question,
    citations: [],
    noSource: true,
    proposals: [],
    steps: [],
    createdAt: NOW,
    model: { provider: 'groq', model: 'demo-model' },
    ...rest,
  };
}

const review = message(
  1,
  'Mina Cho',
  'Hollow Creek review',
  'Let’s hold the design review Thursday from 2:00 to 2:30.',
);
const layout = message(
  2,
  'Jordan Park',
  'Two layout directions',
  'Could you pick a layout by tomorrow?',
  28,
);
const REVIEW_TEXT =
  'Mina’s note puts the design review with you and Jordan at Thursday, 2:00–2:30 PM. Jordan also wants your layout pick by tomorrow.';

const eventProposal: Proposal = {
  kind: 'addEvent',
  id: 'p-event',
  consequence: 'Add to Calendar · Thu 2:00–2:30 PM · Hollow Creek',
  state: 'open',
  calendarId: 'cal-hollow',
  event: {
    title: 'Design review',
    start: { type: 'utc', utc: at(29, 14) },
    end: { type: 'utc', utc: at(29, 14, 30) },
    allDay: false,
  },
};

export const SCRIPTS: readonly Script[] = [
  {
    name: 'cited answer with three steps',
    question: 'When is the Hollow Creek design review?',
    ends: 'answer',
    frames: (r, t) => [
      ...steps3(r, t),
      ...stream(r, t, REVIEW_TEXT),
      frame(r, 'citation', { turnId: t, citation: review, at: 82 }),
      frame(r, 'citation', { turnId: t, citation: layout, at: REVIEW_TEXT.length }),
      frame(r, 'done', { turnId: t }),
    ],
    stored: t =>
      turn(t, 'When is the Hollow Creek design review?', {
        answer: {
          blocks: [
            {
              text: REVIEW_TEXT,
              strong: [{ start: 62, end: 81 }],
              cites: [
                { at: 82, n: 1 },
                { at: REVIEW_TEXT.length, n: 2 },
              ],
            },
          ],
        },
        citations: [review, layout],
        noSource: false,
        steps: doneSteps,
      }),
  },
  {
    name: 'no source',
    question: 'How do I write a polite follow-up?',
    ends: 'answer',
    frames: (r, t) => [
      ...stream(r, t, 'Thank them, restate the ask in one line, and give a date.'),
      frame(r, 'done', { turnId: t }),
    ],
    stored: t =>
      turn(t, 'How do I write a polite follow-up?', {
        answer: { blocks: [{ text: 'Thank them, restate the ask in one line, and give a date.' }] },
      }),
  },
  {
    name: 'event proposal',
    question: 'Put the design review on my calendar',
    ends: 'answer',
    frames: (r, t) => [
      ...steps3(r, t),
      ...stream(r, t, 'The review is Thursday, 2:00–2:30 PM.'),
      frame(r, 'citation', { turnId: t, citation: review }),
      frame(r, 'proposal', { turnId: t, proposal: eventProposal }),
      frame(r, 'done', { turnId: t }),
    ],
    stored: t =>
      turn(t, 'Put the design review on my calendar', {
        answer: {
          blocks: [{ text: 'The review is Thursday, 2:00–2:30 PM.', cites: [{ at: 37, n: 1 }] }],
        },
        citations: [review],
        noSource: false,
        proposals: [eventProposal],
        steps: doneSteps,
      }),
  },
  {
    name: 'reply proposal',
    question: 'Reply to Jordan with my pick',
    ends: 'answer',
    frames: (r, t) => {
      const proposal: Proposal = {
        kind: 'reply',
        id: 'p-reply',
        consequence: 'Opens a reply to Jordan Park',
        state: 'open',
        draft: { subject: 'Re: Two layout directions' },
      };
      return [
        ...stream(r, t, 'I drafted a reply picking the quieter layout.'),
        frame(r, 'citation', { turnId: t, citation: layout }),
        frame(r, 'proposal', { turnId: t, proposal }),
        frame(r, 'done', { turnId: t }),
      ];
    },
  },
  {
    name: 'triage proposal',
    question: 'Clear the shipping updates',
    ends: 'answer',
    frames: (r, t) => {
      const proposal: Proposal = {
        kind: 'triage',
        id: 'p-triage',
        consequence: 'Marks 3 shipping updates Done',
        state: 'open',
        threadIds: ['t-a', 't-b', 't-c'],
        action: { type: 'done' },
      };
      const parcel = message(
        1,
        'Parcel Trail',
        'Delivered',
        'Your package was delivered at 9:12 AM.',
      );
      return [
        ...stream(r, t, 'Three shipping updates are delivered.'),
        frame(r, 'citation', { turnId: t, citation: parcel }),
        frame(r, 'proposal', { turnId: t, proposal }),
        frame(r, 'done', { turnId: t }),
      ];
    },
  },
  {
    name: 'stopped mid-stream',
    question: 'Summarize this week’s mail from Jordan',
    ends: 'stopped',
    stopAfter: 9,
    frames: (r, t) => [
      ...steps3(r, t),
      ...stream(
        r,
        t,
        'Jordan sent two layout directions and asked for a pick by tomorrow. He also shared the sitemap.',
        8,
      ),
      frame(r, 'citation', { turnId: t, citation: layout }),
      frame(r, 'proposal', { turnId: t, proposal: eventProposal }),
      frame(r, 'done', { turnId: t }),
    ],
  },
  {
    name: 'provider error before text',
    question: 'What did I miss this week?',
    ends: 'failed',
    frames: (r, t) => [
      frame(r, 'step', {
        turnId: t,
        step: { id: 's1', text: 'Searching this week’s mail', state: 'running' },
      }),
      frame(r, 'error', { turnId: t, problem: { reasonCode: 'ai.unreachable' } }),
    ],
  },
  {
    name: 'provider error mid-stream',
    question: 'Who is waiting on me?',
    ends: 'failed',
    frames: (r, t) => [
      ...stream(r, t, 'Priya is waiting on'),
      frame(r, 'error', { turnId: t, problem: { reasonCode: 'ai.failed' } }),
    ],
  },
  {
    name: 'no provider',
    question: 'When am I free tomorrow afternoon?',
    ends: 'noProvider',
    frames: (r, t) => [frame(r, 'error', { turnId: t, problem: { reasonCode: 'ai.noProvider' } })],
  },
  {
    name: 'daily limit',
    question: 'What needs a reply from me today?',
    ends: 'failed',
    frames: (r, t) => [frame(r, 'error', { turnId: t, problem: { reasonCode: 'ai.dailyCap' } })],
  },
  {
    name: 'two paragraphs, chips at paragraph ends',
    question: 'What are Jordan and Mina asking for?',
    ends: 'answer',
    frames: (r, t) => {
      const text =
        'Jordan wants your layout pick by tomorrow.\n\nMina wants the review on Thursday.';
      return [
        ...stream(r, t, text, 9),
        frame(r, 'citation', { turnId: t, citation: layout, at: 42 }),
        frame(r, 'citation', { turnId: t, citation: review, at: text.length }),
        frame(r, 'done', { turnId: t }),
      ];
    },
  },
  {
    name: 'calendar source',
    question: 'Am I busy Thursday at 2?',
    ends: 'answer',
    frames: (r, t) => {
      const event: Citation = {
        kind: 'event',
        n: 1,
        eventId: 'e-review',
        title: 'Design review',
        start: { type: 'utc', utc: at(29, 14) },
      };
      return [
        ...stream(r, t, 'Yes, the design review is at 2:00 PM.'),
        frame(r, 'citation', { turnId: t, citation: event }),
        frame(r, 'done', { turnId: t }),
      ];
    },
  },
  {
    name: 'chips at the start and the end',
    question: 'Quote Mina',
    ends: 'answer',
    frames: (r, t) => [
      frame(r, 'citation', { turnId: t, citation: review, at: 0 }),
      ...stream(r, t, 'She wrote that Thursday works.'),
      frame(r, 'citation', { turnId: t, citation: layout, at: 999 }),
      frame(r, 'done', { turnId: t }),
    ],
  },
  {
    name: 'non-Latin answer',
    question: '来週のハイキングの予定は？',
    ends: 'answer',
    frames: (r, t) => {
      const cite = message(
        1,
        '山田 花子',
        '週末のハイキング',
        '土曜日の朝8時に駅で集合しましょう。',
      );
      return [
        ...stream(r, t, '土曜日の朝8時に駅で集合です。'),
        frame(r, 'citation', { turnId: t, citation: cite, at: 14 }),
        frame(r, 'done', { turnId: t }),
      ];
    },
  },
  {
    name: 'emoji offsets',
    question: 'What did Theo say about climbing?',
    ends: 'answer',
    frames: (r, t) => {
      const cite = message(1, 'Theo Lin', 'Climbing 🧗 Friday', 'See you at the wall 🧗 at 6.');
      // Offset 5 falls inside the surrogate pair of the emoji; the chip moves after it, never splits it.
      return [
        ...stream(r, t, 'Wall 🧗 at 6 on Friday.', 3),
        frame(r, 'citation', { turnId: t, citation: cite, at: 6 }),
        frame(r, 'done', { turnId: t }),
      ];
    },
  },
  {
    name: 'several emphasised ranges',
    question: 'When are the two deadlines?',
    ends: 'answer',
    frames: (r, t) => [
      ...stream(r, t, 'Layout by Friday; budget by Monday.'),
      frame(r, 'citation', { turnId: t, citation: layout }),
      frame(r, 'done', { turnId: t }),
    ],
    stored: t =>
      turn(t, 'When are the two deadlines?', {
        answer: {
          blocks: [
            {
              text: 'Layout by Friday; budget by Monday.',
              strong: [
                { start: 10, end: 16 },
                { start: 28, end: 34 },
              ],
              cites: [{ at: 35, n: 1 }],
            },
          ],
        },
        citations: [layout],
        noSource: false,
      }),
  },
  {
    name: 'chip for a source that never came',
    question: 'Who sent the sitemap?',
    ends: 'answer',
    frames: (r, t) => [
      ...stream(r, t, 'Jordan sent it.'),
      frame(r, 'citation', { turnId: t, citation: layout }),
      frame(r, 'done', { turnId: t }),
    ],
    stored: t =>
      turn(t, 'Who sent the sitemap?', {
        answer: {
          blocks: [
            {
              text: 'Jordan sent it.',
              cites: [
                { at: 6, n: 2 },
                { at: 15, n: 7 },
              ],
            },
          ],
        },
        citations: [layout],
        noSource: false,
      }),
  },
  {
    name: 'long stream',
    question: 'Summarize everything from Hollow Creek',
    ends: 'answer',
    frames: (r, t) => [
      ...steps3(r, t),
      ...stream(r, t, 'The Hollow Creek board passed the trail budget. '.repeat(30), 600),
      frame(r, 'citation', { turnId: t, citation: review }),
      frame(r, 'done', { turnId: t }),
    ],
  },
  {
    name: 'an account left out',
    question: 'Any invoices this week?',
    ends: 'answer',
    frames: (r, t) => {
      const invoice = message(
        1,
        'Drew Bell',
        'Invoice #0412',
        'Approve the $1,840 invoice to close October.',
      );
      return [
        ...stream(r, t, 'Drew Bell’s October invoice is waiting for approval.'),
        frame(r, 'citation', { turnId: t, citation: invoice }),
        frame(r, 'done', { turnId: t }),
      ];
    },
    stored: t =>
      turn(t, 'Any invoices this week?', {
        answer: {
          blocks: [
            {
              text: 'Drew Bell’s October invoice is waiting for approval.',
              cites: [{ at: 52, n: 1 }],
            },
          ],
        },
        citations: [
          message(1, 'Drew Bell', 'Invoice #0412', 'Approve the $1,840 invoice to close October.'),
        ],
        noSource: false,
        excludedAccountIds: ['acc-work'],
      }),
  },
  {
    name: 'no source after reading',
    question: 'Did anyone mention the dentist?',
    ends: 'answer',
    frames: (r, t) => [
      frame(r, 'step', {
        turnId: t,
        step: { id: 's1', text: 'Searching mail for “dentist”', state: 'running' },
      }),
      frame(r, 'step', {
        turnId: t,
        step: { id: 's1', text: 'Searched mail for “dentist”', state: 'done', count: 0 },
      }),
      ...stream(r, t, 'Nothing in your mail mentions a dentist.'),
      frame(r, 'done', { turnId: t }),
    ],
  },
];
