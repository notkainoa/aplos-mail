import type { Address, FolderRole, ListHeaders, MessageFlags } from './provider';

// Content ports: the data key, the HTML sanitizer and Home's heuristic lanes.

/** Today's `EngineInit.key` / `keyError`, as one value. */
export type DataKey = { kind: 'key'; key: Uint8Array } | { kind: 'unavailable'; reason: string };

/**
 * The data key that seals credentials and the workflow channel, unwrapped by the macOS Keychain. Implemented by
 * `eng-host` (main unwraps it and hands it over at engine start; a future LaunchAgent engine would read the Keychain
 * itself, ARCH 2.6). Called by the vault and workflow crypto. The key never leaves engine memory and is never logged.
 */
export interface KeyProvider {
  dataKey(): Promise<DataKey>;
}

/** One body to render, from the stored original (ARCH 3.3). */
export interface MailHtmlInput {
  html?: string;
  text?: string;
  /** Inline parts' Content-IDs; `cid:<cids[n]>` is rewritten to the relative `cid/<n>`. */
  cids: string[];
  /** `block` (the default, Decision 8) keeps sized placeholders; `allow` rewrites remote images to the relative `img/<n>`. */
  imagePolicy: 'block' | 'allow';
  findQuery?: string;
}

/**
 * The sanitized result. URLs are relative to `aplos-mail://m/<token>/`, so the output does not depend on the token and
 * the LRU of 12 rendered bodies can be keyed by message, policy, query and `MailHtml.version`.
 */
export type MailHtmlResult = {
  /** Remote image URLs by index n (`img/<n>`), for the image proxy to fetch when allowed. */
  remoteImages: string[];
  hasRemoteImages: boolean;
  trackersRemoved: number;
  /** Quoted-history blocks wrapped in `<details>`. */
  quotedCount: number;
  /** Find `<mark>`s injected. */
  marks: number;
} &
  /** A complete document with reading CSS, for the sealed frame. */
  (
    | { bodyKind: 'html'; document: string }
    /** Plain-text mail: the host escapes it into its own DOM, no frame. */
    | { bodyKind: 'text'; text: string }
  );

/**
 * The allowlist sanitizer (ARCH 10). Implemented by `eng-html` in `packages/mail-html` (pure JS, no DOM, no Node,
 * bundled outside the 400 KB core); called by the `Mail/frame` render pipeline (`methods/mail.ts`). Pure and
 * synchronous: the same input and version always give the same output.
 */
export interface MailHtml {
  /** Part of every cache key, so a sanitizer fix reaches old mail. */
  readonly version: string;
  render(input: MailHtmlInput): MailHtmlResult;
}

// ---- Home lanes (ARCH 8.2) ----

export type HomeLane = 'do' | 'update' | 'low';
export type Importance = 'important' | 'normal';

/** ARCH 5.1's nine headers (From, To, Cc, Subject, Date, Message-ID, List-Unsubscribe, Precedence, Auto-Submitted) plus what Home also reads. */
export interface LaneMessage {
  from?: Address;
  to: Address[];
  cc: Address[];
  subject?: string;
  date: number;
  internetId?: string;
  list: ListHeaders;
  snippet?: string;
  flags: MessageFlags;
  /** Roles of the folders the message is in: `important` and the `category.*` tabs are what `laneFor` reads. */
  roles: FolderRole[];
}

/** Calendar invitation or structured markup (delivery, reservation, bill) found once a body is present. */
export interface StructuredHint {
  kind: 'invite' | 'delivery' | 'reservation' | 'bill';
  final?: boolean;
  due?: string;
}

export interface LaneInput {
  /** The thread's newest inbound message. */
  message: LaneMessage;
  /** The account's own addresses, for direct versus cc. */
  self: string[];
  /** `correspondents.sent_to > 0` for the sender. */
  knownCorrespondent: boolean;
  /** The user has a message in the thread. */
  userReplied: boolean;
  /** The user sent the thread's last message (the "Of course!" close). */
  userEndedThread: boolean;
  structured?: StructuredHint[];
  /** Body text when one is stored (capped), so `laneFor` re-runs after a body fetch. */
  text?: string;
}

/** `due` is a calendar date (`YYYY-MM-DD`) stored with `due_source='structured'`. */
export interface LaneResult {
  lane: HomeLane;
  importance: Importance;
  due?: string;
}

/**
 * Pure and deterministic. Implemented by `eng-ai` (`ai/lanes.ts`); called by the store's ingest inside the sync commit
 * (stored with `rank_source='heuristic'`) and again after a body fetch. Never waits for AI; rule and user choices win.
 */
export type LaneFor = (input: LaneInput) => LaneResult;
