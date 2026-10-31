import type { Address, Draft, DraftFields } from '@aplos/contract';
import { sha256Hex } from '../diag/sha256';
import type { SqlValue, StoreReader } from '../store';
import { htmlToText } from './mime';
import { LIVE_STATES, type SubmissionState } from './store';

/**
 * What the drafts table keeps besides the columns it has. The store has no columns for the sync state, so it rides in
 * `drafts.data` next to the fields, under `_sync` (one JSON object; `parseData` and `packData` are its only readers and
 * writers, and `prepareSend` ignores the key). A later migration can move these into columns.
 */

/** A draft is uploaded this long after the last change (ARCH 7.4). */
export const DRAFT_IDLE_MS = 5_000;
/** A failed or unreachable upload asks again after this, unless the pause named its end. */
export const DRAFT_RETRY_MS = 30_000;
/** A discarded draft whose first upload has no result yet keeps its row this long, waiting for the copy to be reported. */
export const DRAFT_REMOVE_GRACE_MS = 600_000;
/** The removal of a remote copy is asked again after this at most (the backoff doubles from `DRAFT_RETRY_MS`). */
export const DRAFT_REMOVE_MAX_MS = 3_600_000;
/** A removal the provider refuses for good is asked again this much later. */
export const DRAFT_REMOVE_PERMANENT_MS = 86_400_000;
/** The longest body a remote draft may bring: the local save's own limit (`text(1_000_000)`), counted on the stored body. */
/** How many unanswered creates a draft offers as `supersedes`. */
const EARLIER_KEEP = 5;
export const REMOTE_BODY_MAX = 1_000_000;
/** Message ids and remote ids this device wrote, kept to recognise their echo in history. */
const WROTE_KEEP = 20;

export interface DraftConflictState {
  theirsRevision: number;
  at: number;
  device?: string;
  /** The remote copy was deleted or sent elsewhere; "take theirs" then discards the draft. */
  gone?: true;
  /** The remote message id to overwrite once the owner keeps their version. */
  theirsMessageId?: string;
  /** Their copy's Message-ID, when history reported it: "take theirs" makes it this draft's, never our old one. */
  theirsInternetId?: string;
  /** The other version, when history has delivered it. */
  theirs?: DraftFields;
  /** `theirs` carries their body. Without it (a snippet only) "take theirs" and "keep both" are refused. */
  complete?: boolean;
}

export interface DraftMeta {
  /** The store seq of the row's last change (`Draft.rev`). */
  rev: number;
  /** Fingerprint of the current local content. */
  cur?: string;
  /** Fingerprint of the content the remote copy holds. */
  fingerprint?: string;
  /** When the next upload is due (5 s after the last change, at once on close, or a retry). Absent: nothing to upload. */
  dueAt?: number;
  /**
   * An upload of this revision under this per-revision Message-ID started and has no result yet. `fingerprint` names the
   * content it sends: a fact is that upload's echo only when its own content has this fingerprint (a Message-ID alone
   * proves nothing, and a row written before this field has none, so it proves nothing either).
   */
  uploading?: { internetId: string; revision: number; fingerprint?: string };
  /** Message-IDs and remote message ids this device uploaded: their echo in history is not a remote edit. */
  wrote?: string[];
  /**
   * Message-IDs of earlier creates of this draft that were never answered (a new revision replaced the attempt). The next
   * create offers them as `DraftUpload.supersedes`, so a provider that finds one of those copies replaces it instead of
   * leaving a second remote draft. Cleared when a create is answered.
   */
  earlier?: string[];
  problem?: { reasonCode: string; message: string; at: number };
  conflict?: DraftConflictState;
  /** How many other-device versions were seen (`Draft.conflict.theirsRevision`). */
  theirsSeen?: number;
  /** The seq of the last change the owner's other windows should hear about (`Draft/changed`). */
  announce?: number;
  /**
   * The text of a draft another device wrote has not arrived: the fields hold its snippet. Such a draft is neither
   * edited nor sent here (an edit would upload the snippet over the full draft); it clears when a version with its
   * body is reported.
   */
  incomplete?: true;
  /**
   * Another device changed the copy while a send of this draft was live or had gone out, and nothing could be asked then
   * (the send owns the copy). Once the draft has been sent, a copy marked so holds somebody else's version and is not
   * deleted with the draft.
   */
  changedElsewhere?: true;
  /**
   * The owner discarded this draft (or it was sent) and its remote copy is still to be deleted. The row stays, hidden from
   * every read, so the removal survives a restart and a late fact for the copy is not taken for another device's draft.
   * It goes once the provider confirms the removal.
   */
  removing?: true;
  /** When the removal is next tried (a draft whose first upload has no result yet waits for it). */
  removeAt?: number;
  /** Refusals so far, for the backoff. */
  removeTries?: number;
}

/** The meta keys a `meta` write may set; `null` clears. */
export type MetaPatch = { [K in keyof DraftMeta]?: DraftMeta[K] | null };

