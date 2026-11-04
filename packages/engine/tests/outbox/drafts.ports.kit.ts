import assert from 'node:assert/strict';
import type { Draft, DraftFields } from '@aplos/contract';
import { ACCOUNT, fields, inWorld, SEC, type World } from './helpers';

/** Shared helpers of the draft port tests (`drafts.ports.test.ts`, `drafts.supersedes.test.ts`). */

export const world = (fn: (w: World) => Promise<void> | void) => inWorld(fn, { drafts: true });

let ops = 0;
export const next = () => `ports-op-${++ops}`;

export const service = (w: World) => w.first.outbox.drafts!;
export const create = (w: World, f: DraftFields = fields()) =>
  service(w).set(next(), { fields: f }).draft;
export const edit = (w: World, d: Pick<Draft, 'id' | 'revision'>, f: DraftFields, close = false) =>
  service(w).set(next(), { id: d.id, baseRevision: d.revision, fields: f, close }).draft;

export const read = (w: World, id: string): Draft => {
  const found = service(w).get([id]);
  assert.equal(found.notFound.length, 0, `draft ${id} exists`);
  return found.list[0];
};

export const wait = async (w: World, ms: number) => {
  await w.clock.advance(ms);
  await w.settle();
};

export interface Row {
  revision: number;
  remote_draft_id: string | null;
  remote_message_id: string | null;
  remote_internet_id: string | null;
  [k: string]: string | number | null;
}

export const row = (w: World, id: string) =>
  w.first.store.read(q => q.get<Row>('SELECT * FROM drafts WHERE id = ?', id));

export const count = (w: World) =>
  w.first.store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM drafts'))!.n;

export interface Sync {
  incomplete?: true;
  wrote?: string[];
  prints?: Record<string, string>;
  uploading?: { internetId: string };
  conflict?: { complete?: boolean; theirsMessageId?: string; theirs?: { html: string } };
  removing?: true;
}

export const syncOf = (w: World, id: string): Sync => {
  const data = w.first.store.read(q =>
    q.get<{ data: string }>('SELECT data FROM drafts WHERE id = ?', id),
  )!.data;
  return (JSON.parse(data) as { _sync: Sync })._sync;
};

export const THEIRS_ID = '<theirs@phone.example>';

export interface Fact {
  subject?: string;
  html?: string;
  text?: string;
  internetId?: string;
  supersedes?: string[];
  removed?: true;
  /** An `html` on the message itself (the pre-existing way of delivering a body). */
  messageHtml?: string;
  to?: { address: string; name?: string }[];
  snippet?: string;
  hasAttachments?: boolean;
  from?: { address: string; name?: string };
  /** The Bcc the copy shows (default: none, shown). */
  bcc?: { address: string }[];
  /** A provider that cannot show a draft's Bcc: the copy carries no `bcc` at all. */
  omitBcc?: true;
}

/** What history reports when another device saves a draft. */
export function fact(w: World, remoteDraftId: string, messageId: string, f: Fact = {}) {
  w.first.store.commit({
    opId: `ports-fact-${++ops}`,
    origin: 'sync',
    writes: [
      {
        kind: 'remoteDraft',
        accountId: ACCOUNT,
        remoteDraftId,
        remoteMessageId: messageId,
        changedAt: w.clock.now(),
        ...(f.internetId !== undefined ? { internetId: f.internetId } : {}),
        ...(f.removed ? { removed: true as const } : {}),
        ...(f.html !== undefined ? { html: f.html } : {}),
        ...(f.text !== undefined ? { text: f.text } : {}),
        ...(f.supersedes ? { supersedes: f.supersedes } : {}),
        message: {
          remoteId: messageId,
          remoteThreadId: 'phone-thread',
          to: f.to ?? [{ address: 'jordan@mail.example' }],
          from: f.from ?? { address: 'owner@mail.example' },
          ...(f.omitBcc ? {} : { bcc: f.bcc ?? [] }),
          cc: [],
          subject: f.subject ?? 'From the phone',
          snippet: f.snippet ?? 'only a snippet',
          date: w.clock.now(),
          internalDate: w.clock.now(),
          flags: { seen: true, flagged: false, draft: true, fromMe: true },
          ...(f.messageHtml !== undefined ? { html: f.messageHtml } : {}),
          hasAttachments: f.hasAttachments ?? false,
        },
      },
    ],
  });
}

export async function synced(w: World, f: DraftFields = fields()) {
  const d = create(w, f);
  await wait(w, 5 * SEC);
  const r = row(w, d.id)!;
  assert.equal(r.revision, d.revision);
  return {
    draft: read(w, d.id),
    remoteDraftId: r.remote_draft_id!,
    messageId: r.remote_message_id!,
    internetId: r.remote_internet_id!,
  };
}

export const CAP = 1_000_000;
