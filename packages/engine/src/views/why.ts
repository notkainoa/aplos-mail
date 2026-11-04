import type { Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { StoreReader } from '../store';
import { contractId, threadByContractId, type ThreadDbRow } from './rows';

/*
 * `Thread/why` (views-3, DESIGN section 9 rule 4): one plain sentence, a quote from the mail and who placed the thread
 * in its lane. The quote is the newest incoming message's first sentence, from its stored snippet (bodies stay out of
 * the row path); the sentence is copy the engine owns, chosen by who ranked the thread.
 */

type Why = Output<'Thread/why'>;

const LANE_NAMES: Record<string, string> = {
  do: 'Do now',
  update: 'Important updates',
  low: 'Low importance',
};

const QUOTE_MAX = 300;

function sender(t: ThreadDbRow): string {
  try {
    const first = (JSON.parse(t.participants ?? '[]') as { name?: string; address?: string }[])[0];
    return first?.name || first?.address || 'The sender';
  } catch {
    return 'The sender';
  }
}

function sentenceOf(t: ThreadDbRow): string {
  const lane = LANE_NAMES[t.lane] ?? t.lane;
  const who = sender(t);
  if (t.rank_source === 'user') return `You moved this to ${lane}.`;
  if (t.rank_source === 'rule') return `Your rule for ${who} puts their mail in ${lane}.`;
  if (t.lane === 'do') {
    if (!t.todo) return `${who} wrote something that looks like it needs your reply.`;
    return `${who} asked you something: ${t.todo.charAt(0).toLowerCase()}${t.todo.slice(1)}.`;
  }
  if (t.lane === 'low') return `${who} sends notices and newsletters that rarely need you.`;
  return `An update from ${who} worth knowing about, with nothing for you to do.`;
}

/** The first sentence of a snippet, trimmed and short enough to quote. */
function firstSentence(snippet: string | null): string | undefined {
  const sentence = (snippet ?? '')
    .trim()
    .split(/(?<=[.?!])\s/)[0]
    ?.trim();
  return sentence ? sentence.slice(0, QUOTE_MAX) : undefined;
}

export function readWhy(q: StoreReader, threadId: string): Why {
  const t = threadByContractId(q, threadId);
  if (!t)
    throw new ContractError({
      type: 'notFound',
      message: 'This conversation is no longer available.',
    });
  const m = q.get<{ remote_id: string; snippet: string | null }>(
    'SELECT remote_id, snippet FROM messages WHERE thread_id = ? AND (flags & 24) = 0 ORDER BY internal_date DESC, id DESC LIMIT 1',
    t.rowid,
  );
  const quote = firstSentence(m?.snippet ?? null);
  return {
    threadId: contractId(t),
    sentence: sentenceOf(t),
    ...(quote && m ? { quote, messageId: `${t.account_id}:${m.remote_id}` } : {}),
    lane: t.lane,
    rankSource: t.rank_source,
  };
}
