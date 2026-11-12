# Reader load path: audit notes for the "fix email bodies" thread

Not a plan. These are vetted findings from the improve audit (commit `8a254600`,
2026-11-11) on the path from "open an email" to "body shown". The owner's slow
loads and "Couldn't load this email" are being fixed in a separate thread
(branch `rv/fix/email-bodies`), which found the main cause: the real-engine
composition never passed the `html` port, so every HTML body answered
`unavailable`. That fix is not repeated here. The items below are the
**remaining** causes that can still produce slow opens or the same error after
the port fix lands. Each was re-read in code by the auditor; confidence is
stated. Hand any of them to that thread, or turn one into a plan with
`/improve plan <item>`.

No mail content, addresses or tokens appear in this file.

## Still-live causes of "Couldn't load this email"

### R1. A sync throttle makes every open fail instantly for 1 minute to 1 hour (HIGH)

- `packages/engine/src/sync/governor-state.ts:155-166` — `blockFor` returns the account's budget pause for **every** request kind and lane, interactive included.
- `packages/engine/src/sync/governor.ts:413-444` — `admit` rejects with a paused error while the pause lasts (only the one-shot "Retry now" pass is let through).
- `packages/engine/src/sync/governor-meter.ts:16` — cooldowns step 60 s, 5 min, 15 min, 1 h.
- The error type reaches the renderer as `paused` with `resumeAt` (`packages/engine/src/runtime/errors.ts:36-44`), but `apps/desktop/src/renderer/data/bodies.ts:91-100` stores it as a plain `failed` and the reader shows the generic "Couldn't load this email." Try again fails the same way until the pause ends.
- Effect: one 429 from background sync turns every open of an unfetched email into an error card. Fits "often".
- Pausing the account is by design (ARCHITECTURE §6.3); the user-facing result is not. Options: show "Gmail asked Aplos to slow down; this opens at 3:42" and retry at `resumeAt`; or let a user's open use the existing single `retryNow` pass.

### R2. A failed body stays failed until the owner clicks Try again (HIGH)

- `apps/desktop/src/renderer/data/bodies.ts:40-52` — `get`/`retain` return the cached entry, including `failed`; only the manual `retry` refetches (`:56-60`). A failed entry is dropped only after 24 other unused entries (`trim`, `:109-112`).
- Nothing refetches on engine reconnect, on the end of a pause, or on reopen.
- Effect: a transient failure (pause, engine restart, network blip) shows the error every time that email is reopened.
- Fix shape: on `retain` of a `failed` entry with no fetch in flight, refetch once; retry at `resumeAt` for `paused`, and on reconnect for `unavailable`.

### R3. A body part that did not arrive is stored as an empty body and never fetched again (HIGH)

- `apps/desktop/src/host/providers/google/bodies.ts:73-79` marks messages with unresolved parts `partial` ("so the engine opens it again"), and `:146-164` adds messages to `unresolved` when a part fetch is paused or fails.
- `packages/engine/src/sync/facts.ts:405-433` writes the body (no `html`, no `text`) and the thread with `complete: true` unconditionally; `messageWrites` (`facts.ts:110-140`) never reads `facts.partial`. Nothing else in `packages/engine/src` reads it either.
- `packages/engine/src/mail/message.ts:78-79` — any stored body short-circuits a refetch.
- Effect: if a pause (R1) hits while a thread is opened, the affected message shows a permanently blank letter (not even an error).
- Fix shape: skip the body write (or write `complete: false`) for messages in `unresolved`.

### R4. The next letter's document can be refused while the current one loads images (MED)

- `apps/desktop/src/host/protocol/relay.ts:38` — at most 16 relayed `Mail/serve` requests per window; `:246-249` throws when full, served as a 404. Documents and `cid`/`img` sub-requests share the pool.
- `packages/mail-html/src/frame/tokens.ts:124-132` — a frame token's document is served once.
- Effect: a letter with many inline/signature images still loading can starve the next letter's document; the frame never reports, and the 10 s deadline (`apps/desktop/src/renderer/mailframe/deadline.ts`) shows the error.
- Fix shape: reserve slots for documents (or exempt them from the per-window cap).

### R5. A failed `Thread/open` is swallowed (MED)

- `apps/desktop/src/renderer/screens/reader/ReaderLetter.tsx:311` — `api.thread.open({ threadId }).catch(() => undefined)`. If it fails (e.g. R1), nothing records it; the letter relies on `MessageBody/get` failing separately.

## Causes of slowness

### S1. Interactive Gmail fetches cannot be cancelled and queue first-in-first-out (HIGH mechanism, MED size)

- `packages/engine/src/sync/budgets.ts:46-48` — 3 Gmail requests in flight, 1 reserved for interactive.
- `packages/engine/src/sync/governor.ts:528-563` — each lane leaves in arrival order.
- `packages/engine/src/mail/message.ts:80-83` — `openThread` gets no abort signal (`packages/engine/src/mail/prefetch.ts:12` says so); `packages/engine/src/mail/serve.ts:92` — inline part fetches get none either.
- Effect: moving through several threads queues interactive `threads.get` calls nobody needs any more; the email the owner stops on waits behind them.
- Measure with the `governor.admitted` `waitMs` log field before changing anything.

### S2. One open can fetch the same thread 2-3 times (HIGH)

- `ReaderLetter.tsx:311` calls `Thread/open` (`packages/engine/src/views/open.ts:18-30` → interactive `openThread` when the thread is partial), and `ReaderLetter.tsx:122` (`useMessageBody`) → `loadBody` → a second `openThread` (`message.ts:80`). The reader's prefetch can add a third on the prefetch lane (`apps/desktop/src/renderer/data/prefetch.ts:31`, `packages/engine/src/mail/prefetch.ts:59-63`).
- No in-flight map for thread opens (`packages/engine/src/mail/state.ts` keeps one only for attachments and originals).
- Fix shape: a per-`account+thread` in-flight promise around `openThread`, upgraded to interactive when an interactive caller joins.

### S3. Inline `cid:` images are refetched from Gmail on every render (HIGH, known gap)

- `packages/engine/src/mail/serve.ts:76-107` always calls `services.accounts.attachment` (20 units each, interactive lane). `DECISIONS.md` (~line 1315) already notes stored parts should be served locally.
- Feeds S1 and R4.

### S4. Opening one message fetches and commits the whole thread (by design, note only)

- `apps/desktop/src/host/providers/google/bodies.ts:38-60` uses `threads.get format=full`. Recorded as a deliberate unit-cost choice (ARCHITECTURE.md AM-1). Worth revisiting only for very long threads.

### S5. `Mail/frame` waits for a full `MessageBody/get` round trip (MED, small)

- `apps/desktop/src/renderer/mailframe/useFrameSource.ts:73-94`. Do S2 first; then the two calls can run in parallel.

## Investigate only

- **I1 (LOW).** A Gmail 404 on `threads.get` deletes every local message of that thread (`google/bodies.ts:62-66` → `facts.ts:423-424`). If a stored thread id is ever stale, opening it removes messages that still exist. Check whether Gmail thread ids change in practice before acting.

## Checked and sound

Quick switching between messages on the renderer side (the `live` flag in
`useFrameSource.ts:82-92`, the key check in `mailframe/measured.ts:23-25`, the
per-key deadline in `deadline.ts:50-58`); the sanitizer's size cap and linear
parser (`packages/mail-html/src/sanitize.ts:92`, `parse.ts:1-12`).
