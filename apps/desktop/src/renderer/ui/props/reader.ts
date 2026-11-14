import type { ReactNode, Ref } from 'react';
import type {
  Announce,
  CommandId,
  DueInfo,
  IsoDateTime,
  Lane,
  ReaderTriageCommands,
  SuggestedAction,
} from './shared';
import type { ChipProps, SummaryContent } from './list';

/* ───────────────────────── reader ───────────────────────── */

/** The reader's top: the big serif summary with its due chip, then a hairline (owner review 2026-11-03: the sender line moved into the message cards, the actions into the pinned `ReaderActions` bar). DESIGN §6 ReaderHead, §7.5. Mockups: reader.html, reply.html, errors.html (send-failed). Plain + refines: ui-foundation; used by ui-reader. */
export interface ReaderHeadProps {
  /** Due chip under the summary, sentence format. */
  due?: DueInfo;
  /** Summary slot; never clamped here. */
  summary: SummaryContent;
  /** Element ref for the reader-column flight ghost (DESIGN §4.9). */
  ref?: Ref<HTMLElement>;
}

/** The reader's action bar, pinned to the bottom of the pane and centred: the suggestion as the filled button with Space, then Later and Done as text buttons (DESIGN §6, §7.5 item 3; owner review 2026-11-03). */
export interface ReaderActionsProps {
  /** The filled suggestion with Space. */
  suggestion: SuggestedAction;
  /** Registry ids for the three controls; ⋯ lives in the pane header. */
  commands: ReaderTriageCommands;
  /** The inline reply or another top surface owns the filled button (DESIGN §7.6): the suggestion is a text button and the bar rests in the flow under the reply instead of floating. */
  demoted: boolean;
  /** Suggestion button. */
  onSuggestion: () => void;
  /** Later button; the element anchors DatePresets. */
  onLater: (anchor: HTMLElement) => void;
  /** Done button. */
  onDone: () => void;
}

/** A remote-images notice on a message (DESIGN §7.5 HTML mail). */
export interface RemoteImages {
  /** Remote images are blocked: shows "Load images from this sender". */
  blocked: boolean;
  /** The message has remote images at all. The notice strip keeps its height once they are loaded (it then reads
   * "Images from this sender are shown", with no button), so loading them never moves the heading below it. */
  present?: boolean;
  /** Load and remember for this sender. */
  onLoad: () => void;
}

/** One full message in the thread: an `article` landmark (DESIGN §11.3) with header (who, to, when), the `read` body from mailframe, "Load images from this sender", quoted text on O, attachments, and the 2 px accent rail when it holds the thread cursor (DESIGN §7.5 item 4). Mockups: reader.html, reply.html (sent, with UndoTray), errors.html. Plain + refines: ui-foundation; used by ui-reader. */
export interface ThreadMessageProps {
  /** Message id; also the DOM id the thread cursor and `aria-labelledby` use. */
  id: string;
  /** Sender name, or "You". */
  from: string;
  /** `--dim` recipients phrase, e.g. "to you, Mina Cho". */
  toLabel: string;
  /** The mark before the name in the card header (the sender's avatar square), on every card: a folded earlier message keeps it in its compact row. */
  leading?: ReactNode;
  /** Replaces the `toLabel` phrase in the head: the screen's "To" with its recipient circles and the chevron that opens the details. Shown only while the card is open (a folded earlier message is compact and keeps its `toLabel`). */
  recipients?: ReactNode;
  /** The head's right side: the screen's Importance menu, bell and ⋯. Never on a fold (the latest message's, which has none). */
  headActions?: ReactNode;
  /** Sent time. */
  date: IsoDateTime;
  /** Holds the thread cursor (the one thread cursor id): the accent rail shows. */
  cursor: boolean;
  /** The message body from `renderer/mailframe` (sandboxed iframe or plain text); absent while the card is compact. */
  body?: ReactNode;
  /** An earlier message the card can fold: the head is a button (`aria-expanded`), a click or O opens or closes it. Absent: always open (the latest message). */
  fold?: { open: boolean; onToggle: () => void; onFocus?: () => void; commandId: CommandId };
  /** Compact (folded) card: the plain-text first sentence or two, already ending in "…". Shown under the head while `fold.open` is false; an empty string reads "No preview" in dim text. */
  excerpt?: string;
  /** Attachment chips under the body. */
  attachments?: readonly Extract<ChipProps, { kind: 'attachment' }>[];
  /** Remote images notice, when the mail has any. */
  remoteImages?: RemoteImages;
  /** Quoted text toggle. `commandId` (O) only where O really toggles quoted text: on the latest message, never on a card O folds. */
  quoted?: { shown: boolean; onToggle: () => void; commandId?: CommandId };
  /** An invite email's own HTML repeats the invitation block: it folds behind "Show original" (a text button, no key). */
  original?: { shown: boolean; onToggle: () => void };
  /** The undo-send line under a message you just sent (placement 'thread'). */
  undoTray?: Omit<UndoTrayProps, 'placement'>;
  /** Element ref for `arrive` and scrolling the cursor into view. */
  ref?: Ref<HTMLElement>;
}

