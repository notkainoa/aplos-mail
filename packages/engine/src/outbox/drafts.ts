import type { Draft, DraftFields, Receipt, State, SubmissionAction } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { sha256Hex } from '../diag/sha256';
import type { StoreWrite } from '../store';
import { touchDue } from './draft-due';
import type { DraftsCtx } from './draft-sync';
import {
  DraftConflict,
  fingerprintOf,
  INCOMPLETE_SENTENCE,
  liveOf,
  parseData,
  readDraftRow,
  toDraft,
  type DraftRow,
} from './draft-state';
import type { DraftChoice } from './draft-writes';

/**
 * `Draft/get|set|destroy|resolve`: the owner's commands on the local drafts (ARCH 7.4). A save is a compare-and-set on
 * `revision` inside the commit, so of two saves on one base exactly one wins and the other is told `stateMismatch`.
 * A draft with a live send is locked (FR-7): nothing here changes it, and discarding it first cancels a send that has
 * not started. The upload to the provider is `draft-sync.ts`'s; a save only decides when it is due.
 */

export interface DraftSetInput {
  id?: string;
  baseRevision?: number;
  fields: DraftFields;
  /** The editor is closing: upload now. */
  close?: boolean;
}

export interface DraftService {
  get(ids: readonly string[]): { state: State; list: Draft[]; notFound: string[] };
  set(opId: string, input: DraftSetInput): { draft: Draft; receipt: Receipt };
  /**
   * `mayCancelSend` runs before a live send of the draft is cancelled (and only then): it throws when the caller may not
   * cancel the owner's send. A discard of a draft with no send never calls it.
   */
  destroy(opId: string, id: string, mayCancelSend?: () => void): Receipt;
  resolve(
    opId: string,
    id: string,
    choice: DraftChoice,
  ): { draft: Draft; copyId?: string; receipt: Receipt };
}

/** What the drafts need from the send state machine: cancel a send that has not started. */
export interface SendCanceller {
  set(opId: string, action: SubmissionAction): unknown;
}

const CHANGED = 'This draft changed in another window. Reopen it before editing.';
const GONE = 'This draft no longer exists.';
const ON_ITS_WAY = 'This message is on its way. Undo or cancel the send to edit it.';
const SENDING = 'This message is sending now.';
const UNCONFIRMED =
  'We are checking whether this message was sent. Wait for that before discarding it.';
const NO_CHOICE = 'This draft has no other version to choose.';
const CANNOT_READ = "Their version can't be read here. Keep yours, or open it on the other device.";
const NOT_ARRIVED = 'The other version has not arrived yet. Try again in a moment.';

function fail(type: string, message: string): never {
  throw new ContractError({ type, message });
}

/** An id the same opId always makes again, so a replayed create answers with the draft it made. */
export function idFor(opId: string, tag: string) {
  return `dr_${sha256Hex(`${tag}:${opId}`).slice(0, 24)}`;
}

function replayed(ctx: DraftsCtx, opId: string) {
  return !!ctx.store.read(q => q.get('SELECT 1 FROM commits WHERE op_id = ?', opId));
}

function receiptOf(ctx: DraftsCtx, opId: string): Receipt {
  return {
    opId,
    appliedState: { dbEpoch: ctx.store.dbEpoch, seq: ctx.store.seq() },
    undoable: false,
  };
}

function readOne(ctx: DraftsCtx, id: string): Draft | undefined {
  return ctx.store.read(q => {
    const row = readDraftRow(q, id);
    return row ? toDraft(row, liveOf(q, id)?.id) : undefined;
  });
}

function liveSentence(state: string | undefined) {
  return state === 'sending' ? SENDING : ON_ITS_WAY;
}

/** The sentence and type of a lost compare-and-set. */
function conflictError(error: DraftConflict): never {
  switch (error.reason) {
    case 'missing':
      return fail('notFound', GONE);
    case 'live':
      return fail(
        error.live === 'sending' ? 'conflict' : 'stateMismatch',
        liveSentence(error.live),
      );
    case 'noTheirs':
      return fail('unavailable', NOT_ARRIVED);
    case 'incomplete':
      return fail('unavailable', CANNOT_READ);
    case 'bodyPending':
      return fail('unavailable', INCOMPLETE_SENTENCE);
    default:
      return fail('stateMismatch', CHANGED);
  }
}

function commit(ctx: DraftsCtx, opId: string, write: StoreWrite): number {
  try {
    const { seq } = ctx.store.commit({ opId, origin: 'local', writes: [write] });
    return seq;
  } catch (error) {
    if (error instanceof DraftConflict) return conflictError(error);
    throw error;
  }
}

function requireAccount(ctx: DraftsCtx, accountId: string) {
  const known = ctx.store.read(q => q.get('SELECT 1 FROM accounts WHERE id = ?', accountId));
  if (!known) fail('notFound', 'This account is not connected.');
}

/**
 * An edit of a draft whose text never arrived (another device's snippet) becomes a new draft of its own: the id it is
 * saved under, which the client switches to. The other device's draft is not touched.
 */
