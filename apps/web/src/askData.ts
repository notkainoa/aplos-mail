// Scripted questions and answers for the Ask demo, from the app's original demo data. Nothing here is real.

export type Proposal = { title: string; when: string; calendar: string };
export type Answer = { text: string; sources?: string[]; proposal?: Proposal };

export const questions: [string, Answer][] = [
  [
    'What plans do I have this week?',
    {
      text: 'Monday has standup and lunch with Maya at 12:00. Tuesday is pottery class, and Wednesday has the library holds. Thursday is design critique, and Friday has the review at 11 and cabin planning at 1.',
      sources: ['Lunch with Maya', 'Design critique', 'Friday review', 'Cabin planning'],
    },
  ],
  [
    'Which emails still need a reply?',
    {
      text: 'Three are waiting on you. Jordan Park wants your pick of two layout directions by tomorrow. Rowan Pottery is holding a seat in the Tuesday evening class. Theo Kim needs Friday’s review room confirmed, and that is overdue.',
      sources: ['Jordan Park', 'Rowan Pottery', 'Theo Kim'],
    },
  ],
  [
    'Book lunch with Maya Friday at noon',
    {
      text: 'Here is the event. It goes on your calendar only when you add it.',
      proposal: { title: 'Lunch with Maya', when: 'Friday, 12:00 – 1:00 PM', calendar: 'Personal' },
    },
  ],
];

export const wordCount = (text: string) => text.split(' ').length;
