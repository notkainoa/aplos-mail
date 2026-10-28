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

/** The reader's sender, with hover details (DESIGN §7.5 item 1). */
export interface SenderInfo {
  /** Name in `title`. */
  name: string;
  /** Address, shown on hover. */
  address: string;
  /** Receiving account, shown on hover. */
  accountLabel: string;
  /** History with this sender, labelled as history, e.g. "14 emails both ways since March". */
  history?: string;
}

/** The reader's top: sender line, the big serif summary, one action row; no monogram, no card (DESIGN §6 ReaderHead, §7.5 items 1–3). Mockups: reader.html, reply.html, errors.html (send-failed). Plain + refines: ui-foundation; used by ui-reader. */
export interface ReaderHeadProps {
  /** Sender and hover details. */
  sender: SenderInfo;
  /** `--dim` recipients phrase, e.g. "to you and Mina Cho". */
  recipientsLabel: string;
  /** Due chip on the right, sentence format. */
  due?: DueInfo;
  /** Time on the right. */
  date: IsoDateTime;
  /** Summary slot; never clamped here. */
  summary: SummaryContent;
  /** The filled suggestion with Space, then Later and Done. */
  suggestion: SuggestedAction;
  /** Registry ids for the three controls; ⋯ lives in the pane header. */
  commands: ReaderTriageCommands;
  /** The inline reply or another top surface owns the filled button (DESIGN §7.6). */
  demoted: boolean;
  /** Suggestion button. */
  onSuggestion: () => void;
  /** Later button; the element anchors DatePresets. */
  onLater: (anchor: HTMLElement) => void;
  /** Done button. */
  onDone: () => void;
  /** Element ref for the reader-column flight ghost (DESIGN §4.9). */
  ref?: Ref<HTMLElement>;
}

/** An earlier message as a 36 px one-liner. */
export interface CollapsedMessage {
  /** Message id. */
  id: string;
  /** Sender name, or "You". */
  from: string;
  /** First line of the message. */
  preview: string;
  /** Sent time. */
  date: IsoDateTime;
}

/** One collapsed line for earlier messages ("3 earlier messages from Jordan, you and Mina"); O expands into 36 px one-liners with a 2 px accent rail on the cursor (DESIGN §6 EarlierMessages, §7.5 item 4). Mockups: reader.html (earlier). Plain + refines: ui-foundation; used by ui-reader. */
export interface EarlierMessagesProps {
  /** Number of earlier messages. */
  count: number;
  /** First names in thread order, "you" for the owner; joined by the component. */
  participants: readonly string[];
  /** Expanded into one-liners. */
  expanded: boolean;
  /** The one-liners shown when expanded. */
  messages: readonly CollapsedMessage[];
  /** The thread cursor: the one message id the ↑/↓ rail is on, shared with ThreadMessage (`cursor` = this id). */
  cursorId?: string;
  /** Registry id for O. */
  commandId: CommandId;
  /** Expand or collapse. */
  onToggle: () => void;
  /** Open one message. */
  onOpenMessage: (id: string) => void;
}

/** A remote-images notice on a message (DESIGN §7.5 HTML mail). */
export interface RemoteImages {
  /** Remote images are blocked: shows "Load images from this sender". */
  blocked: boolean;
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
  /** Sent time. */
  date: IsoDateTime;
  /** Holds the thread cursor (the one cursor id shared with EarlierMessages): the accent rail shows. */
  cursor: boolean;
  /** The message body from `renderer/mailframe` (sandboxed iframe or plain text). */
  body: ReactNode;
  /** Attachment chips under the body. */
  attachments?: readonly Extract<ChipProps, { kind: 'attachment' }>[];
  /** Remote images notice, when the mail has any. */
  remoteImages?: RemoteImages;
  /** Quoted text toggle (O also shows quoted text). */
  quoted?: { shown: boolean; onToggle: () => void; commandId: CommandId };
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
      /** "We could not confirm this was sent. Check Sent, or Send anyway." */
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
