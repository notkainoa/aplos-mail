import type { ReactNode, Ref } from 'react';
import type { CommandId, DictationState } from './shared';

/* ───────────────────────── compose ───────────────────────── */

/** Draft save state, one line (DESIGN §7.6 Draft state). 'none': nothing saved yet (an untouched new message), no line. */
export type DraftStateKind = 'saving' | 'saved' | 'failed' | 'none';

/** "This draft changed on another device." with Keep mine · Take theirs · Keep both (plan 30 §4.5 #5). */
export interface DraftConflict {
  /** Keep the local text. */
  onKeepMine: () => void;
  /** Take the other device's text. */
  onTakeTheirs: () => void;
  /** Keep both as separate drafts. */
  onKeepBoth: () => void;
}

/** A blocked send outlines the field and explains in one sentence; no shake (DESIGN §7.6). */
export interface BlockedSend {
  /** Which field is outlined. */
  field: 'to' | 'subject' | 'body';
  /** One plain sentence. */
  message: string;
}

/** Registry ids for composer controls (DESIGN §8 Compose). */
export interface ComposeCommands {
  /** ⌘↩ Send (always shown on the button). */
  send: CommandId;
  /** ⌘⇧A Attach. */
  attach: CommandId;
  /** ⌘/ Format menu, or ⋯ in the inline reply. */
  more: CommandId;
  /** ⌘⇧C Cc/Bcc. */
  cc: CommandId;
}

/** New message as a page in the pane (640 px), non-modal: To row, `heading` subject, `read` body, footer with Send, draft state, attach, format (DESIGN §6 Composer, §7.6). The pane header (close, "New message", ⋯, Ask) belongs to the screen. Mockups: compose.html (new, ai-draft, polish, follow-up). Plain + refines: ui-foundation; used by ui-reader. */
export interface ComposerProps {
  /** RecipientField rows (To, and Cc/Bcc when shown). */
  recipients: ReactNode;
  /** Subject value. */
  subject: string;
  /** Subject edited. */
  onSubjectChange: (value: string) => void;
  /** The body editor, `read` type (owned by ui-reader). An AI draft or follow-up nudge is editor data: the editor renders the dim text at the caret itself; no component renders inside the contenteditable. */
  editor: ReactNode;
  /** The suggestion hint line under the body while the editor holds dim suggested text. */
  suggestion?: SuggestionProps;
  /** Dictating (hold Space in an empty body): the footer shows the meter and the Listening line. */
  dictation?: DictationState;
  /** The Polish bar: "Polish suggests <n> changes. Yours stays until you choose." Use these (Return) · Keep mine (Esc). */
  polish?: { changes: number; onUse: () => void; onKeep: () => void };
  /** Draft save state. */
  draftState: DraftStateKind;
  /** Retry after "Couldn't save". */
  onRetrySave: () => void;
  /** A blocked send. */
  blocked?: BlockedSend;
  /** The draft changed on another device. */
  conflict?: DraftConflict;
  /** Registry ids for the footer. */
  commands: ComposeCommands;
  /** Send. */
  onSend: () => void;
  /** No valid recipient yet: Send takes the disabled look until there is one. ⌘↩ still answers, with the reason. */
  sendDisabled?: boolean;
  /** Attach a file. */
  onAttach: () => void;
  /** Format menu. */
  onFormat: (anchor: HTMLElement) => void;
}

