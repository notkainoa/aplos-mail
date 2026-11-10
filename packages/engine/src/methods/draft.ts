import type { Input, Output } from '@aplos/contract';
import { requireScope } from '@aplos/contract/access';
import { assertOwnedAttachments } from '../outbox/draft-owner';
import { type AreaHandlers, type EngineServices } from './types';
// Brings in the `EngineServices.draftBox` declaration.
import type {} from '../outbox/module';

interface CorrRow {
  [k: string]: string | number | null;
  address: string;
  name: string | null;
  sent: number;
  received: number;
  last: number | null;
}

/** LIKE-escape for the address-prefix pre-filter; the name-word rule is applied in JS below. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

const wordMatch = (name: string | null, query: string) =>
  (name ?? '')
    .toLowerCase()
    .split(/\s+/)
    .some(w => w.startsWith(query));

/**
 * `Contact/suggest` (the `correspondents` table, ARCH 3.2): who the owner wrote to and heard from. Rows are read
 * per account and folded together in JS, so a shared address keeps every account's counts and every name it was
 * seen under — the query matches the start of the address or of any word of any of those names (SQLite `LIKE`
 * does not fold non-ASCII case, so names are matched here, not in SQL). Addresses of any connected account are
 * never suggested back to the owner. Ranking: `sent_to * 2 + received_from`, then most recent sent mail, then
 * the address. Read-only, no network, no AI.
 */
export function suggest(
  args: Input<'Contact/suggest'>,
  services: EngineServices,
): Output<'Contact/suggest'> {
  const query = args.query.trim().toLowerCase();
  const like = `${likeEscape(query)}%`;
  const rows = services.store.read(q =>
    args.accountId
      ? q.all<CorrRow>(
          `SELECT address, name, sent_to AS sent, received_from AS received, last_sent_at AS last
           FROM correspondents WHERE account_id = ? AND (address LIKE ? ESCAPE '\\' OR name IS NOT NULL)
             AND address NOT IN (SELECT lower(address) FROM accounts)`,
          args.accountId,
          like,
        )
      : q.all<CorrRow>(
          `SELECT address, name, sent_to AS sent, received_from AS received, last_sent_at AS last
           FROM correspondents WHERE (address LIKE ? ESCAPE '\\' OR name IS NOT NULL)
             AND address NOT IN (SELECT lower(address) FROM accounts)`,
          like,
        ),
  );
  const byAddr = new Map<
    string,
    { sent: number; received: number; last: number; names: string[] }
  >();
  for (const r of rows) {
    const a = byAddr.get(r.address) ?? { sent: 0, received: 0, last: 0, names: [] };
    a.sent += r.sent;
    a.received += r.received;
    a.last = Math.max(a.last, r.last ?? 0);
    if (r.name) a.names.push(r.name);
    byAddr.set(r.address, a);
  }
  const matches = (address: string, names: string[]) =>
    !query || address.startsWith(query) || names.some(n => wordMatch(n, query));
  return {
    list: [...byAddr]
      .filter(([address, a]) => matches(address, a.names))
      .sort(
        ([aa, a], [bb, b]) =>
          b.sent * 2 + b.received - (a.sent * 2 + a.received) ||
          b.last - a.last ||
          aa.localeCompare(bb),
      )
      .slice(0, args.limit ?? 8)
      .map(([address, a]) => ({
        address,
        ...(a.names.length ? { name: a.names.find(n => wordMatch(n, query)) ?? a.names[0] } : {}),
        sentTo: a.sent,
        receivedFrom: a.received,
      })),
  };
}

/**
 * The `draft` area, owned by lane `eng-time`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'draft'> = {
  'Draft/get': (args, { services }) => services.draftBox.get(args.ids),
  'Draft/set': (args, { services, caller }) => {
    // The ownership check and the commit share this turn: nothing awaits between them.
    assertOwnedAttachments(services, caller, args.opId, args.id, args.fields.attachments);
    return services.draftBox.set(args.opId, {
      ...(args.id !== undefined ? { id: args.id } : {}),
      ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}),
      fields: args.fields,
    });
  },
  // Discarding a draft with a live send cancels that send, so it needs `send` as well (scopeRule 'originating').
  'Draft/destroy': (args, { services, caller }) =>
    services.draftBox.destroy(args.opId, args.id, () => requireScope(caller, 'send')),
  'Contact/suggest': (args, { services }) => suggest(args, services),
  'Draft/resolve': (args, { services }) =>
    services.draftBox.resolve(args.opId, args.id, args.choice),
};
