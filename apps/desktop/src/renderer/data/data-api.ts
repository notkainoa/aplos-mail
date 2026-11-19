/**
 * The typed command surface (`DataApi`) the screens call, and the argument types it uses. Types only: `index.ts`
 * re-exports everything here and implements `api`.
 */

import type { Api as ClientApi } from '@aplos/contract/client';
import type { Id, Input, MethodName, OpId } from './contract-shapes';
import type { ThreadListSelector } from './ui-types';
import type { ActResult } from './index';

/** A command's arguments with its fresh `opId` optional: the data layer mints one when it is absent. */
export type CommandArgs<M extends MethodName> = Omit<Input<M>, 'opId'> & {
  readonly opId?: OpId;
};

/** An interactive AI request's arguments with its `requestId` optional: the data layer mints one when it is absent. */
export type RequestArgs<M extends MethodName> = Omit<Input<M>, 'requestId'> & {
  readonly requestId?: Id;
};

/** The F2 client's own call type for a method (`api.thread.act` for `Thread/act`). */
type ResolvedCall<M extends MethodName> = M extends `${infer T}/${infer V}`
  ? Uncapitalize<T> extends keyof ClientApi
    ? V extends keyof ClientApi[Uncapitalize<T>]
      ? ClientApi[Uncapitalize<T>][V] extends (...args: never[]) => unknown
        ? ClientApi[Uncapitalize<T>][V]
        : never
      : never
    : never
  : never;

/** The client's call for `M`, with its fresh `opId` minted by the data layer when absent; same result as the client's. */
type Command<M extends MethodName> = (args: CommandArgs<M>) => ReturnType<ResolvedCall<M>>;

/** The client's call for `M`, with its fresh `requestId` minted by the data layer when absent. */
type Request<M extends MethodName> = (args: RequestArgs<M>) => ReturnType<ResolvedCall<M>>;

/** `api.thread.act`'s arguments: `Thread/act` with `opId` optional, and a selector only over thread-row specs. Exactly one of `ids` and `selector`. */
export type ThreadActArgs = Omit<Input<'Thread/act'>, 'opId' | 'selector'> & {
  readonly opId?: OpId;
  readonly selector?: ThreadListSelector;
  /** A change the owner did not ask for (opening a thread marks it read): applied and sent like any act, but never put on the undo stack, so Z still undoes the owner's last action. */
  readonly quiet?: boolean;
};

/** `api.operation.undo`'s arguments: `opId` is the operation to undo; `undoOpId`, the inverse's id, is minted by the data layer when absent. */
export type UndoArgs = Omit<Input<'Operation/undo'>, 'undoOpId'> & { readonly undoOpId?: OpId };

/**
 * The typed command surface the screens call. Each group and verb is the F2 client's (`api.<type>.<verb>()` for
 * contract method `Type/verb`), and each member's type is the client's, except that the data layer mints fresh
 * `opId`s and `requestId`s and that the two overlay methods return an `ActResult` synchronously. Reads that have a
 * hook (`View/*`, `T/get`, `Session/get`, `Counts/get`, `Setup/status`) are not here: use the hook.
 */
