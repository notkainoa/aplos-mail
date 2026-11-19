# Aplos Mail: critical architecture audit (for comparison with Inbox Zero)

**Scope.** Read-only review of `/Users/knewton/.t3/projects/aplos-mail` on `main` at `72095ff` ("Release v0.2.3", which includes the Google 403 retry fix `99923ca`). All paths below are relative to `apps/desktop/` unless they start with a repo-root file. Nothing was run, installed or launched. `.env`, the keychain and any keys were not read.

**Method.** I read the root docs, then the core code in full (Electron, the engine, the store, the Gmail adapter, crypto, AI and the updater). A sub-audit covered the other adapters, and I spot-checked its key claims.

---

## Executive summary

Aplos is a well-reasoned but unproven local-first client. Its process boundary, durable write queue, protection against duplicate sends, IPC lockdown and protocol coverage are all strong.

It has four weaknesses:
- **The data model won't scale.** The whole mailbox is one in-memory object, cloned and re-serialized on every change.
- **The Gmail first sync is fragile.** It's a 500-thread, all-or-nothing pass with no pacing or checkpointing.
- **No real mailbox has ever been verified.**
- **There is no logging or crash reporting.**

The 403s on the first live sync follow directly from these.

---

## 1. Process architecture

**Three tiers.**
- **Main process** (`src/main/electron.ts`): windows, menus, notifications, the keychain, the updater and `openExternal`.
- **Engine** (`src/main/engine-host.ts`, built to `dist/main/engine.cjs`): an Electron `utilityProcess` forked at `electron.ts:224`. It owns SQLite, sync, provider adapters and AI calls.
- **Renderer** (React 19, `src/renderer/`): one per window, plus pop-out compose and thread windows.

`src/engine/` is designed to be platform-free (DECISIONS "Completion audit"). The SQL, secure storage, sockets, OAuth and scheduling all come in through ports (`src/engine/ports.ts`, `src/engine/sql.ts`), so a future React Native host could reuse it.

**RPC shape.**
- The renderer calls `window.aplos.invoke(method, payload)`, which uses `ipcRenderer.invoke('aplos:invoke', …)` (`preload.ts:18-22`).
- Main validates the caller (`assertCaller`, `electron.ts:48-51`: it must be the main frame of a window loaded from the trusted file or dev URL).
- Main then either handles one of about 18 "native" methods itself (`invokeNative`) or forwards the call to the engine over a small typed port protocol: init, invoke/result/error, event, call/reply, close (`src/main/engine-rpc.ts`).
- Events flow back as `aplos:event`, with `{epoch, rev}`-stamped `changes` diffs (`src/shared/live.ts`). Windows apply them in order and resnapshot when there's a gap.

There are about 55 engine methods, such as `state.get`, `threads.page`, `thread.update`, `sync`, `draft.send`, `ai.ask`, `ai.summarize`, `calendar.save`, `workflow.enable` and `data.export`.

The method allowlist is a **string set copied in three places**: `preload.ts:4-11`, `electron.ts:16-22` and `server.ts:11-17`. There is no shared typed contract for payloads or return types. `invoke<T>` is a cast at the call site, and engine payloads are typed `Record<string,any>` (`service.ts:44`). These lists will drift apart.

**Crash handling.**
- If the engine exits, pending calls fail and main restarts it and resnapshots every window.
- More than three exits in 60 s shows a dialog instead of looping (`electron.ts:231-255`).

This is good. But main also keeps a **full copy of `AppState`** (`latestState`, `electron.ts:38,207`), and it filters all threads on every change just to compute the Dock badge (`electron.ts:69`).

**Local HTTP server / browser preview** (`src/main/server.ts`) is development-only. It runs the engine in-process behind `127.0.0.1:4317` (`POST /api/invoke`, SSE at `/api/events`). Host and Origin checks (`server.ts:21-23`) defeat DNS rebinding and cross-site POSTs. There is no auth token, so any local process can drive it, but it isn't shipped. It has no safeStorage and uses a separate `Aplos Mail Preview` data directory.

