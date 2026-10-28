import type { State, ThreadSelector } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { StoreReader } from '../store';
import { splitId } from './compile';
import { compileView } from './registry';
import type { ViewEnv } from './specs';

/*
 * A `ThreadSelector` (views-3): a whole view or one section of it as the target of `Thread/act`, beyond the 200-row
 * window. It is resolved at the state the owner saw: threads whose first message arrived after `atState` are left out,
 * so "mark all" never sweeps up mail the owner has not seen.
 */

/** Most threads one selector may name; a bigger one is refused rather than held in one commit. */
export const SELECTOR_LIMIT = 20_000;
const STRIDE = 1_000;

const stateMismatch = () =>
  new ContractError({
    type: 'stateMismatch',
    message: 'This list changed while you were looking at it. Look again, then try once more.',
  });

/** Home's Low band has no rows of its own; its section is the `homeSection` view. */
function specOf({ spec, section }: ThreadSelector): ThreadSelector['spec'] {
  if (spec.kind === 'home' && section === 'low')
    return { kind: 'homeSection', section: 'low', accountId: spec.accountId };
  return spec;
}

/** The index range of the selected rows in the whole view. */
function rangeOf(
  total: number,
  sections: { key: string; start: number; count: number }[],
  key: string | undefined,
): [from: number, to: number] {
  if (key === undefined) return [0, total];
  const found = sections.find(s => s.key === key);
  if (!found) throw new ContractError({ type: 'notFound', message: 'This section is empty now.' });
  return [found.start, found.start + found.count];
}

function bornAfter(q: StoreReader, id: string, seq: number, accounts: string[]): boolean {
  const parts = splitId(q, id, accounts);
  if (!parts) return true;
  const first = q.get<{ s: number | null }>(
    `SELECT min(m.first_seen_seq) AS s FROM messages m
     WHERE m.thread_id = (SELECT id FROM threads WHERE account_id = ? AND remote_id = ?)`,
    parts.accountId,
    parts.remoteId,
  );
  return (first?.s ?? 0) > seq;
}

export function resolveSelector(
  q: StoreReader,
  selector: ThreadSelector,
  env: ViewEnv,
  now: State,
): string[] {
  const { atState, section } = selector;
  if (atState.dbEpoch !== now.dbEpoch || atState.seq > now.seq) throw stateMismatch();
  const plan = compileView(specOf(selector), env);
  if (plan.rowType !== 'Thread')
    throw new ContractError({
      type: 'unsupported',
      message: 'Only a list of conversations can be acted on as a whole.',
    });
  const layout = plan.layout(q);
  const [from, to] = rangeOf(layout.total, layout.sections, section);
  if (to - from > SELECTOR_LIMIT)
    throw new ContractError({
      type: 'tooLarge',
      message: 'That is too many conversations at once. Choose a smaller part of the list.',
    });
  const ids: string[] = [];
  let index = 0;
  let after;
  while (index < to) {
    const rows = plan.rows(q, after, STRIDE);
    if (!rows.length) break;
    for (const row of rows) {
      if (index >= from && index < to) ids.push(row.id);
      index++;
    }
    after = rows[rows.length - 1].at;
  }
  const accounts = q.all<{ id: string }>('SELECT id FROM accounts').map(a => a.id);
  return ids.filter(id => !bornAfter(q, id, atState.seq, accounts));
}