export interface DraftRow {
  id: string;
  account_id: string;
  thread_id: number | null;
  revision: number;
  data: string;
  remote_draft_id: string | null;
  remote_message_id: string | null;
  remote_internet_id: string | null;
  synced_revision: number | null;
  remote_change_key: string | null;
  origin: string;
  updated_at: number;
  [k: string]: SqlValue;
}

const SYNC_KEY = '_sync';

export function parseData(data: string): { fields: DraftFields; meta: DraftMeta } {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(data);
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
  } catch {
    // An unreadable row reads as empty; `prepareSend` refuses it with its own sentence.
  }
  const { [SYNC_KEY]: sync, ...fields } = parsed;
  const meta = sync && typeof sync === 'object' ? (sync as Partial<DraftMeta>) : {};
  return { fields: fields as unknown as DraftFields, meta: { rev: 0, ...meta } };
}

export function packData(fields: DraftFields, meta: DraftMeta): string {
  return JSON.stringify({ ...fields, [SYNC_KEY]: meta });
}

/** `meta` with a patch applied: `null` removes a key. */
export function patched(meta: DraftMeta, patch: MetaPatch): DraftMeta {
  const next: Record<string, unknown> = { ...meta };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as DraftMeta;
}

/** Keeps the newest ids only. */
/** The unanswered creates' Message-IDs to offer as `supersedes` (the newest few, each once). */
export function earlierWith(meta: DraftMeta, ...ids: string[]): string[] {
  return [...new Set([...(meta.earlier ?? []), ...ids])].slice(-EARLIER_KEEP);
}

export function remembered(meta: DraftMeta, ...ids: string[]): string[] {
  return [...(meta.wrote ?? []), ...ids].slice(-WROTE_KEEP);
}

// ---------------------------------------------------------------- content

/** JSON with sorted keys and no `undefined`, so equal content always gives equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The content fingerprint: a hash of the draft fields. An upload whose fingerprint is the synced one is skipped. */
export function fingerprintOf(fields: DraftFields): string {
  return sha256Hex(canonical(fields));
}

/** Nothing to keep: no recipient, subject, text or attachment. A new empty draft is not uploaded. */
export function isEmpty(fields: DraftFields): boolean {
  return (
    !fields.to.length &&
    !fields.cc.length &&
    !fields.bcc.length &&
    !fields.attachments.length &&
    !fields.subject.trim() &&
    !htmlToText(fields.html).trim()
  );
}

/** Does this draft need an upload at all (it has content, or a remote copy that must follow its emptying)? */
export function needsUpload(fields: DraftFields, meta: DraftMeta, hasRemote: boolean): boolean {
  if (isEmpty(fields) && !hasRemote) return false;
  return (meta.cur ?? fingerprintOf(fields)) !== meta.fingerprint;
}

// ---------------------------------------------------------------- the contract Draft

export const LIVE_SQL = LIVE_STATES.map(s => `'${s}'`).join(', ');

export interface LiveRow {
  id: string;
  state: SubmissionState;
  [k: string]: SqlValue;
}

export function liveOf(q: Pick<StoreReader, 'get'>, draftId: string): LiveRow | undefined {
  return q.get<LiveRow>(
    `SELECT id, state FROM submissions WHERE draft_id = ? AND state IN (${LIVE_SQL}) LIMIT 1`,
    draftId,
  );
}

/** The sentence for a draft whose text another device wrote and this one never received (edit, send). */
export const INCOMPLETE_SENTENCE =
  "This draft was written on another device and its text isn't available here yet. Open it there to send it, or write a new one.";

function syncOf(row: DraftRow, fields: DraftFields, meta: DraftMeta): Draft['sync'] {
  if (meta.problem) return 'failed';
  if (row.origin === 'remote') return 'synced';
  if (meta.dueAt !== undefined || meta.uploading || meta.conflict) return 'pending';
  const same =
    meta.fingerprint !== undefined && meta.fingerprint === (meta.cur ?? fingerprintOf(fields));
  if (row.synced_revision === row.revision || same) return 'synced';
  return 'localOnly';
}

/** The contract `Draft` of a row. */
export function toDraft(row: DraftRow, submissionId?: string): Draft {
  const { fields, meta } = parseData(row.data);
  const out = {
    ...fields,
    id: row.id,
    rev: meta.rev,
    revision: row.revision,
    updatedAt: row.updated_at,
    origin: row.origin,
    sync: syncOf(row, fields, meta),
  } as Draft;
  if (meta.conflict) {
    out.conflict = { theirsRevision: meta.conflict.theirsRevision, at: meta.conflict.at };
    if (meta.conflict.device !== undefined) out.conflict.device = meta.conflict.device;
  }
  if (meta.incomplete) out.incomplete = true;
  if (submissionId !== undefined) out.submissionId = submissionId;
  return out;
}

/** The row of an existing draft; a draft waiting for its copy to be deleted does not exist for any reader. */
export function readDraftRow(q: Pick<StoreReader, 'get'>, id: string): DraftRow | undefined {
  const row = q.get<DraftRow>('SELECT * FROM drafts WHERE id = ?', id);
  return row && !parseData(row.data).meta.removing ? row : undefined;
}

