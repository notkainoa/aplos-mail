/**
 * Everything the composer's screens draw, derived from the state, the clock and whether the engine is online. Pure, so
 * the behaviour tests read the same values the components get.
 */
import type { BlockedSend, DraftStateKind } from '../../../ui/props';
import { draftStateOf } from './autosave';
import type { ComposeState, ComposeSuggestion } from './composeState';
import type { ComposeFields } from './fields';
import { blockedSend, invalidIds } from './recipients';
import { phaseOf, sendView, type SendPhase, type SendView } from './sendState';

export interface ComposeView {
  /** The card or page is showing: it owns the one filled button (Send). */
  readonly open: boolean;
  readonly draftState: DraftStateKind;
  readonly blocked: BlockedSend | undefined;
  readonly suggestion: ComposeSuggestion | null;
  /** "Discard this draft?" is up. */
  readonly confirming: boolean;
  readonly phase: SendPhase;
  readonly send: SendView;
  /** The key conditions the registry reads (`onlyWhen`). */
  readonly conditions: { readonly suggestion: boolean; readonly emptyBody: boolean };
  /** Recipients the field outlines. */
  readonly invalid: readonly string[];
  /** At least one recipient and every address plausible: Send is live. */
  readonly canSend: boolean;
}

export function composeView(
  state: ComposeState,
  now: number,
  online: boolean,
  formatTime: (ms: number) => string,
): ComposeView {
  const phase = phaseOf(state.send, now, online);
  const { to, cc, bcc } = state.fields;
  return {
    open: state.open,
    draftState: draftStateOf(state.save),
    blocked: state.blocked ?? undefined,
    suggestion: state.suggestion,
    confirming: state.confirm === 'discard',
    phase,
    send: sendView(phase, formatTime),
    conditions: { suggestion: state.suggestion !== null, emptyBody: state.fields.body === '' },
    invalid: invalidIds([...to, ...cc, ...bcc]),
    canSend: blockedSend(state.fields, state.context.mode) === null,
  };
}

/** Cc and Bcc rows show when asked for, and always while either holds a recipient (a hidden row still sends). */
export function ccRowsShown(asked: boolean, fields: Pick<ComposeFields, 'cc' | 'bcc'>): boolean {
  return asked || fields.cc.length + fields.bcc.length > 0;
}
