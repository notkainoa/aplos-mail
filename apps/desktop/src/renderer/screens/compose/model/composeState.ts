/**
 * The composer's state, its events and the effects the reducer asks for (DESIGN 7.6). Pure data: `composeReducer.ts`
 * steps it, and `runtime/session.ts` runs the effects against the engine and feeds the answers back as events.
 */
import type { Draft, Submission, SubmissionAction } from '../../../data';
import type { BlockedSend } from '../../../ui/props';
import { FRESH_SAVE, type SaveClock } from './autosave';
import {
  contextFromDraft,
  EMPTY_FIELDS,
  fieldsFromDraft,
  type ComposeContext,
  type ComposeFields,
} from './fields';
import { NO_SEND, type SendAction, type SendIntent } from './sendState';

/** Dim suggested text after the body: an AI draft or a follow-up nudge (DESIGN 9 rule 6). */
export interface ComposeSuggestion {
  readonly kind: 'draft' | 'followUp';
  readonly text: string;
}

/** Why the composer is no longer shown; null while it is (or could be reopened). */
export type ComposeEnd = 'closed' | 'discarded' | 'sent' | null;

export interface ComposeState {
  readonly context: ComposeContext;
  readonly fields: ComposeFields;
  readonly save: SaveClock;
  readonly send: SendIntent;
  readonly suggestion: ComposeSuggestion | null;
  /** The card or page is showing (it owns the filled button only then). */
  readonly open: boolean;
  /** The discard confirmation is up ("Discard this draft?"). */
  readonly confirm: 'discard' | null;
  readonly blocked: BlockedSend | null;
  readonly ended: ComposeEnd;
  /** Discard confirmed: no more saves; the draft is destroyed once its id is known. */
  readonly discarding: boolean;
  /** Sends of this draft that ended cancelled in this composer; part of the next send's idempotency key. */
  readonly attempt: number;
}

/** What a refused write said, without the transport's error class. */
export interface Refusal {
  readonly type: string;
  readonly message: string;
  readonly reasonCode?: string;
  readonly resumeAt?: number;
}

export type ComposeEvent =
  | { readonly type: 'edit'; readonly patch: Partial<ComposeFields>; readonly now: number }
  | { readonly type: 'tick'; readonly now: number }
  /** Save whatever is unsaved now, whatever the debounce says (the composer is going away). */
  | { readonly type: 'flush' }
  | {
      readonly type: 'saved';
      readonly seq: number;
      readonly draft: Pick<Draft, 'id' | 'revision' | 'rev'>;
    }
  | { readonly type: 'saveFailed'; readonly seq: number; readonly now: number }
  | { readonly type: 'retrySave'; readonly now: number }
  | { readonly type: 'observeDraft'; readonly draft: Draft | null }
  | { readonly type: 'observeSubmission'; readonly submission: Submission }
  | {
      readonly type: 'send';
      readonly now: number;
      readonly undoSeconds: number;
      readonly alsoDone?: boolean;
      readonly notBefore?: number;
    }
  | { readonly type: 'sendAccepted'; readonly submission: Submission }
  | { readonly type: 'sendRefused'; readonly refusal: Refusal }
  | { readonly type: 'action'; readonly action: SendAction; readonly notBefore?: number }
  | { readonly type: 'escape' }
  | { readonly type: 'askDiscard' }
  | { readonly type: 'confirmDiscard' }
  | { readonly type: 'cancelDiscard' }
  | { readonly type: 'discarded' }
  | { readonly type: 'discardFailed' }
  | { readonly type: 'suggest'; readonly suggestion: ComposeSuggestion }
  | { readonly type: 'keepSuggestion'; readonly now: number }
  | { readonly type: 'dismissSuggestion' }
  | { readonly type: 'dictated'; readonly text: string; readonly now: number }
  | { readonly type: 'reopen' };

/** A `Submission/set` action other than `send`. */
export type FollowUpAction = Exclude<SubmissionAction, { type: 'send' }>;

export type ComposeEffect =
  | {
      readonly type: 'save';
      readonly seq: number;
      readonly fields: ComposeFields;
      readonly context: ComposeContext;
      readonly draftId: string | null;
      readonly baseRevision: number | null;
    }
  | {
      readonly type: 'submit';
      readonly opId: string;
      readonly draftId: string;
      readonly revision: number;
      readonly alsoDone: boolean;
      readonly notBefore?: number;
    }
  | { readonly type: 'submission'; readonly action: FollowUpAction }
  | { readonly type: 'destroy'; readonly draftId: string }
  | { readonly type: 'checkSent' }
  | { readonly type: 'notify'; readonly notice: 'discarded' | 'discardFailed' };

/** One reducer step: the next state and what to do about it. */
export interface Step {
  readonly state: ComposeState;
  readonly effects: readonly ComposeEffect[];
}

/** A fresh composer: new message, reply or forward, with any prefilled fields (a reply's To). Nothing is saved yet. */
export function freshCompose(
  context: ComposeContext,
  fields: ComposeFields = EMPTY_FIELDS,
): ComposeState {
  return {
    context,
    fields,
    save: FRESH_SAVE,
    send: NO_SEND,
    suggestion: null,
    open: true,
    confirm: null,
    blocked: null,
    ended: null,
    discarding: false,
    attempt: 0,
  };
}

/** A composer on an existing draft (reopened from Drafts, or found again after a reload). A live send keeps it closed. */
export function composeFromDraft(draft: Draft): ComposeState {
  const sending = draft.submissionId !== undefined;
  return {
    ...freshCompose(contextFromDraft(draft), fieldsFromDraft(draft)),
    save: { ...FRESH_SAVE, draftId: draft.id, revision: draft.revision, rowRev: draft.rev },
    send: sending ? { kind: 'tracking', submissionId: draft.submissionId!, row: null } : NO_SEND,
    open: !sending,
  };
}

/**
 * The idempotency key of one send: the draft, the revision it sends, the row version it was pressed on, and how many
 * sends of it this composer saw cancelled. A second Return, a second composer on the same draft, or a transport retry
 * reuse the key, so the engine answers with the first submission instead of making another.
 */
export function sendOpId(
  draftId: string,
  revision: number,
  rowRev: number | null,
  attempt: number,
): string {
  return `send:${draftId}:r${revision}:v${rowRev ?? 0}:a${attempt}`;
}
