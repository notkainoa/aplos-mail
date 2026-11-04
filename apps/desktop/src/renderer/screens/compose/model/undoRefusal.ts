/**
 * What a refused Undo means (DESIGN 7.6, 7.15). The engine allows Undo only on a held send (`queued`, `scheduled`) and
 * refuses every other state with `stateMismatch` (packages/engine/src/outbox/submissions.ts `wrongState`); the contract
 * fixture says `conflict` while the send is leaving. Either way, a send that has left (or was due to) is "Already sent.";
 * any other refusal says what the engine said, or a plain fallback, never nothing.
 */
import type { Submission } from '../../../data';
import type { Refusal } from './composeState';
import { SEND_COPY } from './sendState';

export type UndoRefusalOutcome =
  | { readonly kind: 'alreadySent' }
  /** The send was already undone (another window, the toast): nothing to say. */
  | { readonly kind: 'quiet' }
  | { readonly kind: 'refused'; readonly message: string };

const LEFT = new Set(['sending', 'sent']);
const WAITING = new Set(['queued', 'scheduled']);
const ALREADY_SENT: UndoRefusalOutcome = { kind: 'alreadySent' };

function refused(refusal: Refusal): UndoRefusalOutcome {
  const message = refusal.message.trim();
  return { kind: 'refused', message: message === '' ? SEND_COPY.undoFailed : message };
}

/** A row we still show as held whose time has come: the engine's refusal means it left. */
function wasDue(row: Pick<Submission, 'state' | 'notBefore'> | undefined, now: number): boolean {
  return row !== undefined && WAITING.has(row.state) && row.notBefore <= now;
}

/**
 * The outcome of an Undo the engine refused. `row` is the newest row this window has for the send (it may be a frame
 * behind the engine), `now` the clock at the refusal.
 */
export function undoRefusalOutcome(
  refusal: Refusal,
  row: Pick<Submission, 'state' | 'notBefore'> | undefined,
  now: number,
): UndoRefusalOutcome {
  const lostRace = refusal.type === 'stateMismatch' || refusal.type === 'conflict';
  if (!lostRace) return refused(refusal);
  if (row && LEFT.has(row.state)) return ALREADY_SENT;
  if (row?.state === 'cancelled') return { kind: 'quiet' };
  if (wasDue(row, now)) return ALREADY_SENT;
  // The fixture's `conflict` is only ever "this message is sending".
  if (refusal.type === 'conflict' && (!row || WAITING.has(row.state))) return ALREADY_SENT;
  return refused(refusal);
}
