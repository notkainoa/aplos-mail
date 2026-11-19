import type { Thread } from './types';

const flat = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/(…|\.\.\.)$/, '')
    .trim()
    .toLowerCase();
/** Until Groq summarizes a synced thread, its summary is just the Gmail snippet; that isn't a summary worth showing. */
export function hasRealSummary(thread: Thread) {
  if (!thread.summary?.trim()) return false;
  // Summaries saved before Groq's were marked are judged by whether they just repeat the email's text.
  return (
    !!thread.aiSummary || !thread.messages.some(m => flat(m.text).includes(flat(thread.summary)))
  );
}