/** The inline reply card under the message (`--elev-card`, `settle`): To line with Cc and Pop out, `read` text, Send (⌘↩), draft state, attach and ⋯; owns the filled button while open (DESIGN §6 InlineReply, §7.6). Mockups: reply.html (reply, reply-all, dictating). Plain + refines: ui-foundation; used by ui-reader. */
export interface InlineReplyProps {
  /** RecipientField rows; the To row carries the Cc button (`RecipientField.ccButton`), and the screen adds Cc/Bcc rows when shown. */
  recipients: ReactNode;
  /** Move the reply to the compose page. */
  onPopOut: () => void;
  /** The body editor (owned by ui-reader); it renders any dim suggested text itself. */
  editor: ReactNode;
  /** The suggestion hint line under the body (AI draft, follow-up nudge). */
  suggestion?: SuggestionProps;
  /** Draft save state. */
  draftState: DraftStateKind;
  /** Retry after "Couldn't save". */
  onRetrySave: () => void;
  /** Dictating: the footer shows the meter and the Listening line. */
  dictation?: DictationState;
  /** A blocked send. */
  blocked?: BlockedSend;
  /** The draft changed on another device. */
  conflict?: DraftConflict;
  /** Registry ids for the controls. */
  commands: ComposeCommands;
  /** Send. */
  onSend: () => void;
  /** No valid recipient yet: Send takes the disabled look until there is one. ⌘↩ still answers, with the reason. */
  sendDisabled?: boolean;
  /** Attach a file. */
  onAttach: () => void;
  /** ⋯ (format, schedule, discard). */
  onMore: (anchor: HTMLElement) => void;
  /** Element ref for `settle` in and out. */
  ref?: Ref<HTMLElement>;
}

/** A person in a recipient field. */
export interface Recipient {
  /** Stable id. */
  id: string;
  /** Display name. */
  name?: string;
  /** Address (mono in popovers). */
  address: string;
}

/** Recipients as removable names with type-ahead (DESIGN §6 RecipientField, §7.6). Mockups: reply.html, compose.html. Plain + refines: ui-foundation; used by ui-reader. */
export interface RecipientFieldProps {
  /** Row label. */
  label: 'To' | 'Cc' | 'Bcc';
  /** Current recipients. */
  recipients: readonly Recipient[];
  /** Typed text not yet committed. */
  query: string;
  /** Typed text changed. */
  onQueryChange: (value: string) => void;
  /** Return, comma or blur commits the query as a recipient. */
  onCommit: (text: string) => void;
  /** Remove one (Backspace on an empty query removes the last). */
  onRemove: (id: string) => void;
  /** Type-ahead matches; shown as a listbox. */
  suggestions?: readonly Recipient[];
  /** Highlighted suggestion. */
  activeSuggestionId?: string;
  /** A suggestion was picked. */
  onPickSuggestion?: (id: string) => void;
  /** DOM id of the suggestions listbox (combobox wiring, DESIGN §11.3). */
  listboxId: string;
  /** Recipients that failed validation (outlined). */
  invalidIds?: readonly string[];
  /** Show the "Cc" text button on this row (To only); the one owner of Cc in the composer family. */
  ccButton?: { onSelect: () => void; commandId: CommandId };
  /** Focus on mount. */
  autoFocus?: boolean;
}

/** One line: "Saving…", "Draft saved", "Couldn't save · Retry" (DESIGN §6 DraftState, §7.6). Mockups: reply.html, compose.html. Plain + refines: ui-foundation; used by ui-reader. */
export interface DraftStateProps {
  /** Which line. */
  state: DraftStateKind;
  /** Retry after a failure. */
  onRetry?: () => void;
}

/** The hint line under the body for dim AI text: "The gray sentence is a suggestion. Tab keep, Esc dismiss." The dim text itself is editor data rendered by ui-reader's editor (DESIGN §6 Suggestion, §7.6, §9 rule 6). Mockups: compose.html (ai-draft, follow-up: `p.suggest-hint`). Plain + refines: ui-foundation; used by ui-reader via Composer and InlineReply. */
export interface SuggestionProps {
  /** 'draft' = "The gray sentence is a suggestion."; 'followUp' = "Aplos drafted this follow-up from your last email." */
  kind: 'draft' | 'followUp';
  /** Tab: keep it as ordinary text. */
  onKeep: () => void;
  /** Esc: remove it. */
  onDismiss: () => void;
}

/** A small `--stamp` bar meter for dictation; the breathing ring is removed (DESIGN §6 LevelMeter). Mockups: reply.html (dictating). Plain + refines: ui-foundation; used by ui-reader, ui-ask. */
export interface LevelMeterProps {
  /** Input level 0–1. The voice hook may instead drive it per frame through `ref` to avoid React renders (DESIGN §5 rule 3). */
  level: number;
  /** Accessible name, e.g. "Listening". */
  label: string;
  /** Element ref for imperative level updates. */
  ref?: Ref<HTMLElement>;
}