function forkIdFor(ctx: DraftsCtx, opId: string, current: DraftRow | undefined) {
  if (!current || !parseData(current.data).meta.incomplete) return undefined;
  return idFor(opId, 'fork');
}

function setDraft(ctx: DraftsCtx, opId: string, input: DraftSetInput) {
  const id = input.id ?? idFor(opId, 'create');
  if (replayed(ctx, opId)) {
    const fork = idFor(opId, 'fork');
    return answerSet(ctx, opId, readOne(ctx, fork) ? fork : id);
  }
  const { fields } = input;
  requireAccount(ctx, fields.accountId);
  const current = ctx.store.read(q => readDraftRow(q, id));
  if (current && current.account_id !== fields.accountId)
    fail('validation', 'A draft cannot move to another account.');
  const forkId = input.baseRevision !== undefined ? forkIdFor(ctx, opId, current) : undefined;
  commit(ctx, opId, {
    kind: 'draft',
    op: 'save',
    id,
    ...(forkId !== undefined ? { forkId } : {}),
    accountId: fields.accountId,
    ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
    fields,
    fingerprint: fingerprintOf(fields),
    at: ctx.clock.now(),
    ...(input.close ? { close: true as const } : {}),
  });
  const saved = forkId ?? id;
  touchDue(ctx, saved);
  ctx.deadlines.changed('drafts');
  return answerSet(ctx, opId, saved);
}

function answerSet(ctx: DraftsCtx, opId: string, id: string) {
  const draft = readOne(ctx, id);
  if (!draft) return fail('notFound', GONE);
  return { draft, receipt: receiptOf(ctx, opId) };
}

// ---------------------------------------------------------------- destroy

/** A send that has not started is cancelled; one that is sending or unconfirmed blocks the discard. */
function cancelSend(
  ctx: DraftsCtx,
  canceller: SendCanceller,
  opId: string,
  id: string,
  mayCancelSend: () => void,
) {
  const live = ctx.store.read(q => liveOf(q, id));
  if (!live) return;
  mayCancelSend();
  if (live.state === 'sending') fail('conflict', SENDING);
  if (live.state === 'uncertain') fail('conflict', UNCONFIRMED);
  const waiting = live.state === 'queued' || live.state === 'scheduled';
  canceller.set(`${opId}:cancel`, {
    type: waiting ? 'undo' : 'cancel',
    submissionId: live.id,
  });
}

function destroyDraft(
  ctx: DraftsCtx,
  canceller: SendCanceller,
  opId: string,
  id: string,
  mayCancelSend: () => void,
) {
  if (replayed(ctx, opId)) return receiptOf(ctx, opId);
  const row: DraftRow | undefined = ctx.store.read(q => readDraftRow(q, id));
  if (!row) return fail('notFound', GONE);
  cancelSend(ctx, canceller, opId, id, mayCancelSend);
  // The row stays, hidden, while a remote copy exists: the provider's removal runs from it (and survives a restart).
  commit(ctx, opId, { kind: 'draftDelete', id, at: ctx.clock.now() });
  touchDue(ctx, id);
  ctx.deadlines.changed('drafts');
  ctx.announced.delete(id);
  return receiptOf(ctx, opId);
}

// ---------------------------------------------------------------- resolve

function resolveDraft(ctx: DraftsCtx, opId: string, id: string, choice: DraftChoice) {
  const before = readOne(ctx, id);
  if (!before) return fail('notFound', GONE);
  if (replayed(ctx, opId)) return answerResolve(ctx, opId, id, before);
  if (!before.conflict) fail('stateMismatch', NO_CHOICE);
  const copyId = idFor(opId, 'copy');
  commit(ctx, opId, { kind: 'draft', op: 'resolve', id, choice, at: ctx.clock.now(), copyId });
  touchDue(ctx, id);
  touchDue(ctx, copyId);
  ctx.deadlines.changed('drafts');
  return answerResolve(ctx, opId, id, before, copyId);
}

function answerResolve(ctx: DraftsCtx, opId: string, id: string, before: Draft, copyId?: string) {
  // "Take theirs" on a draft the other device deleted discards it: the answer is the draft as it was.
  const draft = readOne(ctx, id) ?? before;
  const made = copyId !== undefined && readOne(ctx, copyId) !== undefined;
  return { draft, ...(made ? { copyId } : {}), receipt: receiptOf(ctx, opId) };
}

// ---------------------------------------------------------------- service

export function createDraftService(ctx: DraftsCtx, canceller: SendCanceller): DraftService {
  return {
    get(ids) {
      const state = { dbEpoch: ctx.store.dbEpoch, seq: ctx.store.seq() };
      const found = ids.map(id => [id, readOne(ctx, id)] as const);
      return {
        state,
        list: found.flatMap(([, draft]) => (draft ? [draft] : [])),
        notFound: found.filter(([, draft]) => !draft).map(([id]) => id),
      };
    },
    set: (opId, input) => setDraft(ctx, opId, input),
    destroy: (opId, id, mayCancelSend = () => {}) =>
      destroyDraft(ctx, canceller, opId, id, mayCancelSend),
    resolve: (opId, id, choice) => resolveDraft(ctx, opId, id, choice),
  };
}