**Preload and window security** (`electron.ts:91`):
- `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, `webSecurity:true`.
- Navigation to anything other than the renderer URL is blocked and handed to `shell.openExternal`, which only accepts http, https or mailto with no credentials (`electron.ts:54-58,107-109`).
- `setWindowOpenHandler` denies new windows.
- Permission handlers allow only microphone media (`electron.ts:271-276`).

**CSP** (`index.html`) is `script-src 'self' 'unsafe-inline'`, `img-src … https:`, and the production `connect-src` still lists the dev ports. `'unsafe-inline'` removes CSP as a backstop for the email-HTML risk in §5.

---

## 2. Data layer

**Storage.** SQLite through Node's built-in `node:sqlite` (`src/main/store.ts:1`), with WAL and `synchronous=NORMAL`, stored as `aplos.db` (mode 0600, directory 0700). A pre-SQLite `state.json` is imported once and renamed to `state.json.imported` (`store.ts:52-57`). `node:sqlite` is still a pre-stable Node API, so Electron upgrades are a compatibility risk.

**Schema** (`src/engine/store.ts:11-33`, `PRAGMA user_version` = 3):
- `meta(key,value)`
- `accounts`, `drafts`, `events`, `conversations` (each `id, pos, data`)
- `threads(id, account_id, date, status, data)`
- `sync_cursors`
- FTS5 `thread_text(id UNINDEXED, account_id UNINDEXED, subject, people, body)`
- `ops` (the queue, v2) and `provider_memory` (v3)

Migrations are additive `if(version<N)` blocks inside one transaction, and a newer schema refuses to open. That's simple and correct for now, but there are no down-migrations or data migrations beyond ad-hoc JS fixes in `service.ts:181-209`.

**It is a document store wearing SQLite.**
- Each thread row is one JSON blob holding **every message, including the full HTML body, the text and small inline attachments as base64** (`google.ts:64` stores `body.data` when Gmail inlines it). IMAP keeps full RFC822 messages up to 1 MB, and Graph keeps inline attachments up to 1 MB.
- `load()` parses the entire mailbox into memory at startup (`store.ts:95-108`).
- `save()` runs `JSON.stringify(thread)` for **every thread on every commit** and compares it against a cached string map, `written` (`store.ts:144-158`).
- The engine's `change()` does `structuredClone(state)` of the whole mailbox before every mutation (`service.ts:268`).
- Most methods return `clone(state)`, including `sync`, `settings.update` and `draft.delete`, which ships the whole mailbox across two IPC hops (engine → main → renderer).
- The renderer pages in every thread (`renderer/App.tsx:107-111`), and each pop-out window loads everything.

The mailbox therefore lives in memory about four times: as engine objects, in the `written` JSON cache, in main's `latestState`, and once per window. The cost is O(mailbox) per click.

`DECISIONS.md` ("Inbox Zero research follow-up") admits this: a 10k-thread import didn't finish in 210 s, and the renderer used about 1 GB. The CI "scale" test (`tests/scale.test.ts`) uses **160-character bodies**, so it does not represent real mail.

**FTS update cost.** `DELETE FROM thread_text WHERE id=?` runs on an `UNINDEXED` column (`store.ts:92,154,160`), which scans the whole FTS table for every changed thread.

**Cache size strategy: there is none.**
- The only bound is the first-sync window: 500 Gmail threads, about 500 Graph messages, and per-folder IMAP windows.
- After that, every new message and every server search result is kept forever. Each search can add up to 100 threads per account (`service.ts:430-431`).
- There is no body eviction, no on-demand body loading (DECISIONS M26: "Not done"), and no size cap.

**Backup and export.**
- `data.export` returns `JSON.stringify(state)`, the whole mailbox (`service.ts:947`). Credentials are excluded.
- There is no import, no scheduled backup and no integrity check. Time Machine copies of a live WAL database are best-effort.
- Mail at rest is **unencrypted** in `aplos.db`: bodies, AI summaries and Ask conversations. FileVault is the only protection.

---

## 3. Sync engine

**Contract.** One `MailProvider` interface (`src/engine/provider.ts`) with `sync(cursor) → {threads, flags, removed, cursor, reset}`, plus `updateThread`, `send`, `findSent`, `attachment`, `search`, calendar methods and app-data read/write. Each adapter keeps its own index in `provider_memory`. Writes made during a sync are staged in `AsyncLocalStorage` (`src/main/memory-stage.ts`) and committed **in the same SQLite transaction** as the threads and the new cursor. If a concurrent change invalidates a staged key, the sync is retried up to three times (`service.ts:580-589`, `StaleSync`). This is a genuinely good design.

**Offline op queue** (`service.ts:286-333`):
- A triage action changes local state and writes an `ops` row in one transaction.
- `flush()` sends ops in order per account. A failure holds back only that account's later ops (`held`).
- Retries back off from 30 s, doubling to 15 min. A 404 drops the op.
- `sync()` flushes before pulling.
- Threads with queued ops, or edited while a sync is in flight (`touched`), keep their local flags when the sync result is merged (`merge.ts:53-58`).
- An account "generation" number stops a late sync from undoing a disconnect.

**Conflicts.** `mergeStatus` (`merge.ts:12-21`) treats the host as authoritative for trash, spam and inbox membership. Aplos owns the Done/Later workflow state. This is sensible.

**Gate and backoff** (`src/engine/gate.ts`): one sync in flight per account, at least 15 s between automatic syncs, and backoff after failures from 30 s, doubling to 15 min.

Two weaknesses:
- `sync()` handles accounts **serially** (`service.ts:676`).
- It awaits AI classification inside the sync (see §4), so one slow account or slow LLM blocks every other account.

**Push vs polling.** Every provider is polled, with `setInterval` every 60 s (`service.ts:958-959`), plus window focus.
- Calendars are fully refetched every 10 min (`EXTRAS_INTERVAL_MS`).
- There is **no IMAP IDLE** (`imap-session.ts:71`, `disableAutoIdle:true`; the connection is also closed after 60 s idle) and no JMAP EventSource, even though neither needs a server.
- Gmail `watch` and Graph subscriptions do need one (DECISIONS 2026-10-15).

**`reset` is silently ignored.** Adapters set `reset:true` when a cursor expires and they fall back to a fresh window: Gmail history 404 or more than 20 pages, Graph 410 or more than 50 delta pages, JMAP `cannotCalculateChanges`.
- `merge.ts` and `service.ts` never read `result.reset`.
- So threads deleted or moved at the host while the cursor was stale **stay locally forever with stale status**.
- Mail outside the 500-thread window is never reconciled at all.

### Other adapters (sub-audit, spot-checked)

- **Microsoft Graph** (`microsoft.ts`) uses per-folder delta plus `$batch` fetches, and a 410 falls back to a fresh window. It has **no 429/Retry-After handling** (the value only appears in the error text, around `:125`), and its whole message index is one JSON key re-parsed on every action (`:96-97`).
- **IMAP** (`imap.ts`) uses one serialized connection per account, so a long first sync blocks archive and send. It uses CONDSTORE but not QRESYNC, expunge detection is O(known UIDs), `folderMap` re-stringifies the whole UID map on each write (O(n²) per sync, `imap-index.ts:63-67`, confirmed), and catch-up after a long offline gap is unbounded.
- **JMAP** (`jmap.ts`) is the cleanest: `Email/changes` and `Thread/changes`, with an idempotent `EmailSubmission` send. It ignores Retry-After.
- **CalDAV** (`caldav.ts`, `ical.ts`) has no sync-token or ctag and re-queries −30 days to +1 year every 10 minutes. Recurrence depends on the server's `<C:expand>`. Etag-guarded edits are good.

### Gmail adapter (`src/main/google.ts`): the critical path

**First sync** (`freshWindow`, `:198-203`):
1. `users.getProfile` (it reads `historyId` *first*, which is correct).
2. `threads.list` with `q=-label:aplos-mail-data`, **`includeSpamTrash=true`**, up to 500 IDs (`:159-169`).
3. 500 × `threads.get?format=full` at **concurrency 4** (`each`, `:171-176`).
4. For every body part stored as an attachment, a **serial** `messages.attachments.get` inside each worker (`:183-187`).

**Quota cost.**
- `threads.get` is 10 units, so 500 threads cost about 5,000 units, plus 10 for the list and 5 per body-attachment.
- Gmail's per-user limit is 15,000 units per minute (about 250/s, a moving average), plus an undocumented per-user concurrency limit shared with the user's other clients (phone, Gmail web).
- Four workers with sub-200 ms responses run at or above 250 units/s in bursts.
- Spam and Trash threads (often bulky marketing mail) use part of the 500-thread budget and bandwidth.

**Why it breaks.**
- **No global pacing.** Each of the 4 workers retries on its own (up to 5 times, honouring Retry-After capped at 30 s, else 1–16 s with jitter; `:110-133`). There is no shared token bucket or circuit breaker, so when one worker is limited the other three keep firing.
- **All-or-nothing.** `freshWindow` returns only after all 500 threads are fetched. One thread that fails after its retries rejects `Promise.all`, and nothing is committed.
  - `each` has no AbortSignal, so **the sibling workers keep fetching after the failure** and keep spending quota.
  - The gate then backs off and the next attempt **starts from zero**.
  - Combined with a 45 s timeout per request and up to 5 retries of up to 30 s, a bad first sync can loop for a long time and never make progress.
- **Payload size.** `format=full` returns every MIME part, headers included, as base64. There is no `fields=` partial-response mask and no `metadata`-first pass, so the full 500-thread window (bodies plus inline attachments) is held in engine memory, then cloned and stringified as described in §2.
- **No batch endpoint.** `https://gmail.googleapis.com/batch/gmail/v1` takes up to 100 calls per HTTP request. Google advises 50 or fewer, and batching doesn't reduce quota units, but it removes about 500 TLS round trips.
- **Incremental sync is reasonable but wasteful.**
  - `history.list` with `historyTypes` filters is cheap (2 units).
  - Any `messageAdded` triggers a **full `format=full` refetch of the whole thread** (`:228`), so a 100-message thread is re-downloaded for each reply.
  - Label-only changes cost a `format=minimal` `threads.get` (10 units) per thread (`:227`), even though the history records already carry `labelIds`.
  - More than 20 history pages throws everything away and re-downloads 500 threads, and with `reset` ignored that isn't even a true resync.
