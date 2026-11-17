// Scripted questions and answers for the Ask demo, from the app's original demo data. Nothing here is real.

export type Proposal = { title: string; when: string; calendar: string };
export type Answer = { text: string; sources?: string[]; proposal?: Proposal };

export const questions: [string, Answer][] = [
  [
    'What plans do I have this week?',
    {
      text: 'Besides the 9 AM standups: design critique Monday at 1, dinner with Sam Tuesday at 7, a welcome lunch Wednesday at noon, yoga Thursday at 6 and team retro Friday at 10. The cabin weekend starts Friday.',
      sources: ['Design critique', 'Dinner with Sam', 'Cabin weekend'],
    },
  ],
  [
    'Which emails still need a reply?',
    {
      text: 'Three are waiting on you. Jordan Park wants your pick of two layout directions by tomorrow. Rowan Pottery is holding a seat in the Tuesday evening class. Drew’s October invoice is overdue for approval.',
      sources: ['Jordan Park', 'Rowan Pottery', 'Drew'],
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
