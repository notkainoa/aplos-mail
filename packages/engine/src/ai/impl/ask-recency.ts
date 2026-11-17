import { FLAG } from '../../store/commit';
import type { StoreReader } from '../../store/port';

/**
 * Recency in Ask: a question like "what are my three most recent emails about?" names no topic, so keyword
 * retrieval finds whatever happens to share its filler words and misses the mail that just arrived. Such a
 * question is answered from the newest mail instead, and every recency question lists its sources newest first.
 */

const RECENT =
  /\b(recent(ly)?|latest|newest|last|today|tonight|yesterday|this (morning|afternoon|evening|week)|just (got|sent|received|came|arrived))\b/i;

/** Words that say nothing about a topic: question filler, counts, mail nouns and the recency words themselves. */
const FILLER = new Set(
  `what whats which who whom whose when where why how are was were is be been the this that these those there
   and but for from with about into onto any all some most more much many few last latest newest recent recently
   today tonight yesterday morning afternoon evening week just got sent received came arrived new have has had
   did does doing can could would should will shall may might tell show give list summarize summarise summary
   recap say says said one two three four five six seven eight nine ten top first couple handful
   email emails mail mails message messages inbox account accounts thread threads conversation conversations
   letter letters note notes get gotten i me my mine our ours you your yours they them their its it`
    .split(/\s+/)
    .filter(Boolean),
);

/** Does the question ask about the newest mail ("most recent", "latest", "today", "just got")? */
export function isRecencyQuestion(question: string): boolean {
  return RECENT.test(question);
}

/** The question's topic words: what is left once filler, counts and mail nouns are dropped. */
export function topicWords(question: string): string[] {
  const words = question.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [];
  return [...new Set(words.map(w => w.replace(/'s$/, '')))].filter(w => !FILLER.has(w));
}

/** A recency question with no topic: the newest mail answers it, not a keyword search. */
export function wantsNewest(question: string): boolean {
  return isRecencyQuestion(question) && topicWords(question).length === 0;
}

export interface SourceRow {
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

/** The newest delivered or sent messages in the allowed accounts: no drafts, nothing in Spam or Trash. */
export function newestMessages(
  q: StoreReader,
  allowed: readonly string[],
  limit: number,
): SourceRow[] {
  if (!allowed.length) return [];
  return q.all<SourceRow>(
    `SELECT m.id, m.remote_id, m.account_id, m.thread_id, m.subject, m.from_name, m.from_addr, m.internal_date, m.snippet, t.remote_id AS remote_thread
     FROM messages m JOIN threads t ON t.id = m.thread_id
     WHERE m.account_id IN (${allowed.map(() => '?').join(',')})
       AND (m.flags & ${FLAG.draft}) = 0
       AND NOT EXISTS (SELECT 1 FROM thread_folders tf JOIN folders fo ON fo.id = tf.folder_id
                       WHERE tf.thread_id = m.thread_id AND fo.role IN ('trash','spam'))
     ORDER BY m.internal_date DESC, m.id DESC LIMIT ?`,
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
