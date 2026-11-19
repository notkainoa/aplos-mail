import * as z from 'zod/mini';
import { area } from '../registry/define';
import {
  bool,
  Bytes,
  choice,
  Count,
  Empty,
  EpochMs,
  getResult,
  GetInput,
  Id,
  Ids,
  line,
  Ok,
  OpId,
  Receipt,
  SenderMatch,
  State,
  text,
} from '../schemas/common';
import { Counts, Folder } from '../schemas/account';
import {
  MailFrame,
  Message,
  MessageBody,
  Operation,
  SearchQuery,
  SenderGroup,
  ThreadAction,
  ThreadRow,
  ThreadSelector,
  ViewSpec,
  WindowAnchor,
  WindowBody,
  WhyItsHere,
} from '../schemas/mail';

const limit = z.optional(z.int().check(z.minimum(1), z.maximum(200)));

export const view = area('view', {
  'View/watch': {
    summary:
      'Open a live window of at most 200 ids over a view; later changes arrive as `window` frames. `holdIds` stay in place.',
    kind: 'query',
    scope: 'read',
    input: z.object({
      spec: ViewSpec,
      holdIds: z.optional(Ids(200)),
      anchor: z.optional(WindowAnchor),
      limit,
    }),
    output: WindowBody,
  },
  'View/move': {
    summary: 'Scroll a window to a position or anchor, or, for events windows, to another range.',
    kind: 'query',
    scope: 'read',
    input: z.object({
      windowId: Id,
      anchor: z.optional(WindowAnchor),
      limit,
      range: z.optional(z.object({ from: EpochMs, to: EpochMs })),
    }),
    output: WindowBody,
  },
  'View/unwatch': {
    summary: 'Close a window.',
    kind: 'query',
    scope: 'read',
    input: z.object({ windowId: Id }),
    output: Ok,
  },
  'View/hold': {
    summary:
      'Keep these rows in place (the row under the cursor and its neighbours) until released or about 2 s after the last activity; calling it again is the activity ping.',
    kind: 'query',
    scope: 'read',
    input: z.object({ windowId: Id, ids: Ids(200) }),
    output: Ok,
  },
  'View/release': {
    summary: 'Release held rows (all when `ids` is absent); the window then reconciles.',
    kind: 'query',
    scope: 'read',
    input: z.object({ windowId: Id, ids: z.optional(Ids(200)) }),
    output: Ok,
  },
  'View/query': {
    summary: 'A one-shot read of a view (CLI, MCP, Today, Home\'s "Next:"); no window stays open.',
    kind: 'query',
    scope: 'read',
    input: z.object({ spec: ViewSpec, anchor: z.optional(WindowAnchor), limit }),
    output: z.object({ ...WindowBody.shape, windowId: z.optional(Id) }),
  },
  'Folder/get': {
    summary: 'Labels and folders with unread thread counts.',
    kind: 'query',
    scope: 'read',
    input: z.object({ accountId: z.optional(Id) }),
    output: z.object({ state: State, list: z.array(Folder) }),
  },
  'Counts/get': {
    summary: 'Sidebar counts for every account and each one.',
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: Counts,
  },
  'SenderGroup/get': {
    summary: 'Rows of a `lowSenders` window.',
    kind: 'query',
    scope: 'read',
    input: GetInput,
    output: getResult(SenderGroup),
  },
  'Search/remote': {
    summary:
      'Search the provider once, on Return only; results join the matching search window, progress arrives as `progress` frames.',
    kind: 'command',
    scope: 'read',
    input: z.object({ opId: OpId, query: SearchQuery, accountId: z.optional(Id) }),
    output: z.object({ runId: Id, receipt: Receipt }),
  },
});

