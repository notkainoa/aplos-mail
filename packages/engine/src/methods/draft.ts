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

/** LIKE-escape for the prefix pre-filter; the exact name-word rule is applied in JS below. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

/**
 * `Contact/suggest` (the `correspondents` table, ARCH 3.2): who the owner wrote to and heard from. With an
 * `accountId` only that account's rows count; without one the counts sum per address across accounts (R2G-3).
 * Ranking is by how much — `sent_to * 2 + received_from`, then the most recent sent mail, then the address —
 * matching the start of the address or of any word in the name. Read-only, no network, no AI.
 */
export function suggest(
  args: Input<'Contact/suggest'>,
  services: EngineServices,
): Output<'Contact/suggest'> {
  const query = args.query.trim().toLowerCase();
  const like = `%${likeEscape(query)}%`;
  const rows = services.store.read(q =>
    args.accountId
      ? q.all<CorrRow>(
          `SELECT address, name, sent_to AS sent, received_from AS received, last_sent_at AS last
           FROM correspondents WHERE account_id = ? AND (address LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')`,
          args.accountId,
          like,
          like,
        )
      : q.all<CorrRow>(
          `SELECT address, max(name) AS name, sum(sent_to) AS sent, sum(received_from) AS received,
                  max(last_sent_at) AS last
           FROM correspondents WHERE (address LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\') GROUP BY address`,
          like,
          like,
        ),
  );
  const starts = (r: CorrRow) =>
    !query ||
    r.address.startsWith(query) ||
    (r.name ?? '')
      .toLowerCase()
      .split(/\s+/)
      .some(w => w.startsWith(query));
  return {
    list: rows
      .filter(starts)
      .sort(
        (a, b) =>
          b.sent * 2 + b.received - (a.sent * 2 + a.received) ||
          (b.last ?? 0) - (a.last ?? 0) ||
          a.address.localeCompare(b.address),
      )
      .slice(0, args.limit ?? 8)
      .map(r => ({
        address: r.address,
        ...(r.name ? { name: r.name } : {}),
        sentTo: r.sent,
        receivedFrom: r.received,
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
