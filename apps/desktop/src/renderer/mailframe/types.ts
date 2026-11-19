// The MailFrame contract (plan 30 section 4.4, lane card ui-reader). The five props are frozen by the lane card;
// the shapes they carry are defined here because renderer/ui/props has no MailFrame type.

import type { QuotedRange } from './quoted';

/** Remote images: `block` (default, no network at all) or `load` (https images only, tracking pixels still removed). */
export type ImagePolicy = 'block' | 'load';

/** What the host learns when a letter is laid out and measured. Sent once per letter. */
export interface MailFrameReady {
  /** Body height in CSS px, an integer clamped to 1-200,000. The frame never scrolls; the reader does. */
  height: number;
  /**
   * The paper tint behind the body: a strict `#rrggbb` string. HTML mail sits on light paper, so a missing or
   * unparsable colour falls back to the light paper token. Plain text follows the theme and reports `transparent`.
   */
  bg: string;
  /** Remote resources removed or blocked in this letter: every remote image the policy refused, tracking pixels included. Additive to `{height, bg}`. */
  blocked: number;
  /**
   * Tracking pixels among them: the "N trackers removed" count (a refused remote image is not a tracker). Additive;
   * absent from a host that cannot tell, in which case the reader says nothing about trackers.
   */
  trackers?: number;
}

/** One unmodified key from the frames' short list pressed while focus is inside the letter (PROTOCOL.md "Keys"). */
export interface MailFrameKey {
  /** `KeyboardEvent.key`, one of `FALLBACK_KEYS`: e.g. `j`, `J`, `Escape`, `ArrowDown`, `End`. Never R, E or Space. */
  key: string;
  /** Shift was held. */
  shift: boolean;
  /** Alt (Option) was held. */
  alt: boolean;
}

/** Props of `MailFrame`, the one host for a message body (sandboxed iframe for HTML, escaped host DOM for text). */
export interface MailFrameProps {
  /** The message whose body to show. Changing it double-buffers: the previous letter stays until the new one reports. */
  messageId: string;
  /** The loading line's words once the letter has been awaited 1.5 s ("Loading <subject or sender>…"). Default: "Loading this email…". */
  label?: string;
  /** Remote images policy for this render; changing it re-renders through the same buffer. */
  imagePolicy: ImagePolicy;
  /** Find-in-message query; matches are wrapped in `<mark>`. Empty or undefined shows no marks. */
  findQuery?: string;
  /** Plain text only: draw its quoted history as a quiet block (O, "Show quoted text"). Additive; default hidden. */
  showQuoted?: boolean;
  /** The new letter is measured and on screen. */
  onReady: (ready: MailFrameReady) => void;
  /**
   * A key from the short list (J/K, arrows, Page Up/Down, Home, End, Esc) pressed with focus inside the letter, relayed
   * once to the shell's shortcut registry. Return true when the shell handled it: the host then prevents the frame's
   * default.
   */
  onKey: (key: MailFrameKey) => boolean | void;
}

/** One letter ready to mount, as the data layer delivered it. `key` changes whenever the letter must re-render. */
export type FrameSource =
  | {
      /** Stand-in engine: the HTML the host sanitises into a scriptless `srcdoc` frame. */
      kind: 'srcdoc';
      key: string;
      html: string;
      imagePolicy: ImagePolicy;
      findQuery?: string;
      /** The `Mail/frame` URL to release when this letter leaves. */
      url?: string;
    }
  | {
      /** The sealed `aplos-mail://m/<token>` frame, sized by its reporter's messages. */
      kind: 'url';
      key: string;
      url: string;
      token: string;
      /** `MailFrame.trackersRemoved` from the engine. */
      blocked: number;
    }
  | {
      /** Plain text: escaped host DOM, no frame. */
      kind: 'text';
      key: string;
      text: string;
      /** Quoted history in `text` (the engine's ranges, else the `>` lines); hidden until `showQuoted`. Additive. */
      quoted?: readonly QuotedRange[];
    };