- **OAuth error handling is thin.**
  - A refresh-token failure (`invalid_grant`, 400) surfaces as "Google request failed (400)", not "reconnect" (`:142` via `fetchJson`).
  - The account is never marked `connected:false`.
  - The token response's `scope` is never checked. With Google's granular consent, a user can untick Gmail or Calendar scopes, and every later call then fails with a non-retryable `403 insufficientPermissions`.
  - The 0.2.3 fix retries only rate-limit 403s. Other 403 causes (`insufficientPermissions`, `accessNotConfigured`, Workspace `admin_policy_enforced`, the unverified-app test-user cap) still fail immediately. They do now show Google's reason, which is the right first step.
- **Not synced to Gmail at all.** Drafts are local-only (no `drafts.*` calls), so a draft started in Aplos is invisible on the phone. Blocking a sender only marks it Spam locally; it creates no Gmail filter.

**Gmail best practice** (Google's "Synchronizing clients with Gmail" guidance plus common practice), compared with Aplos:

| Practice | Aplos |
|---|---|
| Full sync: list IDs, then **batch** `messages.get`/`threads.get` with `format=metadata` (or `minimal`) and a `fields` mask | `format=full`, no batch, no `fields` |
| Fetch full bodies lazily (on open) or in a low-priority background lane | Full bodies for all 500 threads up front |
| Commit pages as they arrive and resume from a checkpoint | All-or-nothing |
| Store the `historyId` from before the full sync and resync incrementally | Done correctly |
| On a 404 from `history.list`, run a full resync that **reconciles deletions** | Done, but deletions are not reconciled (`reset` ignored) |
| Use per-user rate pacing (a token bucket around 150–200 units/s) with exponential backoff on `rateLimitExceeded`/`userRateLimitExceeded` | Backoff only, per worker, with no pacing |
| Push through `users.watch` and Pub/Sub when a backend exists; otherwise poll `history.list` (cheap) | Polls every 60 s, which is fine |

**Verdict:** the incremental half is sound, but the full-sync half isn't safe for large or busy mailboxes. The 0.2.3 retry fix treats the symptom, not the cause.

---

## 4. AI architecture

**Provider abstraction.**
- `src/main/llm.ts` holds one OpenAI-compatible streaming client. It covers Groq, OpenAI, Gemini (the `/v1beta/openai` endpoint), OpenRouter, OpenCode Go, LM Studio and a custom server.
- `src/main/ollama.ts` uses Ollama's native `/api/chat` so it can set `num_ctx`.
- `src/main/anthropic.ts` uses the official SDK and replays `tool_use`/thinking blocks.
- `src/main/groq.ts` keeps its own JSON-mode path and Whisper transcription.

Feature routing is `provider:model` per feature: `askModel`, `summaryModel`, `draftModel`, `planModel` and `voiceModel` (`service.ts:449-477`). Keys are resolved per request from the vault (`ai-keys.enc.json`) or the environment (`main/ai-keys.ts`). Errors never include provider response bodies. This is a clean, small abstraction that needs no framework.

**Features.** Ask is a custom agent loop (`src/engine/agent.ts`) limited to 6 model calls, 30 s per call and 120 s per answer, with a 48K/100K-character budget. Its tools (`src/engine/ask.ts`) are read-only search, read, events, contacts and context lookups, plus proposal-only draft, event and triage cards. Summaries, drafts, polish and plans use JSON prompts with strict output validation (`src/engine/writer.ts`). Voice uses Groq or OpenAI transcription.

**Prompt-injection defences** are better than average because they contain *capabilities*, not just prompts:
- The model sees mail only through short refs (m1, m2, …), so citations and triage can only point at mail a tool returned.
- No tool can send, save or archive. Every action is a card the user must confirm.
- Suggested actions are restricted to links or attachments that already exist in the thread (`writer.ts` `suggestedAction`).
- The system prompts say mail content is untrusted (`writer.ts` `jsonSystem`, `ask.ts:225`).
- Ask answers render as plain text with chips, not markdown, so there's no image or link exfiltration channel (`renderer/AskAnswer.tsx`).
- There is an injected-instruction case in the eval corpus (`TODO.md` M33).

Residual risks:
- A malicious email can steer a summary's `importance`, `replyStatus` or `dueDate`, which drive Home ordering.
- If `autoCalendar` is turned on (it's off by default, `engine/demo.ts:7`), extracted events are written to the user's **real** calendar without confirmation (`service.ts:558-566`).

**Cost and latency controls:**
- Groq-specific 429 waits, up to 6 within the deadline (DECISIONS "Ask as a tool-using agent").
- Context trimming.
- Polish refuses bodies over 40K characters.
- Background list summaries run two at a time, once per session.

What's missing: spend accounting, daily caps and any persistent token ledger. Usage is only emitted as a progress event.

**The serious problem is coupling enrichment to sync.**
- `syncAccountOnce` awaits `classifyIncoming` for every *added* inbox thread (`service.ts:640-645`).
- On a **first sync that is every new-status thread in the 500-thread window**, summarized at concurrency 3, plus event extraction if enabled.
- On Groq's free tier (8K tokens per minute, per DECISIONS), that means many minutes of 429s while the global `syncing` promise blocks every other account and every automatic sync.
- It also means connecting an account with a Groq key automatically **sends hundreds of emails to a third-party LLM** with no explicit consent step.

**Caching:**
- The summary stored on the thread is the cache.
- In-flight requests are de-duplicated (`tracked`, `service.ts:517-526`).
- There is no content-hash cache, even though DECISIONS 2026-10-15 claims one was "adopted".
- Summaries are recomputed and paid for **per device**, because they aren't in the cross-device log.

**Evals:**
- An 8-case Groq factual corpus (`scripts/quality/cases.ts`, `npm run eval:groq`) and a 5-question live Ask check (`npm run eval:ask`).
- Both are manual, not in CI, and have no regression history.
- Non-Groq providers were tested against fake servers only.

---

## 5. Security

**OAuth.**
- Google uses a loopback redirect on `127.0.0.1:<random port>` with a 256-bit `state`, PKCE S256, `access_type=offline` and `prompt=consent` (`google.ts:286-313`).
- Disconnecting revokes the token (`:325-328`).
- Microsoft is a public client using PKCE with the `localhost` loopback.

**Token storage.**
- A random 256-bit data key (AES-256-GCM, `APK1` framing) is wrapped by safeStorage (Keychain) as `engine-key.bin` (`src/main/keyring.ts`).
- Main unwraps it and passes it to the engine in memory.
- Each vault entry is sealed separately (`vault.ts`), and writes are atomic (temp file then rename).
- The key file is never replaced when it's unreadable, so a locked keychain doesn't orphan credentials.
- Secrets never reach the renderer, and an AI key pasted through `ai.key.paste` never passes through it (`electron.ts:281`).

**Bundled Google client secret** (`scripts/oauth-defines.mjs`, `src/main/oauth-config.ts`):
- It's inlined into `dist/main/engine.cjs` only for release builds. CI refuses to build a release without it (`.github/workflows/release.yml`).
- For a "Desktop app" client this is standard; Google treats the secret as non-confidential.
- The real consequences: anyone can extract the client and present Aplos's consent screen or use up its project quota, and all users share one per-project quota.

**Scopes** (`google.ts:310`):
- `gmail.modify` and **`gmail.settings.basic`** are both on Google's *restricted* list.
- `calendar.events` and `calendar.calendarlist.readonly` are sensitive.

Until the app is verified:
- Only listed test users (at most 100) can sign in, behind the unverified-app warning.
- Refresh tokens for "Testing" projects with these scopes **expire after 7 days**, so every user is forced to reconnect weekly. `invalid_grant` isn't handled specially either (§3).

Verification of restricted scopes needs a CASA security assessment and Limited Use compliance. Google has historically been lenient with clients that keep data on the device, but Aplos **sends message content to third-party LLM APIs** (Groq by default). That probably counts as transfer to a third party, which makes the assessment and a Limited Use disclosure hard to avoid. Treat this as a launch blocker, and confirm the details with Google. Dropping `gmail.settings.basic`, which only serves aliases and signatures, would shrink the restricted surface.

**Electron hardening checklist:**

| Item | Status |
|---|---|
| contextIsolation, sandbox, no nodeIntegration | ✓ |
| IPC allowlist, sender-frame validation, per-method input validation (`text()`/`object()` caps) | ✓ |
| Navigation, window-open and permission lockdown; openExternal scheme allowlist | ✓ |
| CSP | ✗ weak: `script-src 'unsafe-inline'`, dev origins left in prod `connect-src` |
| Renderer loaded via a custom protocol | ✗ uses `file://` (works, but discouraged) |
| **Electron fuses** | ✗ not configured: `RunAsNode`, `NodeOptions`, `NodeCliInspect` and `EnableEmbeddedAsarIntegrityValidation` all left at defaults (no `fuses` config anywhere) |
| Entitlements | ✗ broad: `disable-library-validation` and `allow-unsigned-executable-memory` alongside `allow-jit` (`build/entitlements.mac.plist`) |

With RunAsNode enabled, any local process can run the signed app binary as Node, inherit its Keychain access and unwrap `engine-key.bin` without a prompt. That's a known class of Electron keychain bypass.

**Email HTML is the biggest application-level risk** (`src/renderer/mailBody.ts:24-55`, `Reader.tsx:169`).
- Untrusted HTML is sanitized by DOMPurify, then serialized, re-parsed and mutated (quote extraction, search highlighting), then serialized again and injected with `dangerouslySetInnerHTML` **into the privileged renderer document**, the one that holds `window.aplos`.
- There is no sandboxed `<iframe srcdoc>` and no separate origin.
- Sanitize → serialize → re-parse is a classic mutation-XSS shape. With `'unsafe-inline'` in the CSP, a DOMPurify bypass would give an attacker the full bridge: send mail, export the mailbox, change settings.
- Stripping every `style` tag and attribute makes the sanitization safer but wrecks how newsletters and HTML mail render. That's a product-quality cost Inbox Zero's web UI and Gmail don't pay, because they use sandboxed frames.
- Remote images are blocked by default, which is good.

**Auto-update** (`src/main/updates.ts`, `RELEASING.md`):
- electron-updater with the GitHub provider. `latest-mac.yml` carries SHA-512 hashes, and Squirrel.Mac requires the new bundle to have the same Developer ID team.
- It never installs without the user clicking Restart.
- The design is correct, but **no release has been signed or notarized yet** (`TODO.md:49`). Every shipped build is ad-hoc signed, so auto-update is disabled for everyone (`disabledReason`), and users have to bypass Gatekeeper.
- The hash feed and the binaries share one trust root (the GitHub release), so the integrity guarantee comes entirely from the code signature.

**Smaller items:** autoconfig DNS rebinding is an accepted risk, autodiscovery sends the user's address to ISPDB and DoH to Cloudflare or Google (`engine/dns.ts:12`), and `dorny/paths-filter@v3` is pinned by tag, not SHA.

---

## 6. Engineering quality

**Tests.**
- About 259 `node:test` cases in 36 files (`tests/*.test.ts`, run through `tsx --test`). PROGRESS records 227 passing at the last evidence point.
- The kinds are pure unit tests and **fake-server integration tests**: injected `fetch` and session fakes for Gmail, Graph, IMAP, JMAP and CalDAV, plus an emulated-provider test (`tests/emulation.test.ts`).
- There are **zero live-provider tests** (M11 is open). Live AI evals run by hand.
- There are **zero renderer component or E2E tests in CI**. `scripts/verify-release.mjs` drives the packaged app, but only manually.
- Despite the name, `tests/live.test.ts` is **not** a live-provider test. It covers "live state" replication (`applyChanges`/paging), the engine RPC port and the keyring. The name is misleading for anyone counting live coverage.
- Test quality is good on invariants, especially send idempotency, queue ordering and staged memory (`tests/sync-safety.test.ts`, `tests/queue.test.ts`, `tests/service.test.ts`).

**CI** (`.github/workflows/ci.yml`):
- On macOS: typecheck, test and build for desktop changes; typecheck and build for the website.
- Missing: lint, formatting, coverage, `npm audit`, CodeQL and E2E.
- `release.yml` repeats typecheck and test, then builds, signs and notarizes when the secrets exist.

**Typecheck:** `strict:true` (`tsconfig.json`), but without `noUncheckedIndexedAccess` or `exactOptionalPropertyTypes`. RPC payloads are `Record<string,any>`. There are only 13 explicit `any` usages, which is low, but the IPC boundary is effectively untyped.

**Code style.** This is the most unusual aspect:
- The code is extremely dense, often a whole function or a 20-branch conditional on one line.
- 733 lines in `src` exceed 200 characters. Maxima: `engine/writer.ts` 1,727 chars, `renderer/Reader.tsx` 1,423, `renderer/Compose.tsx` 1,209, `renderer/App.tsx` 877, `google.ts` 703.
- The average is about 93 bytes per line, versus roughly 35–40 for formatted TypeScript.
- `service.ts` puts a ~770-line closure (`createEngineService`) around a ~260-line `switch`.
- There is no ESLint, Prettier or Biome config in the repo.

Judgement: the comments are excellent (they explain why) and the invariants are carefully thought through, but the format is close to "minified with comments". Diffs and `git blame` operate on whole statements, you can't break mid-expression, and review and merges get harder. It suits agent authorship (the repo is clearly agent-driven: 169 commits from 2026-10-14 to 2026-10-25, with `AGENTS.md` instructions) and is hostile to human contributors. Running a formatter would roughly triple the physical line count, and would be the cheapest maintainability fix available.

**Error handling.** User-facing messages are unusually good and specific. But original errors are often thrown away:
- `store.ts:62-63` replaces any SQLite error with "Check free space…".
- There are 102 `catch{` sites, about 32 of them completely empty.
- `service.ts:600-604` swallows calendar failures, and turns sending-address failures into a generic message.

**Observability is essentially absent:**
- There are 5 `console.*` calls in `src`, and stdout from a packaged app goes nowhere.
- No log file, no `crashReporter.start`, no telemetry, no diagnostic bundle.
- The Google 403 needed a new release (0.2.3) just to *see* Google's reason. Any field failure today has the same turnaround.

---

## 7. Size

Counts are tracked files only. "Bytes" is the better size measure because lines are so dense.

| Area | Files | Physical lines | Bytes | ≈ formatted LOC (bytes/40) |
|---|---:|---:|---:|---:|
| `src/engine` | 16 | 3,167 | 238 KB | ~5,900 |
| `src/main` (adapters, Electron, crypto, AI transports) | 32 | 4,801 | 363 KB | ~9,100 |
| `src/renderer` (React + CSS) | 54 | 8,534 | 663 KB | ~16,600 |
| `src/shared` | 6 | 384 | 28 KB | ~700 |
| `tests` | 36 | 5,562 | 439 KB | ~11,000 |
| `scripts` | 16 | 739 | 72 KB | ~1,800 |
| `apps/web/src` | 17 | 1,885 | 109 KB | ~2,700 |

That's 270 tracked files in total. App source (`src`) is about 1.29 MB, roughly 32K formatted-equivalent lines. The docs are substantial too: `DECISIONS.md` 92 KB and `PROGRESS.md` 117 KB.

**Largest files and complexity hotspots:**
- `engine/service.ts` (77 KB): every use case in one closure, mixing sync orchestration, AI scheduling, sending and calendar.
- `renderer/Calendar.tsx` (67 KB).
- `renderer/App.tsx` (63 KB): global state, paging, keyboard handling and routing.
- `main/microsoft.ts` (50 KB), `main/imap.ts` (47 KB) and `main/jmap.ts` (46 KB).
- `renderer/Compose.tsx` (45 KB): 1,200-character lines.
- `main/google.ts` (39 KB), `engine/discover.ts` (37 KB) and `renderer/Reader.tsx` (35 KB).

---

## 8. Scalability limits of the local-first design

**Cross-device workflow sync through a hidden mailbox** (`src/main/workflow-sync.ts`, `src/engine/workflow.ts`, `src/main/workflow-crypto.ts`, `google.ts:391-422`):
- It syncs per-thread Done/Later, to-do, due date and reminder as a last-writer-wins log, sealed with AES-256-GCM under a scrypt key from a 28-character sync code.
- On Gmail, each copy is a message inserted with `messages.insert` (25 units) under a hidden "Aplos Mail Data" label, with an `X-Aplos-Data` header and an attachment of up to 3 MB.
- A round, at most every 5 minutes or sooner after edits, reads every copy, merges them, writes one new copy and **trashes** the copies it read, because `gmail.modify` can't delete.
- The merge is commutative and idempotent, so concurrent writers never destroy each other's copies. That's solid work.

Its limits:
- **Device clocks decide conflicts.**
- **Gmail Trash fills** with "Aplos sync data" messages that count against storage, and the label may still show up as an IMAP folder in other clients.
- Only workflow state syncs. Settings, AI keys, Ask history, AI summaries (paid for again on each device), drafts (they aren't Gmail drafts) and blocked senders (they aren't Gmail filters) stay on one device.
- Reminders fire only on a Mac that's awake.

**What this design can't do without a backend:**
1. **Push.** Gmail `users.watch` needs a Pub/Sub topic and subscriber, and Graph needs a public HTTPS webhook. Desktop is limited to polling (IMAP IDLE and JMAP push are possible, but Aplos doesn't implement them).
2. **Rules, cold-email blocking, auto-labeling and auto-replies while the Mac sleeps.** Inbox Zero's core value is exactly this kind of server-side automation, running 24/7 on push events.
3. **Scheduled send or follow-up nudges when the Mac is off.** The Gmail API has no scheduled-send endpoint.
4. **Web and mobile clients.** `MOBILE.md` keeps the engine portable, but a phone app would still have to run its own sync, its own AI (with user-entered keys) and its own copy of the 500-thread window.
5. **Whole-mailbox analytics and bulk unsubscribe.** Locally there are only about 500 threads plus new mail. `thread.unsubscribe` only finds an HTTPS link in the body (`service.ts:939-946`); it doesn't use `List-Unsubscribe`/RFC 8058 one-click.
6. **Shared AI cost, central evals or telemetry.** Every user brings their own key, and failures are invisible to the developer.

**Versus Inbox Zero.** Inbox Zero, as public in its repo, is a hosted Next.js app with Postgres and Redis, Gmail Pub/Sub push, a server-side AI rules engine, bulk unsubscribe and analytics, and support for Gmail and Outlook only. Its server holds OAuth tokens and mail content, which means a larger blast radius and a mandatory CASA assessment, plus hosting cost.

Aplos's structural advantages:
- Privacy: mail stays on the Mac, and AI can be bring-your-own or fully local (Ollama, LM Studio).
- Offline use and native latency.
- IMAP, JMAP and CalDAV coverage.
- A real calendar.
- Better sending guarantees.

Its structural disadvantages: no automation while the Mac is away, no full-history features, and every device is a separate sync client.

---

## Top 10 architectural risks (ranked by severity)

1. **Gmail full sync is all-or-nothing and unpaced** (§3; `google.ts:171-203`). It fetches 500 threads with `format=full` at concurrency 4, with no shared rate limiter, no batch requests or `fields`, no checkpoint, and no cancellation of sibling workers. The first live sync already failed this way.
2. **The whole mailbox is an in-memory document store** (§2). Every action clones and stringifies everything, there are four or more copies in memory, bodies are never evicted, and it already failed at 10k threads. This is the ceiling on large mailboxes.
3. **Nothing has been verified against a real mailbox, and there is no observability** (§6). Field failures need a new release to diagnose.
4. **Google verification is a distribution blocker** (§5). Two restricted scopes, a 100-user cap, 7-day refresh tokens, CASA plus Limited Use with third-party LLMs, and no handling of `invalid_grant` or granted scopes.
5. **Untrusted email HTML runs in the privileged renderer DOM** with CSP `'unsafe-inline'` (§5). A single DOMPurify or mXSS bypass compromises the whole bridge.
6. **Cursor resets are ignored** (§3). Ghost and stale threads accumulate, and mail outside the window is never reconciled.
7. **AI enrichment sits on the sync critical path** (§4). Hundreds of summaries run on first sync, accounts sync serially, and mail goes to a third-party LLM implicitly once a key exists.
8. **The distribution chain is unsigned and the binary is under-hardened** (§5). Auto-update is off for everyone, Electron fuses are unconfigured, entitlements are broad, and mail at rest is unencrypted.
9. **Polling only, with no rate discipline outside Gmail** (§3). There's no IDLE or JMAP push, Retry-After is ignored, calendars are fully refetched, and IMAP index writes are O(n²).
10. **Maintainability** (§6). Dense code with no formatter, a god-closure in `service.ts`, untyped IPC method lists copied in three places, no renderer tests, and a pre-stable `node:sqlite`.

## Top strengths

1. **Clean process isolation.** The engine runs in a `utilityProcess` with crash-loop-guarded restarts and epoch/rev change replication, and it is platform-free behind typed ports.
2. **A durable, ordered, per-account op queue.** Each change is written in the same transaction as the edit, threads with in-flight changes are protected, and an account-generation guard blocks late results.
3. **Atomic provider bookkeeping.** Index writes are staged and committed together with the threads and the cursor, and stale results are retried.
4. **Duplicate-send protection better than most commercial clients.** A stable Message-ID, a `sendAttemptAt` marker and `findSent` reconciliation, with no automatic resend.
5. **Solid credential design.** A keychain-wrapped AES-GCM data key, per-entry sealing and no secrets in the renderer.
6. **Tight IPC and window security.** An allowlist, sender-frame checks, sandbox, and navigation and permission lockdown.
7. **AI capabilities are contained.** The tools are read-only, actions are proposals only, citations are ref-scoped and outputs are validated. Providers are swappable per feature, including local models.
8. **Broader protocol coverage than Inbox Zero.** Gmail, Graph, IMAP/SMTP, JMAP and CalDAV, with SSRF-aware discovery.
9. **Excellent decision records** that keep evidence separate from assumptions.