export const thread = area('thread', {
  'Thread/get': {
    summary: 'Body-free thread rows.',
    kind: 'query',
    scope: 'read',
    input: GetInput,
    output: getResult(ThreadRow),
  },
  'Thread/act': {
    summary:
      'Triage: Done, Later, trash, read state, bookmark, due date, reminder, lane and the rest, on ids or a whole view or section, applied in one commit and queued for the provider.',
    kind: 'command',
    scope: 'triage',
    audit: true,
    input: z
      .object({
        opId: OpId,
        ids: z.optional(Ids(1_000)),
        selector: z.optional(ThreadSelector),
        action: ThreadAction,
      })
      .check(
        z.refine(
          v => (v.ids?.length ?? 0) > 0 !== !!v.selector,
          'Choose at least one conversation.',
        ),
      ),
    output: Receipt,
  },
  'Thread/why': {
    summary:
      '"Why it\'s here": one sentence and a quote from the mail saying why the thread is in its lane, and who placed it.',
    kind: 'query',
    scope: 'read',
    input: z.object({ threadId: Id }),
    output: WhyItsHere,
  },
  'Thread/open': {
    summary:
      'The reader opened a thread: fetch it whole if the row is partial (interactive lane) and mark it opened for retention.',
    kind: 'command',
    scope: 'read',
    input: z.object({ threadId: Id }),
    output: z.object({ threadId: Id, complete: z.boolean(), state: State }),
  },
});

export const operation = area('operation', {
  'Operation/undo': {
    summary:
      'Undo an operation: cancel it while held (`undoUntil`), else queue its inverse under `undoOpId`; never a delayed commit. A send is cancelled while queued or scheduled. Needs the scope of the method that made the operation.',
    kind: 'command',
    scope: 'triage',
    audit: true,
    scopeRule: 'originating',
    input: z.object({ opId: OpId, undoOpId: OpId }),
    output: Receipt,
  },
  'Operation/get': {
    summary: 'The state of operations after their receipts (queued, synced, failed, conflict).',
    kind: 'query',
    scope: 'read',
    input: z.object({ opIds: Ids(500) }),
    output: z.object({ list: z.array(Operation), notFound: z.array(z.string()) }),
  },
  'Operation/retry': {
    summary:
      'Retry a failed operation (the inline Retry after a rejected write). Needs the scope of the method that made the operation.',
    kind: 'command',
    scope: 'triage',
    audit: true,
    scopeRule: 'originating',
    input: z.object({ opId: OpId }),
    output: Receipt,
  },
});

