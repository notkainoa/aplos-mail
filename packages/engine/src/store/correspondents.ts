import type { Address, MessageWrite } from './port';
import type { WriteScope } from './scope';

const SENT = `INSERT INTO correspondents(account_id, address, name, sent_to, last_sent_at) VALUES(?, ?, ?, 1, ?)
  ON CONFLICT(account_id, address) DO UPDATE SET sent_to = sent_to + 1, name = coalesce(name, excluded.name),
    last_sent_at = max(coalesce(last_sent_at, 0), excluded.last_sent_at)`;
const RECEIVED = `INSERT INTO correspondents(account_id, address, name, received_from) VALUES(?, ?, ?, 1)
  ON CONFLICT(account_id, address) DO UPDATE SET received_from = received_from + 1, name = coalesce(excluded.name, name)`;

/** Addresses compare case-insensitively; the stored form is lower case and trimmed. */
export function normalAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Counts one newly stored message into `correspondents` (ARCH 3.2, R2G-3), inside the commit: a message the owner sent
 * adds one `sent_to` per distinct recipient (To, Cc, Bcc), any other message one `received_from` for its sender. Called
 * once per message, on first insert, so a re-sync never counts twice; drafts and the account's own address never
 * count, and a message for an account the store does not hold is skipped (the row would have no owner). The name a
 * sender gives in From wins over the one the owner typed for a recipient.
 */
export function countCorrespondents(run: WriteScope, w: MessageWrite) {
  if (w.flags.draft) return;
  const account = run
    .q('SELECT address FROM accounts WHERE id = ?')
    .get<{ address: string }>(w.accountId);
  if (!account) return;
  const self = normalAddress(account.address);
  if (w.flags.fromMe) {
    const recipients = [...w.to, ...w.cc, ...(w.bcc ?? [])];
    for (const a of distinct(recipients, self))
      run.q(SENT).run(w.accountId, a.address, a.name ?? null, w.internalDate);
    return;
  }
  for (const a of distinct(w.from ? [w.from] : [], self))
    run.q(RECEIVED).run(w.accountId, a.address, a.name ?? null);
}

function distinct(list: Address[], self: string): Address[] {
  const seen = new Map<string, Address>();
  for (const a of list) {
    const address = normalAddress(a?.address ?? '');
    if (!address || address === self || seen.has(address)) continue;
    seen.set(address, { address, name: a.name || undefined });
  }
  return [...seen.values()];
}