export interface DataApi {
  /** Threads. */
  readonly thread: {
    /** `Thread/act` with the optimistic overlay applied synchronously: Done, Later, trash, read state, flag, bookmark, due date, reminder, lane, importance, reply state, Home visibility, labels. A `selector` (a whole view or one section past the 200-row window, at the `state` the owner saw) overlays the rows in open windows and the section counts at once; the receipt covers every resolved row. Undoable: joins the undo stack. */
    act(args: ThreadActArgs): ActResult;
    /** `Thread/why`: "Why it's here". */
    readonly why: ClientApi['thread']['why'];
    /** `Thread/open`: the reader opened a thread. Fetches it whole when the row is partial (`complete: false` until then; the full row arrives as a row change) and marks it opened for retention. The reader sends it once per open. */
    readonly open: ClientApi['thread']['open'];
  };
  /** Operations. */
  readonly operation: {
    /** `Operation/undo`: cancel while held (`undoUntil`), else an inverse operation; the overlay applies at once. The receipt's `opId` is the inverse's. */
    undo(args: UndoArgs): ActResult;
    /** `Operation/retry {opId}`: retry an operation the provider refused after its receipt (`Operation.state: 'failed'`). Same `opId`, a `Receipt`, no overlay. An engine-rejected `Thread/act` never created an operation: its Retry is a fresh `thread.act` (`RowFailure.retry`). Prefer `OperationView.retry`, which picks the right one. */
    readonly retry: ClientApi['operation']['retry'];
  };
  /** Sending (`Submission/set`; undo-send and send later are one `notBefore` mechanism, ARCH 7.2). */
  readonly submission: {
    /** One intent per call: `send` (after the undo window, or at `notBefore` for send later; `alsoDone` is ⌘⇧Return, one operation and one notice), `undo`, `sendNow`, `reschedule`, `sendAnyway` (uncertain), `retry` (failed). Watch the result's submission with `useRow('Submission', id)`. */
    readonly set: Command<'Submission/set'>;
  };
  /** Drafts (compare-and-set by `revision`, ARCH 7.4). */
  readonly draft: {
    /** `Draft/set`: create (no `id`) or save with `baseRevision`; rejects with `stateMismatch` on a stale base. `fields.mode` and `replyToMessageId` say reply, reply all or forward; forward copies attachments through `DraftAttachment.source`. */
    readonly set: Command<'Draft/set'>;
    /** `Draft/destroy`: discard; refused while it is sending. */
    readonly destroy: Command<'Draft/destroy'>;
    /** `Draft/resolve`: "This draft changed on another device." keep mine, take theirs, or keep both. */
    readonly resolve: Command<'Draft/resolve'>;
  };
  /** Message bodies. */
  readonly messageBody: {
    /** `MessageBody/get`: one body (prefer `useMessageBody` in components). */
    readonly get: ClientApi['messageBody']['get'];
    /** `MessageBody/prefetch`: warm the engine's body LRU by thread (ARCH AM-1) or message; `cancel: true` cancels. Prefer `usePrefetchIntent`. */
    readonly prefetch: ClientApi['messageBody']['prefetch'];
  };
  /** The sealed mail frame (ARCH 10). */
  readonly mail: {
    /** `Mail/frame`: a single-render frame URL plus host-chrome facts; `imagePolicy: 'block' | 'load'`, `quotesOpen`. The engine applies `mail.imageAllowList`. */
    readonly frame: ClientApi['mail']['frame'];
    /** `Mail/release`: free a frame token when the reader replaces it. */
    readonly release: ClientApi['mail']['release'];
    /** `Mail/toggleQuotes`: O in the reader; returns the re-rendered frame. */
    readonly toggleQuotes: ClientApi['mail']['toggleQuotes'];
    /** `Mail/allowImages`: "Load images from this sender" (an address or `@domain`), or remove it; re-request the frame afterwards. */
    readonly allowImages: Command<'Mail/allowImages'>;
  };
  /** Attachments. */
  readonly attachment: {
    /** `Attachment/get`: makes the bytes available as a blob; then `api.blob.get`. */
    readonly get: ClientApi['attachment']['get'];
  };
  /** Bytes, both ways, never base64: a transferable `Uint8Array` on MessagePort, a blob route over HTTP. */
  readonly blob: {
    /** `Blob/put`: upload (Attach a file, ⌘⇧A; dictation audio), 25 MB at most; pass the buffer in `options.transfer`. Put the `blobId` in a `DraftAttachment` or `Ai/transcribe`. */
    readonly put: ClientApi['blob']['put'];
    /** `Blob/get`: read a blob's bytes. */
    readonly get: ClientApi['blob']['get'];
    /** `Blob/release`: free a blob the window owns once it no longer needs it. */
    readonly release: ClientApi['blob']['release'];
  };
  /** Sync control. */
  readonly sync: {
    /** `Sync/request`: a manual refresh; `force` is "Retry now" on a throttle pause (once per pause). */
    readonly request: ClientApi['sync']['request'];
  };
  /** Accounts. Flows return a `connectId` at once and report through `connect` frames (`useFrames('connect', {connectId})`). */
  readonly account: {
    /** `Account/discover {address | domain}`: which provider an address belongs to, with preset server settings (Add account). Round 1 connects Google only. */
    readonly discover: ClientApi['account']['discover'];
    /** `Account/disconnect {accountId}`: remove an account and everything Aplos stored for it; refused while one of its messages is sending. Not undoable (its receipt says so); a refusal marks the operation failed and rethrows the engine's error. */
    readonly disconnect: Command<'Account/disconnect'>;
    /** `Account/lease {accountId?, pin}`: "Use this Mac" for background work, or back to automatic; every account when `accountId` is absent. */
    readonly lease: ClientApi['account']['lease'];
    /** `Account/connect`: connect a new account (onboarding, Settings → Add account). */
    readonly connect: ClientApi['account']['connect'];
    /** `Account/reconnect`: the weekly reconnect, with `login_hint`; no resync, queued changes kept (roadmap N3). */
    readonly reconnect: ClientApi['account']['reconnect'];
    /** `Account/grantPermissions`: full re-consent for missing scopes (`needsPermission`). */
    readonly grantPermissions: ClientApi['account']['grantPermissions'];
    /** `Account/cancelConnect`: the sheet's Cancel; a late answer is then ignored. */
    readonly cancelConnect: ClientApi['account']['cancelConnect'];
    /** `Account/set`: name, colour, notifications, and "Use this account's mail for AI" (`aiAllowed`). */
    readonly set: Command<'Account/set'>;
  };
  /** First-sync session (`Setup/*`); the UI calls `end` on every window close. */
  readonly setup: {
    /** `Setup/begin {origin}` → `{setupId}`. */
    readonly begin: ClientApi['setup']['begin'];
    /** `Setup/end {setupId?, reason}`; idempotent. */
    readonly end: ClientApi['setup']['end'];
    /** `Setup/retry`: first sync's "Try again" for one account (DESIGN 7.12); idempotent, resumes from the checkpoint. */
    readonly retry: ClientApi['setup']['retry'];
  };
  /** Demo mail on request (plan 30 8.1 item 11). */
  readonly demo: {
    /** `Demo/load`. */
    readonly load: ClientApi['demo']['load'];
    /** `Demo/reset`. */
    readonly reset: ClientApi['demo']['reset'];
    /** `Demo/remove`. */
    readonly remove: ClientApi['demo']['remove'];
  };
  /** Settings. */
  readonly settings: {
    /** `Settings/get` (prefer `useSettings` in components). */
    readonly get: ClientApi['settings']['get'];
    /** `Settings/set`: a patch per section; object-valued fields (`dock`, `keymap`, `palette`, `calendar`, `features`) are replaced whole; `ifInState` makes it compare-and-set. */
    readonly set: Command<'Settings/set'>;
  };
  /** Ask (DESIGN 7.7). Progress streams as `progress` frames (`useFrames('progress', {runId})`); the answer lands in the `Conversation`. */
  readonly ask: {
    /** `Ask/run` → `{runId, conversationId}` at once. `scope.searchAllMail` is ⌘Return. */
    readonly run: ClientApi['ask']['run'];
    /** `Ask/cancel`: Esc; the partial answer is kept and the turn says `stopped`. */
    readonly cancel: ClientApi['ask']['cancel'];
    /** `Ask/decide {conversationId, turnId, proposalId, accept}`: accept or dismiss something Ask proposed (a reply, an event, a triage). Accepting returns the receipt, and joins the one undo stack unless it says it cannot be undone; `draftId` and `eventId` name what accepting made. */
    readonly decide: Command<'Ask/decide'>;
    /** `Ask/suggestions`: three plain suggested questions for the empty Ask panel. */
    readonly suggestions: ClientApi['ask']['suggestions'];
  };
  /** Ask conversations (read them with `useView({kind: 'conversations'})` and `useRow('Conversation', id)`). */
  readonly conversation: {
    /** `Conversation/destroy {id}`: delete a conversation. Undoable: joins the undo stack (Operation/undo brings it back). */
    readonly destroy: Command<'Conversation/destroy'>;
  };
  /** Calendars (Aplos-side visibility and colour; never written to the provider). */
  readonly calendar: {
    /** `Calendar/get {accountId?}`: calendars with Aplos-side visibility and colour. */
    readonly get: ClientApi['calendar']['get'];
    /** `Calendar/set {id, shown?, colorTag?}`: show or hide a calendar, or change its colour. Undoable. */
    readonly set: Command<'Calendar/set'>;
  };
  /** Events (read them with `useAgenda` and `useRow('Event', id)`). */
  readonly event: {
    /** `Event/set {change, notify?}`: create, edit or delete an event, for one occurrence, the series or the following ones. May email guests, so the engine holds it briefly: the receipt's `undoUntil` says until when Operation/undo cancels it. Joins the undo stack. */
    readonly set: Command<'Event/set'>;
    /** `Event/hide {ids, hidden}`: hide events in Aplos only (the event detail's Hide), or show them again; never written to the provider, so nobody is told. Joins the undo stack. */
    readonly hide: Command<'Event/hide'>;
    /** `Event/rsvp {id, response, scope, notify?}`: answer an invitation for one occurrence or the series. Joins the undo stack. */
    readonly rsvp: Command<'Event/rsvp'>;
  };
  /** Plans found in mail (dates and meetings waiting to be confirmed; read them with `useRow('Plan', id)`). */
  readonly plan: {
    /** `Plan/confirm {id, calendarId?, fields?}`: add a plan to a calendar, with optional edits; `eventId` names the new event. Joins the undo stack. */
    readonly confirm: Command<'Plan/confirm'>;
    /** `Plan/dismiss {ids}`: dismiss plans. Joins the undo stack. */
    readonly dismiss: Command<'Plan/dismiss'>;
  };
  /** "Allow tools on this Mac": the local socket and loopback HTTP listener (Settings → Tools; UI-only methods). */
  readonly listener: {
    /** `Listener/get`: whether the listener is on, and where. */
    readonly get: ClientApi['listener']['get'];
    /** `Listener/set {enabled}`: turn the listener on or off. */
    readonly set: ClientApi['listener']['set'];
  };
  /** Tools allowed on this Mac (Settings → Tools; UI-only methods). Tokens never cross the contract. */
  readonly clients: {
    /** `Clients/list`: tools allowed on this Mac. */
    readonly list: ClientApi['clients']['list'];
    /** `Clients/grant {name, kind, scopes}`: allow a tool with scopes. */
    readonly grant: ClientApi['clients']['grant'];
    /** `Clients/revoke {id}`: revoke a tool. */
    readonly revoke: ClientApi['clients']['revoke'];
    /** `Clients/audit {clientId?, limit?}`: sends, deletes and settings changes made by tools. */
    readonly audit: ClientApi['clients']['audit'];
  };
  /** The queue inspector (Settings → Queue): ops, AI jobs and submissions, content-free. */
  readonly queue: {
    /** `Queue/list {kinds?}`. */
    readonly list: ClientApi['queue']['list'];
    /** `Queue/retry {id}`: retry a queued item now. */
    readonly retry: ClientApi['queue']['retry'];
    /** `Queue/discard {id}`: discard a queued item. */
    readonly discard: ClientApi['queue']['discard'];
  };
  /** Windows, served by main (preload routes them past the engine). */
  readonly window: {
    /** `Window/openOnboarding {mode}`: open the onboarding window, first run (`first`) or "Show welcome" (`review`) beside the mail window. */
    readonly openOnboarding: ClientApi['window']['openOnboarding'];
    /** `Window/finishOnboarding`: hand over from onboarding to the mail window. */
    readonly finishOnboarding: ClientApi['window']['finishOnboarding'];
    /** `Window/closeReady`: answers main's `prepare-close` once unsaved work is saved; main then closes the window. */
    readonly closeReady: ClientApi['window']['closeReady'];
    /** `Window/closeCancel`: tells main the close could not be prepared, so it re-enables the window. */
    readonly closeCancel: ClientApi['window']['closeCancel'];
  };
  /** In-app updates, served by main: it downloads quietly and installs only on `restart`. */
  readonly update: {
    /** `Update/status`: the update state (disabled, checking, downloading, ready, ...). */
    readonly status: ClientApi['update']['status'];
    /** `Update/check`: check for an update now. */
    readonly check: ClientApi['update']['check'];
    /** `Update/restart`: restart to install the ready update. */
    readonly restart: ClientApi['update']['restart'];
    /** `Update/later`: hide the ready update until the next check or launch. */
    readonly later: ClientApi['update']['later'];
  };
  /** macOS facts and permissions, served by main. */
  readonly system: {
    /** `System/login {enabled?}`: read, or set, whether Aplos opens at login. */
    readonly login: ClientApi['system']['login'];
    /** `System/defaultMail`: make Aplos the default mail app. */
    readonly defaultMail: ClientApi['system']['defaultMail'];
    /** `System/microphone {check?}`: microphone permission, checked without the macOS prompt or asked for. */
    readonly microphone: ClientApi['system']['microphone'];
    /** `System/notifications`: notification permission as far as macOS reports it. */
    readonly notifications: ClientApi['system']['notifications'];
    /** `System/openSettings {pane}`: open the System Settings pane for a permission Aplos needs. */
    readonly openSettings: ClientApi['system']['openSettings'];
  };
  /** Links, served by main (through its `external()` gate: http, https or mailto, no credentials; anything else is refused). */
  readonly shell: {
    /** `Shell/open {url}`: open a link outside Aplos, such as an event's meeting link. */
    readonly open: ClientApi['shell']['open'];
  };
  /** Notifications, served by main. */
  readonly notification: {
    /** `Notification/test`: post a test notification. */
    readonly test: ClientApi['notification']['test'];
  };
  /** Remote search (DESIGN 7.9): local results come from the open `search` window as the owner types; Return asks the provider once. */
  readonly search: {
    /** `Search/remote {query, accountId?}` → `{runId, receipt}` at once. Progress follows as `progress` frames with `source: 'search'` (`useFrames('progress', {runId})`); the server's results join the open `useView({kind: 'search', query})` window with the same query, and a paused or unavailable provider shows as that window's `error`. */
    readonly remote: Command<'Search/remote'>;
  };
  /** Interactive AI. */
  readonly ai: {
    /** `Ai/providers`: Settings → AI's provider table: status and where each key comes from, never the key. */
    readonly providers: ClientApi['ai']['providers'];
    /** `Ai/models {provider}`: a provider's models; local servers are asked live, hosted ones fall back to the curated list offline (`live` says which). */
    readonly models: ClientApi['ai']['models'];
    /** `Ai/status`: whether each AI feature is ready, and why not. */
    readonly status: ClientApi['ai']['status'];
    /** `Ai/usage`: today's AI use against the daily background cap. */
    readonly usage: ClientApi['ai']['usage'];
    /** `Ai/setKey {provider, key}`: save a provider key to the Keychain-backed vault; never echoed back, never logged. */
    readonly setKey: ClientApi['ai']['setKey'];
    /** `Ai/removeKey {provider}`: remove a saved key; refused for a key from the backend environment. */
    readonly removeKey: ClientApi['ai']['removeKey'];
    /** `Ai/testKey {provider}`: one cheap request with the provider's current key. No mail is sent. */
    readonly testKey: ClientApi['ai']['testKey'];
    /** `Ai/request`: queue a summary (or classify, plan, suggest action) for a thread; the result arrives as a row change. */
    readonly request: Command<'Ai/request'>;
    /** `Ai/draft`: write a draft or reply from an instruction, as a suggestion at the caret. */
    readonly draft: Request<'Ai/draft'>;
    /** `Ai/polish`: suggested edits to a draft's html, never applied by themselves; the composer diffs `html` against its own. */
    readonly polish: Request<'Ai/polish'>;
    /** `Ai/transcribe`: speech to text from a blob uploaded with `api.blob.put`. */
    readonly transcribe: Request<'Ai/transcribe'>;
    /** `Ai/followup`: the Follow up nudge for a thread, absent with AI off, without consent or not ready (`ThreadRow.follow.suggestion` says one is ready). */
    readonly followup: ClientApi['ai']['followup'];
    /** `Ai/dismissFollowup`: dismiss the Follow up nudge for a thread. */
    readonly dismissFollowup: Command<'Ai/dismissFollowup'>;
    /** `Ai/cancel {requestId?}`: Esc during `draft`, `polish` or `transcribe`, naming the request's `requestId`; absent cancels every interactive request. Ask's own Esc is `ask.cancel`. */
    readonly cancel: ClientApi['ai']['cancel'];
  };
  /** Unsubscribe. */
  readonly unsubscribe: {
    /** `Unsubscribe/run`: one-click or mailto where offered, else `outcome: 'openLink'` with an https link to review. */
    readonly run: Command<'Unsubscribe/run'>;
  };
  /** Background-AI consent (ARCH 8.3); the record is `Consent`, not a settings field. */
  readonly consent: {
    /** `Consent/get` (prefer `useConsent` in components). */
    readonly get: ClientApi['consent']['get'];
    /** `Consent/grant`: Allow on the consent card, naming the version, provider and model shown. "Not now" records nothing. */
    readonly grant: ClientApi['consent']['grant'];
    /** `Consent/revoke`: Settings → AI; background AI stops. */
    readonly revoke: ClientApi['consent']['revoke'];
  };
  /** The engine process, through main (it answers when the engine cannot). */
  readonly engine: {
    /** `Engine/restart`: "Restart engine" on the unreachable FatalScreen and "Try again" when parked; `useConnection` reports the outcome. */
    readonly restart: ClientApi['engine']['restart'];
  };
  /** The content-free diagnostics bundle (ARCH 11). */
  readonly diagnostics: {
    /** `Diagnostics/preview`: the `DiagnosticsBundle` for the preview Dialog; the renderer formats it. */
    readonly preview: ClientApi['diagnostics']['preview'];
    /** `Diagnostics/copy` (main): copies the engine's bundle, or main's host-only one when the engine is unreachable or parked. */
    readonly copy: ClientApi['diagnostics']['copy'];
    /** `Diagnostics/export`: the same bundle as a file blob; pass it to `api.file.save`. */
    readonly export: ClientApi['diagnostics']['export'];
    /** `Diagnostics/verbose {on}`: the verbose protocol log (headers only), off by itself at `until`. */
    readonly verbose: ClientApi['diagnostics']['verbose'];
  };
  /** Recipient type-ahead (To, Cc, Bcc). */
  readonly contact: {
    /** `Contact/suggest {query, accountId?, limit?}`: addresses you have written to or heard from, matching the start of a name or address. Local data only. */
    readonly suggest: ClientApi['contact']['suggest'];
  };
  /** Your own data (Settings → Help & about; UI-only method). */
  readonly data: {
    /** `Data/export`: accounts, settings, drafts and conversations as a file blob, no credentials; pass it to `api.file.save`. */
    readonly export: ClientApi['data']['export'];
  };
  /** Device sync (Settings → Connected tools; not available yet). */
  readonly workflow: {
    /** `Workflow/status`: whether device sync is on and available. */
    readonly status: ClientApi['workflow']['status'];
    /** `Workflow/enable {code?}`: turn on device sync. */
    readonly enable: ClientApi['workflow']['enable'];
    /** `Workflow/code`: the pairing code for another Mac. */
    readonly code: ClientApi['workflow']['code'];
    /** `Workflow/disable`: turn off device sync. */
    readonly disable: ClientApi['workflow']['disable'];
  };
  /** Files, served by main. */
  readonly file: {
    /** `File/save {blobId, name}`: the save dialog, then the blob's bytes to the chosen path. */
    readonly save: ClientApi['file']['save'];
  };
}