/** The 12 px line shown when a body takes past 1.5 s while the previous letter stays: a small Spinner and "Loading Maple Library…" (DESIGN §5 rules 10 and 12, §7.5). Mockups: none drawn. Plain + refines: ui-foundation; used by ui-reader. */
export interface LoadingLineProps {
  /** e.g. "Loading Maple Library…"; also the Spinner's accessible name. */
  label: string;
}

/** The quiet "Reply to Jordan…" field with an R keycap at the end of the thread (DESIGN §6 ReplyStub, §7.5 item 5). Mockups: reader.html, errors.html. Plain + refines: ui-foundation; used by ui-reader. */
export interface ReplyStubProps {
  /** First name in "Reply to <name>…". */
  recipientName: string;
  /** Registry id for R (always shown). */
  commandId: CommandId;
  /** Opens the inline reply. */
  onOpen: () => void;
}

/** "Why it's here", opened from ⋯ or I: one sentence, a quote from the mail, and the ⌥↑ / ⌥↓ lane corrections (DESIGN §6 Why, §9 rule 4). Shown in a Popover. Mockups: none drawn (described in reader.html's ⋯ tooltip). Plain + refines: ui-foundation; used by ui-home, ui-reader. */
export interface WhyProps {
  /** One plain sentence. */
  reason: string;
  /** A quote from the mail. */
  quote?: string;
  /** Current lane; up is disabled at 'do', down at 'low'. */
  lane: Lane;
  /** Registry ids for ⌥↑ and ⌥↓. */
  commands: { up: CommandId; down: CommandId };
  /** Move one lane; the screen toasts "Moved to … · Always do this for … · Undo". */
  onMove: (direction: 'up' | 'down') => void;
}

/** What the undo-send slot is showing (DESIGN §7.6 Send; plan 30 §4.5 #4). */
export type UndoTrayState =
  | {
      /** "Sending to <recipients> in <n> s · Undo Z · Send now" with the neutral drain. */
      kind: 'sending';
      /** Recipient phrase, e.g. "Jordan" or "Jordan and Mina". */
      recipients: string;
      /** Whole seconds left; drives the reduced-motion text countdown. */
      secondsLeft: number;
      /** The undo window (default 8 s; options 0, 5, 8, 10, 20, 30). */
      totalSeconds: number;
    }
  | {
      /** "Couldn’t confirm this was sent. Check Sent, or Send anyway." */
      kind: 'uncertain';
    }
  | {
      /** "Missed its time while your Mac was off. Send now or Reschedule." */
      kind: 'suspended';
    }
  | {
      /** "Couldn't send until <time>. Your draft is saved." */
      kind: 'deferred';
      /** When sending can resume. */
      until: IsoDateTime;
    };

/** Verbs the undo tray can offer. */
export type UndoTrayAction = 'undo' | 'sendNow' | 'checkSent' | 'sendAnyway' | 'reschedule';

/** A `--raised` line under a sent message with the neutral 2 px `undo-send` drain; one notice per send; its inline buttons are Button size 'sm' (DESIGN §6 UndoTray, §7.6). Mockups: reply.html (sent), compose.html (toast). Plain + refines: ui-foundation; used by ui-reader (via ThreadMessage) and ui-shell (via ToastStack). */
export interface UndoTrayProps {
  /** What it says. */
  state: UndoTrayState;
  /** Reduced motion: no drain, a static text countdown instead (DESIGN §4.8 `undo-send`). */
  reducedMotion: boolean;
  /** 'thread' = under the message (ThreadMessage sets it); 'toast' = inside ToastStack when no thread is visible (ToastStack sets it). Screens never set it. */
  placement: 'thread' | 'toast';
  /** Registry id for Undo (Z). */
  undoCommandId: CommandId;
  /** A verb was chosen. */
  onAction: (action: UndoTrayAction) => void;
  /** Announces the countdown start and the outcome (DESIGN §11.3). */
  announce?: Announce;
}
