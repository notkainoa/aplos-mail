// Held-out set: AI prompt attempts must not read, edit or be scored against this file; it only guards against overfitting to the dev cases.
import type { AskCase } from './ask-cases';

export const askHeldOutCases: AskCase[] = [
  { id: 'ask-week-plans', message: 'What plans do I have this week?' },
  {
    id: 'ask-triage-done',
    message: 'Move the Trail Journal newsletter and the Field Notes digest to Done',
  },
];
