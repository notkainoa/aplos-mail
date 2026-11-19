import { FLAG } from '../../store/commit';
import type { StoreReader } from '../../store/port';

/**
 * Recency in Ask: a question like "what are my three most recent emails about?" names no topic, so keyword
 * retrieval finds whatever happens to share its filler words and misses the mail that just arrived. Such a
 * question is answered from the newest mail instead, and every recency question lists its sources newest first.
 */

const RECENT =
  /\b(recent(ly)?|latest|newest|last (\d+|few|couple|one|two|three|four|five|six|seven|eight|nine|ten|e-?mails?|mails?|messages?|threads?|things?|night|week)|today|tonight|yesterday|this (morning|afternoon|evening|week)|just (got|sent|received|came|arrived))\b/i;

/** Words that say nothing about a topic: question filler, counts, mail nouns and the recency words themselves. */
const FILLER = new Set(
  `what whats which who whom whose when where why how are was were is be been the this that these those there
   and but for from with about into onto any all some most more much many few last latest newest recent recently
   today tonight yesterday morning afternoon evening week just got sent received came arrived new have has had
   did does doing can could would should will shall may might tell show give list summarize summarise summary
   recap say says said one two three four five six seven eight nine ten top first couple handful
   email emails mail mails message messages inbox account accounts thread threads conversation conversations
   letter letters note notes get gotten i me my mine our ours you your yours they them their its it
   anything something everything nothing going happening happened up in on of to at by an as or if so do
   we us is be no go new news important`
    .split(/\s+/)
    .filter(Boolean),
);

/** A stored date as ISO text, or `undefined` when it is outside what a JS Date holds (the store only checks it is finite). */
export function isoDate(ms: number | undefined): string | undefined {
  const d = new Date(ms ?? Number.NaN);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Does the question ask about the newest mail ("most recent", "latest", "today", "just got")? */
export function isRecencyQuestion(question: string): boolean {
  return RECENT.test(question);
}

/** The question's topic words: what is left once filler, counts and mail nouns are dropped. */
export function topicWords(question: string): string[] {
  // Two letters can be a topic ("HR", "Q3"); the filler list holds the short words that never are.
  const words = question.toLowerCase().match(/[\p{L}\p{N}']{2,}/gu) ?? [];
  return [...new Set(words.map(w => w.replace(/'s$/, '')))].filter(w => !FILLER.has(w));
}

/** A recency question with no topic: the newest mail answers it, not a keyword search. */
export function wantsNewest(question: string): boolean {
  return isRecencyQuestion(question) && topicWords(question).length === 0;
}

export interface SourceRow {
  [k: string]: string | number | null;
  id: number;
  remote_id: string;
  account_id: string;
  thread_id: number;
  subject: string | null;
  from_name: string | null;
  from_addr: string | null;
  internal_date: number;
  snippet: string | null;
  remote_thread: string;
}

/**
 * The newest delivered or sent mail in the allowed accounts, one message per thread (its newest), so a busy
 * conversation does not fill every source: no drafts, nothing in Spam or Trash.
 */
export function newestMessages(
  q: StoreReader,
  allowed: readonly string[],
  limit: number,
): SourceRow[] {
  if (!allowed.length) return [];
  return q.all<SourceRow>(
    // SQLite fills the bare columns of a MAX() group from the row that holds the max: each thread's newest message.
    `SELECT m.id, m.remote_id, m.account_id, m.thread_id, m.subject, m.from_name, m.from_addr, MAX(m.internal_date) AS internal_date, m.snippet, t.remote_id AS remote_thread
     FROM messages m JOIN threads t ON t.id = m.thread_id
     WHERE m.account_id IN (${allowed.map(() => '?').join(',')})
       AND (m.flags & ${FLAG.draft}) = 0
       AND NOT EXISTS (SELECT 1 FROM thread_folders tf JOIN folders fo ON fo.id = tf.folder_id
                       WHERE tf.thread_id = m.thread_id AND fo.role IN ('trash','spam'))
     GROUP BY m.thread_id
     ORDER BY internal_date DESC, m.id DESC LIMIT ?`,
    ...allowed,
    limit,
  );
}

/** Sources newest first, renumbered 1..n in that order, after the `keep` leading ones (the open thread, the selection). */
export function newestFirst<S extends { n: number; date?: number }>(
  sources: S[],
  keep: number,
): S[] {
  const lead = sources.slice(0, keep);
  const rest = sources.slice(keep).sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  return [...lead, ...rest].map((s, i) => ({ ...s, n: i + 1 }));
}
