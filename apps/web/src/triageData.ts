import type { ActionIcon } from './Icons';

// Original sample mail for the Home demo. Nothing here is real.

export type Lane = 'now' | 'updates';

/** What Space does: open a reply, open the email (links, attachments, plans), or mark it Done. */
export type ActionKind = 'reply' | 'open' | 'done';

export type Mail = {
  sender: string;
  subject: string;
  summary: string;
  due?: string;
  overdue?: boolean;
  when: string;
  lane: Lane;
  action: { verb: string; icon: ActionIcon; kind: ActionKind };
};

const reply = { verb: 'Reply', icon: 'reply', kind: 'reply' } as const;

export const mails: Mail[] = [
  {
    sender: 'Jordan Park',
    subject: 'A quieter home for our project',
    summary: 'Jordan has two layout directions ready and wants your pick by tomorrow.',
    due: 'Tomorrow',
    when: '9:17 PM',
    lane: 'now',
    action: reply,
  },
  {
    sender: 'Leah Moreno',
    subject: 'Lunch for six on Friday',
    summary: 'Leah wants your vote on a quiet lunch spot with vegetarian choices.',
    due: 'Thu',
    when: '6:40 PM',
    lane: 'now',
    action: { verb: 'Open the poll', icon: 'link', kind: 'open' },
  },
  {
    sender: 'Rowan Pottery',
    subject: 'A place opened in the evening class',
    summary: 'A seat opened in the Tuesday evening class; reply to reserve it.',
    when: 'Nov 12',
    lane: 'now',
    action: reply,
  },
  {
    sender: 'Theo Kim',
    subject: 'Friday review: agenda and room',
    summary: 'Theo needs the room for Friday’s review confirmed by tomorrow.',
    due: 'Overdue',
    overdue: true,
    when: 'Nov 11',
    lane: 'now',
    action: reply,
  },
  {
    sender: 'Maple Library',
    subject: 'Your holds are ready to collect',
    summary: 'Two holds wait at the front desk until Sunday.',
    due: 'Sun',
    when: 'Nov 10',
    lane: 'updates',
    action: { verb: 'Done', icon: 'check', kind: 'done' },
  },
];

export const laneLabel: Record<Lane, string> = { now: 'Do now', updates: 'Important updates' };

/** How many emails are left in a lane from `index` on. */
export function leftInLane(index: number, lane: Lane) {
  return mails.slice(index).filter(mail => mail.lane === lane).length;
}
