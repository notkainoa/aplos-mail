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
  /** Quoted-history `<details>` start open (`Mail/frame.quotesOpen`, `Mail/toggleQuotes`); closed by default. */
  quotesOpen?: boolean;
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
 * bundled outside the engine core budget); called by the `Mail/frame` render pipeline (`methods/mail.ts`). Pure and
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

// ---- the image proxy (ARCH 10, plan 10 E4 item 6) ----

/** Why the proxy refused an image; the frame keeps the sized placeholder and the reason goes to the log only. */
export type ImageRefusal =
  | 'scheme' // not http or https
  | 'port' // not 80 or 443
  | 'address' // a resolved address is loopback, private, link-local, CGNAT, ULA, multicast, unspecified, benchmarking, or a mapped/NAT64 form of one
  | 'redirects' // more than 3, or one that failed the same checks
  | 'size' // over `IMAGE_PROXY_LIMITS.maxBytes` or `maxPixels`
  | 'type' // not PNG, JPEG, GIF or WebP by its leading bytes (never SVG)
  | 'budget' // the token's request budget is spent
  | 'timeout'
  | 'http'; // any other non-2xx answer or network failure

export type ProxiedImage =
  | {
      kind: 'image';
      mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      bytes: Uint8Array;
    }
  | { kind: 'refused'; reason: ImageRefusal };

/** The proxy's caps, frozen as upper bounds: an implementation may tighten them, never loosen them. */
export const IMAGE_PROXY_LIMITS = {
  maxRedirects: 3,
  maxBytes: 10_000_000,
  /** Width times height read from the image header, before decoding. */
  maxPixels: 40_000_000,
  /** The whole fetch, redirects included. */
  timeoutMs: 10_000,
  /** Requests per render token. */
  perToken: 100,
  ports: [80, 443],
} as const;

/**
 * Fetches one remote image for `Mail/serve`'s `img/<n>` route, only for a token rendered with `imagePolicy: 'allow'`.
 * Implemented by `eng-html` as a host adapter (`apps/desktop/src/host/`, Node networking; never in the neutral core);
 * called by the `Mail/serve` handler (`methods/mail.ts`) with the URL from `MailHtmlResult.remoteImages`. Rules:
 * resolve DNS once and refuse when ANY answer is in a refused range, then connect to that checked address with the
 * original name as SNI and `Host` (no second lookup, so a rebinding resolver cannot swap it); follow redirects by hand,
 * each one re-checked from scratch; send no cookies, credentials, `Referer` or client headers; check the type from the
 * bytes, not `Content-Type`. Never throws for a refusal: it resolves `refused`, and aborts with `signal`.
 *
 * The `img/<n>` route that serves the result (`Mail/serve`, not written yet) MUST answer with `Content-Type` set from the
 * sniffed `mime` (never from the sender), `X-Content-Type-Options: nosniff`, and no header taken from the remote
 * response. Do the same for every route that serves bytes a stranger chose.
 */
export interface ImageProxy {
  fetch(url: string, opts: { token: string; signal: AbortSignal }): Promise<ProxiedImage>;
}

/** What an unsubscribe attempt came to; the `Unsubscribe/run` handler maps each kind to a contract outcome. */
export type UnsubscribeKind = 'done' | 'unsure' | 'failed' | 'open' | 'compose' | 'none';

/**
 * Plans and performs one List-Unsubscribe (RFC 2369 / RFC 8058) for `Unsubscribe/get` and `Unsubscribe/run`.
 * Implemented by the host (`apps/desktop/src/host/providers/google/unsubscribe.ts`, Node networking; never in the
 * neutral core) and injected as `HostPorts.unsubscribe`; the `Unsubscribe/*` handlers (`methods/unsubscribe.ts`) call
 * it with the headers of the thread's newest authenticated inbound message that carries List-Unsubscribe, else the
 * newest such message (`ListHeaders.authenticated`). For a message that is not authenticated the engine passes the
 * headers without `listUnsubscribePost`, so only the owner-visible ways (the mailto the owner reviews, the page the
 * owner opens) remain; an executor must still plan one-click only when `headers.authenticated === true`.
 * - `describe` is pure and offline: it reads the headers and names the way the sender offers (`url` for a link or
 *   mailto), with no network and no side effect.
 * - `run` performs the one-click POST, or plans the mailto or the link, in the host. It must honour `signal`, and it
 *   never throws for an ordinary refusal: a sender that refuses or errors resolves `failed`, a sender whose answer does
 *   not confirm the request resolves `unsure`. `open` carries the `url` to show for review; `compose` carries the
 *   mailto `url` for the owner to review and send; `none` means no usable way. The SSRF rules (address ranges,
 *   redirects, no cookies) are the host's, as for `ImageProxy`. When `signal` aborts, `run` rejects with `signal.reason`
 *   and stops any request in flight.
 */
export interface UnsubscribePort {
  describe(headers: ListHeaders): { method: 'oneClick' | 'mailto' | 'link' | 'none'; url?: string };
  run(request: {
    from: string;
    headers: ListHeaders;
    /** The caller's `opId` for this attempt, when it sent one; the same value on a retry. Not a secret. */
    opId?: string;
    signal: AbortSignal;
  }): Promise<{ kind: UnsubscribeKind; message: string; url?: string }>;
}
