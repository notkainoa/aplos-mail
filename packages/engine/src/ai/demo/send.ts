import type { DraftFields } from '@aplos/contract';
import type { AccountId } from '../../ports/base';
import type { SendPort } from '../../ports/engine';
import type { FindSentResult, SendReceipt, SubmissionPayload } from '../../ports/provider';
import type { StorePort, StoreReader } from '../../store/port';

/*
 * Demo sends deliver locally (ai-2, as the legacy engine and the contract fixture do): a demo account has no provider,
 * so the real `SendPort` answers every send `accountNotStarted` and the outbox re-asks forever. This decorator answers a
 * demo account's `admission`, `send` and `findSent` from the store instead: the send commits the message to the
 * account's Sent folder as a complete thread (or into the thread it replies to) and the outbox settles it `sent`, so
 * Undo, send later and the Sent view behave as they do for a real account. Nothing leaves the Mac. Every other
 * account goes to `inner` unchanged.
 *
 * The host composition (`apps/desktop/src/host/compose.ts`) wraps the real port with it; nothing in the engine core
 * imports this module, so it does not count against the startup bundle (packages/engine/tests/portability.test.ts).
 */

const isDemo = (q: StoreReader, account: AccountId) =>
  q.get("SELECT 1 AS one FROM accounts WHERE id = ? AND provider = 'demo'", account) !== undefined;

/** The demo Sent copy's own id: one per submission, so a retried send finds the copy it already wrote. */
export const demoSentId = (submissionId: string) => `sent-${submissionId}`;

const plain = (html: string) =>
  html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function draftFieldsOf(q: StoreReader, submissionId: string): DraftFields | undefined {
  const row = q.get<{ data: string }>(
    'SELECT d.data FROM submissions s JOIN drafts d ON d.id = s.draft_id WHERE s.id = ?',
    submissionId,
  );
  if (!row) return undefined;
  try {
    return JSON.parse(row.data) as DraftFields;
  } catch {
    return undefined;
  }
}

/** Commits the Sent copy (once per submission) and answers the receipt a provider would. */
function deliver(store: StorePort, account: AccountId, payload: SubmissionPayload, now: number) {
  const remoteId = demoSentId(payload.submissionId);
  const remoteThreadId = payload.remoteThreadId ?? remoteId;
  const receipt: SendReceipt = { remoteMessageId: remoteId, remoteThreadId, acceptedAt: now };
  const stored = store.read(q =>
    q.get(
      'SELECT 1 AS one FROM messages WHERE account_id = ? AND remote_id = ?',
      account,
      remoteId,
    ),
  );
  if (stored) return receipt;
  const found = store.read(q => ({
    fields: draftFieldsOf(q, payload.submissionId),
    owner: q.get<{ address: string; display_name: string | null }>(
      'SELECT address, display_name FROM accounts WHERE id = ?',
      account,
    ),
  }));
  const fields = found.fields;
  const html = fields?.html ?? '';
  const name = found.owner?.display_name;
  const from = fields?.from ?? {
    address: found.owner?.address ?? payload.envelope.from,
    ...(name ? { name } : {}),
  };
  store.commit({
    opId: `demo-send-${payload.submissionId}`,
    origin: 'local',
    writes: [
      {
        kind: 'message',
        accountId: account,
        remoteId,
        remoteThreadId,
        internetId: payload.internetId,
        from,
        to: fields?.to ?? payload.envelope.rcpt.map(address => ({ address })),
        cc: fields?.cc ?? [],
        bcc: fields?.bcc ?? [],
        subject: fields?.subject ?? '',
        snippet: plain(html).slice(0, 140),
        date: now,
        internalDate: now,
        size: payload.mime.length,
        flags: { seen: true, flagged: false, draft: false, fromMe: true },
        hasAttachments: (fields?.attachments.length ?? 0) > 0,
        folders: [{ folder: 'SENT' }],
      },
      { kind: 'body', accountId: account, remoteId, body: { html } },
      // The whole thread is here (a new one, or a demo thread that already was): opening it asks no provider.
      { kind: 'thread', accountId: account, remoteThreadId, complete: true },
    ],
  });
  return receipt;
}

function findSent(store: StorePort, account: AccountId, internetId: string, now: number) {
  const row = store.read(q =>
    q.get<{ remote_id: string; thread: string }>(
      `SELECT m.remote_id, t.remote_id AS thread FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.account_id = ? AND m.internet_id = ? LIMIT 1`,
      account,
      internetId,
    ),
  );
  const result: FindSentResult = row
    ? { kind: 'found', remoteMessageId: row.remote_id, remoteThreadId: row.thread }
    : { kind: 'absent', checkedAt: now };
  return result;
}

/** `inner`, except that a demo account's sends are delivered to its own Sent folder in the store. */
export function withDemoDelivery(inner: SendPort, store: StorePort, now: () => number): SendPort {
  const demo = (account: AccountId) => store.read(q => isDemo(q, account));
  return {
    admission: account => (demo(account) ? { ok: true } : inner.admission(account)),
    send: async (account, payload) =>
      demo(account) ? deliver(store, account, payload, now()) : inner.send(account, payload),
    findSent: async (account, internetId, since) =>
      demo(account)
        ? findSent(store, account, internetId, now())
        : inner.findSent(account, internetId, since),
  };
}
