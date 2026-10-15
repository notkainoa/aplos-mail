# Service contract

Renderer calls `bridge.invoke<T>(method, payload)`. Every method rejects with a human-readable Error on failure. State changes emit `{type:'state',payload:AppState}`; UI can also reload `state.get`. Secrets never occur in state/capabilities/errors.

Methods to implement in `src/main/service.ts` (`createService({dataDir, ...options})` returns `{invoke,subscribe,close}`):

- `state.get` → AppState; `capabilities.get` → Capabilities.
- `settings.update` `{patch:Partial<Settings>}`; `account.select` `{id}`; `account.connect` (Google OAuth); `account.disconnect` `{id}`; `sync` `{accountId?,auto?}` → state (`auto:true` is a background sync: paced per account, no busy spinner, skipped if one ran recently). Sync first sends queued changes (a manual sync retries failed ones at once); `state.sync.pending` counts changes that have not reached the mail host yet. `demo.reset` → state.
- `thread.update` `{ids:string[],patch:Partial<Thread>}`; `thread.undo` → state; `home.hide` `{ids}`; `search` `{query,accountId?}` → Thread[]. Patch includes status, unread, importance, bookmarked, replyStatus, dueDate, reminderAt, todo.
- `draft.save` `{draft:Draft}` → Draft (autosave/revision); `draft.delete` `{id}`; `draft.send` `{id}` → state (cancellable delay from settings); `draft.undoSend` `{id}`. Sent demo mail stays local. Google failure retains draft and sets sendError. A Google draft gets a stable `messageId` on its first send; `sendAttemptAt` marks a request that may have reached Gmail, and such a draft is only ever settled by finding that Message-ID in Sent mail, never resent automatically.
- Google `thread.update`, `thread.undo` and reminders apply locally at once and reach Gmail through a persisted queue.
- `ai.summarize` `{threadId}` → updated Thread; `ai.polish` `{html,instruction?}` → `{html}`; `ai.draft` `{instruction,threadId?,draft?}` → Partial<Draft>; `ai.ask` `{conversationId?,message,accountId?}` → Conversation; `ai.cancel` `{requestId?}`; `ai.transcribe` `{audio:string,mimeType:string}` → `{text}` (base64 max 25MB). All AI uses Groq.
- `conversation.delete` `{id}`.
- `calendar.list` `{accountId?}` → `{id,name,accountId}[]`; `calendar.extract` `{threadId}` → Partial<CalendarEvent>[]; `calendar.save` `{event:CalendarEvent}` → CalendarEvent (duplicate detection); `calendar.delete` `{id}`.
- `attachment.get` `{threadId,attachmentId}` → Attachment with base64 data; `sender.block` `{email}`; `sender.unblock` `{email}`; `thread.unsubscribe` `{id}` → `{url?:string,message:string}` (safe link, no implicit sending).
- `data.export` → JSON string. Desktop UI can save via native bridge.

Desktop-only bridge methods handled by electron.ts: `window.compose` `{draftId}`; `window.thread` `{threadId}`; `window.claim` `{draftId}` → boolean; `window.release` `{draftId}`; `window.closeReady`; `window.closeCancel`; `shell.open` `{url}`; `file.save` `{name,data}`; `file.open` `{name,data}`; `notification.test`; `system.login` `{enabled}`; `system.defaultMail`; `system.microphone`; `app.info`. Native close/quit emits `prepare-close`; active compose flushes its latest draft before closeReady, or closeCancel on save failure. Without compose, the app acknowledges immediately.

Automatic thread-view read mutations use `thread.update` with `recordUndo:false` so they cannot replace the user's triage undo. `ai.ask` may include a validated current `draft` context; the original user question is persisted unchanged and proposals are applied only on explicit review.

`src/main/server.ts` runs createService with loopback HTTP POST `/api/invoke` `{method,payload}` → `{result}` or `{error}` and GET `/api/events` SSE. Serve Vite in dev through the same command. Browser renderer uses these two endpoints. Browser-only desktop methods must return clear unsupported messages or sensible web equivalents.