/** Every row, including one waiting for its copy to be deleted (the removal itself reads these). */
export function readAnyRow(q: Pick<StoreReader, 'get'>, id: string): DraftRow | undefined {
  return q.get<DraftRow>('SELECT * FROM drafts WHERE id = ?', id);
}

/**
 * Fields from a remote draft's metadata. `html` is the snippet until the provider delivers the body. The draft is
 * complete when the body came and the copy has no attachments: attachments are not delivered, so an edit in place would
 * upload `attachments: []` over the other device's draft.
 */
export function theirsFields(
  accountId: string,
  message: {
    to?: Address[];
    cc?: Address[];
    bcc?: Address[];
    subject?: string;
    snippet?: string;
    html?: string;
    hasAttachments?: boolean;
    from?: Address;
  } = {},
  base?: DraftFields,
  /** The account's own address: a copy sent from another address carries that sender, else the draft's `from` is kept. */
  own?: string,
): { fields: DraftFields; complete: boolean } {
  const escaped = (message.snippet ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const fields: DraftFields = {
    accountId,
    mode: base?.mode ?? 'new',
    to: message.to ?? [],
    cc: message.cc ?? [],
    bcc: message.bcc ?? [],
    subject: message.subject ?? '',
    html: message.html ?? `<p>${escaped}</p>`,
    // A copy that says it has no attachments has none: a file this device had and the phone removed must not come back.
    attachments: message.hasAttachments === true ? (base?.attachments ?? []) : [],
    signature: base?.signature ?? false,
  };
  if (base?.threadId !== undefined) fields.threadId = base.threadId;
  if (base?.replyToMessageId !== undefined) fields.replyToMessageId = base.replyToMessageId;
  if (message.from !== undefined && own !== undefined && !sameAddress(message.from.address, own))
    fields.from = message.from;
  else if (base?.from !== undefined) fields.from = base.from;
  return { fields, complete: message.html !== undefined && message.hasAttachments !== true };
}

/**
 * How a remote copy relates to each content field of a draft, in ONE place. A copy is taken as this device's own upload
 * (a fingerprint proof) only when it SHOWS every `shown` field, and every `notShown` field is empty on this device: a
 * field the copy cannot show would be filled in from the local draft and make a foreign edit of it look like ours.
 * Typed against `DraftFields`, so a new draft field does not compile until it is classified here; a test pins the same
 * list against the contract's schema.
 *   - `shown`: the copy carries it and the comparison reads it (`to`, `cc`, `bcc` when the provider can show it,
 *     `subject`, `html`, and `from`, which must be the account's own address).
 *   - `carried`: the draft's identity (account, mode, thread, reply target); a provider edit cannot change it.
 *   - `notShown`: the copy cannot show it (attachments, sign-off): no proof unless it is empty here.
 */
export const DRAFT_CONTENT_FIELDS = {
  accountId: 'carried',
  mode: 'carried',
  threadId: 'carried',
  replyToMessageId: 'carried',
  from: 'shown',
  to: 'shown',
  cc: 'shown',
  bcc: 'shown',
  subject: 'shown',
  html: 'shown',
  attachments: 'notShown',
  signature: 'notShown',
  signatureSource: 'notShown',
} as const satisfies Record<keyof DraftFields, 'shown' | 'carried' | 'notShown'>;

/** The fields a copy must show to count as this device's upload (every key of `DRAFT_CONTENT_FIELDS` that is `shown`). */
export type ShownField = {
  [K in keyof typeof DRAFT_CONTENT_FIELDS]: (typeof DRAFT_CONTENT_FIELDS)[K] extends 'shown'
    ? K
    : never;
}[keyof typeof DRAFT_CONTENT_FIELDS];

/** The same mailbox, ignoring case and surrounding space. */
export const sameAddress = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Did these fields keep something from this device's draft that the other copy does not hold? `theirsFields` carries the
 * attachments and the sign-off over, and a provider's metadata has neither, so such a copy is not the draft.
 */
export function keepsMine(
  fields: Pick<DraftFields, 'attachments' | 'signature'> & { signatureSource?: unknown },
): boolean {
  return fields.attachments.length > 0 || fields.signature || fields.signatureSource !== undefined;
}

// ---------------------------------------------------------------- announcements

/** Called (after the commit, from a microtask) with the id of a draft a remote change touched. */
type Listener = (draftId: string) => void;
const listeners = new Set<Listener>();

/** The module subscribes here to turn remote-driven changes into `Draft/changed` frames. Returns the unsubscribe. */
export function onDraftAnnounced(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * A listener re-reads the row, so a commit that rolled back after this ran announces nothing: the marker in
 * `DraftMeta.announce` is only there when the commit landed.
 */
export function announce(draftId: string) {
  queueMicrotask(() => {
    for (const listener of [...listeners]) listener(draftId);
  });
}

/** Raised inside a commit when a draft write lost its compare-and-set. The commit rolls back whole. */
export class DraftConflict extends Error {
  override readonly name = 'DraftConflict';
  constructor(
    readonly reason:
      'exists' | 'missing' | 'stale' | 'live' | 'noTheirs' | 'incomplete' | 'bodyPending',
    readonly live?: SubmissionState,
  ) {
    super(`draft conflict: ${reason}`);
  }
}