export const mail = area('mail', {
  'Message/get': {
    summary: 'Message headers and attachment lists, no bodies.',
    kind: 'query',
    scope: 'read',
    input: GetInput,
    output: getResult(Message),
  },
  'MessageBody/get': {
    summary:
      'The plain-text rendering and quote ranges of a body, fetching it if absent. HTML is shown only through `Mail/frame`.',
    kind: 'query',
    scope: 'read',
    input: z.object({ messageId: Id }),
    output: MessageBody,
  },
  'MessageBody/prefetch': {
    summary:
      'Prefetch bodies on intent (focus or hover) by message, or by thread (the bodies the reader opens with, ARCH AM-1), or cancel a prefetch.',
    kind: 'query',
    scope: 'read',
    input: z
      .object({
        ids: z.optional(Ids(20)),
        threadIds: z.optional(Ids(20)),
        cancel: z.optional(bool()),
      })
      .check(
        z.refine(
          v => !!v.ids?.length || !!v.threadIds?.length,
          'Choose at least one conversation.',
        ),
      ),
    output: Ok,
  },
  'Mail/frame': {
    summary:
      'Render a message into the sealed `aplos-mail://` frame: sanitized on read, trackers removed, remote images blocked unless loaded or allowed. Electron windows only: a frame URL means nothing elsewhere, and the 64-token cap is per window.',
    kind: 'query',
    scope: 'read',
    uiOnly: true,
    input: z.object({
      messageId: Id,
      imagePolicy: choice(['block', 'load']),
      findQuery: z.optional(line(500)),
      quotesOpen: z.optional(bool()),
    }),
    output: MailFrame,
  },
  'Mail/allowImages': {
    summary:
      '"Load images from this sender": add an address or `@domain` to `Settings.mail.imageAllowList`, or remove it.',
    kind: 'command',
    scope: 'admin',
    audit: true,
    input: z.object({ opId: OpId, sender: SenderMatch, allow: bool() }),
    output: Receipt,
  },
  'Mail/release': {
    summary: 'Free a frame token when the reader replaces it.',
    kind: 'query',
    scope: 'read',
    uiOnly: true,
    input: z.object({ url: line(500) }),
    output: Ok,
  },
  'Mail/toggleQuotes': {
    summary:
      'Re-render a frame with quoted history opened or closed (the O key); returns the new frame.',
    kind: 'query',
    scope: 'read',
    uiOnly: true,
    input: z.object({ url: line(500), open: bool() }),
    output: MailFrame,
  },
  'Mail/serve': {
    summary:
      "Main's protocol relay: build the whole response, headers included, for an `aplos-mail://m/<token>/<path>` request.",
    kind: 'query',
    scope: 'host',
    input: z.object({
      token: line(64),
      path: line(2_000),
      /**
       * The requesting frame's window: the `connectionId` of the window connection that called `Mail/frame` (main maps
       * each window to its connection). Optional only so v1 stays additive; the engine fails closed and answers the
       * uniform 404 when it is absent or empty, because a token is served only to the window it was issued to.
       */
      windowId: z.optional(line(64)),
    }),
    output: z.object({ status: z.int(), headers: z.record(z.string(), z.string()), body: Bytes }),
  },
  'Attachment/get': {
    summary: "Make an attachment's bytes available as a blob, fetching it if absent.",
    kind: 'query',
    scope: 'read',
    input: z.object({ messageId: Id, attachmentId: Id }),
    output: z.object({ blobId: Id, name: line(500), mime: line(200), size: Count }),
  },
  'Message/original': {
    summary: 'The raw message for "Show original" and `.eml` export, fetched live, as a blob.',
    kind: 'query',
    scope: 'read',
    input: z.object({ messageId: Id }),
    output: z.object({ blobId: Id, name: line(500), size: Count }),
  },
});

export const blob = area('blob', {
  'Blob/put': {
    summary:
      'Upload bytes (an attachment, a dictation) as a transferable `Uint8Array`, never base64; 25 MB at most.',
    kind: 'command',
    scope: 'draft',
    input: z.object({ bytes: Bytes, mime: line(200), name: z.optional(line(500)) }),
    output: z.object({ blobId: Id, size: Count }),
  },
  'Blob/get': {
    summary: "Read a blob's bytes (over HTTP this is `GET /v1/blob/:id`).",
    kind: 'query',
    scope: 'read',
    input: z.object({ blobId: Id }),
    output: z.object({ bytes: Bytes, mime: line(200), name: z.optional(line(500)), size: Count }),
  },
  'Blob/release': {
    summary:
      'Drop a blob the caller no longer needs. A blob attached to a draft with a live send stays until the send settles (FR-7): `stateMismatch` "This file is attached to a message waiting to send."',
    kind: 'command',
    scope: 'read',
    input: z.object({ blobId: Id }),
    output: Ok,
  },
});

export const later = area('later', {
  'Later/presets': {
    summary:
      "The Later choices resolved by the engine's clock and zone: Today evening, Tomorrow, This weekend, Next week, Someday.",
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: z.object({
      now: EpochMs,
      presets: z.array(z.object({ key: line(40), label: line(100), until: z.optional(EpochMs) })),
    }),
  },
});

export const reminder = area('reminder', {
  'Reminder/list': {
    summary: 'Upcoming reminders and fired ones not yet seen.',
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: z.object({
      items: z.array(
        z.object({
          threadId: Id,
          at: EpochMs,
          firedAt: z.optional(EpochMs),
          ifNoReply: z.boolean(),
          title: text(2_000),
        }),
      ),
    }),
  },
  'Reminder/ack': {
    summary: 'Mark fired reminders seen.',
    kind: 'command',
    scope: 'triage',
    input: z.object({ opId: OpId, threadIds: Ids(500) }),
    output: Receipt,
  },
});
