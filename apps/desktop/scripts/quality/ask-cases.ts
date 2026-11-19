/** A live Ask check: the question plus any extra ai.ask payload fields it needs. */
export interface AskCase {
  id: string;
  message: string;
  extra?: Record<string, unknown>;
}

export const askDevCases: AskCase[] = [
  {
    id: 'ask-summarize-open',
    message: 'Summarize this',
    extra: { context: { view: 'home', threadId: 'garden' } },
  },
  { id: 'ask-invoice-facts', message: 'What does the invoice from Drew need from me?' },
  { id: 'ask-book-lunch', message: 'Book lunch with Maya Friday at noon' },
];
