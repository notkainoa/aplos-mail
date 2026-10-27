# Architecture proposal: local-server-first (Candidate A)

**Angle.** Design Aplos around a real local mail server from day one. The UI becomes a pure client. Stages: A0 (listener inside today's engine process, app stays resident) → A1 (SMAppService LaunchAgent that survives quitting the UI) → A2 (paired phone over LAN/Tailscale).  
**Evidence base.** `research/email-clients/SYNTH-architecture.md`, gap reports under `research/email-clients/gaps/`, protocol reports under `research/email-clients/protocols/`, and Aplos docs on main. Facts that override older research notes are recorded in `plans/_council/CONTEXT.md` (Developer ID signing and notarization exist; provisioning profiles for keychain access groups and CloudKit do not).  
**Word target.** Planning document for later execution by architecture threads. No implementation in this phase.

---

## In plain English

Today Aplos is a mail app whose brain lives inside the same Electron shell that draws the windows. When you quit, sync stops. When the first Gmail sync tried to pull hundreds of full threads at once, Google said no — the new per-user limit is too small for that design. The window holds too much of the mailbox in memory, and the change counter resets every restart, so every open window has to re-download the world.

This proposal turns the brain into a small local server that owns the mailbox database, talks to Gmail and the other providers, runs timers and AI jobs, and speaks one typed language to every client. Desktop windows, the browser preview, a future command-line tool, and later a phone all become clients of that server. On your Mac it starts as part of the app you already have. Later it can keep running after you close the windows, and still later a phone can pair over your home network or Tailscale — the same pattern T3 Code uses.

Why it matters: one place owns Google's scarce quota, so the Mac and a thin phone do not fight each other. Sync, send-later, and reminders can keep working with no window open. Mail never passes through an Aplos cloud. The cost is real: a network listener is an attack surface; a second process means update and Keychain work; a phone that depends on your Mac sees nothing while the lid is shut unless we add extra glue later.

What changes for you: the app feels like a calm keyboard-first client of a durable local engine. First sync finally finishes. Home stays snappy because lists are windows over a database, not a clone of every thread. AI still defaults to Groq with your keys. Nothing from this plan ships to main until an execution thread implements it.

> **What this means:** Aplos becomes a local mail server with a beautiful client — reliability first, phone pairing only when you want it, with no mailbox data on an Aplos cloud.

---

## 1. Process topology and lifecycle

### 1.1 Target shape

| Stage | Process that owns the store | How the UI reaches it | Lives after ⌘Q? |
|---|---|---|---|
| **Today** | `utilityProcess` child of Electron main | MessagePort via main | No |
| **A0** | Same `utilityProcess`, plus a 0600 Unix-socket / loopback listener | MessagePort for the app; socket/HTTP for CLI, preview, agents | No (but yes with window closed if resident) |
| **A1** | Node SEA nested helper `.app` registered with `SMAppService` as `agentService` | Main proxies over Unix socket; same typed contract | Yes, while logged in |
| **A2** | Same as A1 (or A0 if still resident) | Paired phone over LAN / Tailscale with pinned TLS | Phone only while Mac reachable |

This is Candidate A in `SYNTH-architecture.md` §11. The shared foundation F (normalized store, change log, governor, typed contract, AI jobs, HTML isolation, logging) is prerequisite and is the same for every topology (`SYNTH-architecture.md` §0 finding 4, §11.0).

**A0 details** (`gaps/macos-daemon-lifecycle.md` §9):

- Raise `LSMinimumSystemVersion` to 13.0 (Electron 44 already requires 13; the shipped 12.0 plist is a latent bug).
- Flip Electron fuses: `RunAsNode`, `NodeOptions`, `NodeCliInspect` off; asar integrity on. Keep `utilityProcess.fork` (unaffected by RunAsNode).
- Resident mode: menu-bar item with sync state, Open / Pause / Quit completely; accessory activation policy with no windows; start without a window when `wasOpenedAtLogin`; ⌘Q remains full quit.
- Forward `powerMonitor` resume / unlock to `engine.wake()`.
- Single-writer lock file on `aplos.db`; migrations only in the engine; data-key handoff behind an interface so A1 can swap `safeStorage` for a shared Keychain group later.

**A1 details** (`gaps/macos-daemon-lifecycle.md` §0, §2, §8–9):

- **Do not** run the same Electron binary as the LaunchAgent (blocks Squirrel updates) or ship a second Electron framework (~286 MB).
- Ship a **Node single-executable** in `Contents/Library/LoginItems/Aplos Mail Engine.app` (`LSBackgroundOnly`), plus a native shim (N-API or Swift sidecar) for Keychain, UserNotifications, and sleep/wake.
- Register with `app.setLoginItemSettings({ type: 'agentService', serviceName, openAtLogin })`; poll `status` afterward (the JS API returns void).
- **Prerequisite beyond Developer ID signing (already done per CONTEXT):** a Developer ID **provisioning profile** granting `keychain-access-groups` = `TEAMID.com.aplos.mail.shared` for both bundles. Profiles are not set up yet.
- Update choreography: UI asks daemon to drain → daemon exits → `quitAndInstall` → launchd starts the new binary. Version handshake on every connection; crash parking after >3 starts in 60 s.
- Idle footprint target: ~17 MB phys_footprint for the daemon vs ~53 MB for today's windowless Electron+utilityProcess stack (measured in the gap report).

**Honesty about costs.** Two lifecycles from A1 onward; version skew between UI and daemon; Keychain migration; packaging and notarization of a nested helper; Local Network prompts on macOS 15+ for agents; no work during sleep (Power Nap does not reliably give third-party agents CPU/network on Apple silicon — treat sleep as a hard ceiling for live sync).

> **What this means:** Keep one brain for the mailbox. First make that brain stay up with the windows closed (A0). Only then peel it into a tiny helper that survives quitting (A1). Phone comes last (A2).

---

## 2. Storage design

### 2.1 Schema sketch

Validated at 100k–1M synthetic messages (`gaps/storage-engine-benchmark.md` §0, §1):

```
accounts, labels
messages          — indexed columns, parts bitmask, UNIQUE(account_id, remote_id)
threads           — rollup recomputed by SQL aggregate on touched threads
message_labels    — WITHOUT ROWID
thread_labels     — (thread_id, label_id, last_date, unread) + keyset indexes
changes(seq PK)   — same transaction as the write; message + thread rows
bodies(message_id, codec, raw_size, data BLOB)  — zstd level 3
fts5(subject, people, body, content='', contentless_delete=1)  — shares message rowid
ops / outbox / jobs / notifications / timers     — durable side tables
```

Three tiers per message (Stalwart / Pimalaya / Geary pattern, `SYNTH-architecture.md` §5): (1) small mutable record (labels, flags, thread, change id); (2) immutable parsed metadata (headers, preview, MIME tree); (3) lazily fetched body. A `parts` bitmask makes partial failure, eviction, and refetch share one path.

**Measured outcomes** (`gaps/storage-engine-benchmark.md`): 50-row list pages 0.04–0.07 ms at any depth; unread counts ~0.5 ms; label change ~0.2 ms p50; cold first screen ~10 ms; Electron RSS ~65 MB at 1M scale (mostly runtime baseline). Whole-mailbox-in-memory cannot scale: V8 heap caps ~4 GB even with larger flags; 200k realistic messages ≈ 5.2 GB of HTML.

### 2.2 Bodies, FTS, retention

- **Bodies:** separate table of zstd-3 BLOBs, not content-addressed files (files used 32% more disk, opened threads 4.5× slower, and spent 54 s creating 200k files). Prefer storing **raw MIME** when the provider can supply it (`format=raw`, RFC822, Graph `$value`, JMAP blobs) and parse once locally (`SYNTH-architecture.md` §5).
- **FTS:** contentless FTS5 with `contentless_delete=1`. Indexing is ~80% of write cost — write FTS last in the transaction (1.8×), then move indexing to a paced background job. Prefer date-ordered message rowids so "newest 50 for term" is `ORDER BY rowid DESC` (~0.05 ms vs 32–40 ms). Keep server-search on Enter for lazy-body eras (`SYNTH-architecture.md` §5; Flectar dropped it — do not).
- **Eviction:** default **90 days of bodies** (Mailspring), headers forever; size-capped LRU as a secondary brake. Never delete the whole FTS index under pressure (Inbox Zero anti-pattern).
- **Driver:** keep `node:sqlite` for now; extend `SqlDatabase` to carry BLOBs. better-sqlite3 13 is only 6–8% faster and no longer needs Electron ABI rebuilds. One writer, read-only extras, WAL, `synchronous=NORMAL`, daily `wal_checkpoint(TRUNCATE)`.

### 2.3 Encryption at rest

**Decision in this proposal: FileVault + 0600 files + Keychain-wrapped secrets; no SQLCipher by default.** Benchmarks: AES page commits 4.2× slower and cold reads up to 14×; ChaCha20 2.2× / 6.5×; `node:sqlite` cannot load a codec (`gaps/storage-engine-benchmark.md` §0.6). Matches Delta Chat's choice after deprecating SQLCipher. Credentials and AI keys stay Keychain / `safeStorage` (A0) or data-protection keychain with access group (A1). Optional full-DB encryption remains a owner-toggle later if FileVault policy demands it — accept the driver switch cost then.

> **What this means:** Mail lives in a real database the server owns. Lists stay fast at huge scale. Bodies download when you open them. Disk encryption of the Mac is the default shield, not a second crypto layer that slows everything down.

---

## 3. Sync per provider

### 3.1 Shared rules (every provider)

From the metadata-first consensus (`SYNTH-architecture.md` §4.1–4.2):

1. Capture the incremental cursor **before** listing.
2. Commit each page in one transaction with its resume token.
3. Infer deletions only after a complete round within its scope (generation sweep / verify jobs) — fixes ignored `reset:true`.
4. Show new mail during long backfill (head catch-up before each resumed page).
5. Leave Spam/Trash out of the first pass; one backfill per account with live import ahead.
6. Silent baseline: no notifications or AI on the first sync import.
7. Exactly one process owns provider I/O and quota per mailbox (`SYNTH-architecture.md` §0 finding 6).

### 3.2 Gmail (REST under 6,000 units/min)

Facts (`protocols/proto-google.md` §0–1; CONTEXT): new projects get **6,000 units/user/min**. `threads.get` = 40 metadata / 120 full. Current first sync ≈ 500 full threads ≈ **60,000 units** → 403s. Batching saves RTT, not units. Search-as-you-type ≈ 12,000 units per pause — must die.

**Target algorithm:**

- First pass: Inbox (+ Sent) metadata newest-first; page commits; target ~75% of budget (~4,500 u/min). First 50 Inbox threads ≈ 1,000 units; 500 threads ≈ 10,000 units (~2.5 min).
- Bodies: on open or paced prefetch lane; never on the critical path of first sync.
- Incremental: `history.list` (2 units); apply label deltas from history records without refetch; fetch added messages as metadata; fetch unknown threads only if they gained INBOX. Key body freshness on content, not `historyId`.
- Polling cadence without Pub/Sub: ~15 s focused, 60 s background, 5 min hidden, and on wake (`SYNTH-architecture.md` §4.3).
- **Scope choice (owner decision):** stay on `gmail.modify` + `settings.basic` for now (recommended by the Google report); IMAP + `mail.google.com` only if bulk/IDLE become mandatory after verification. Both scopes are restricted → CASA likely either way.

### 3.3 Microsoft Graph

Cap: 4 concurrent requests and 10k / 10 min per app+mailbox (`protocols/proto-others.md`; `SYNTH-architecture.md` §3.3). Keep Graph (delta, immutable IDs, `messageRules`). Fix today's ~12-in-flight peak and "one 429 fails the whole sync." Delta per folder; do not bake filters into `deltaLink` that hide re-entering mail. Push needs a webhook (candidate C later); until then poll delta 30–60 s focused / 2–5 min background.

### 3.4 IMAP (iCloud, Yahoo, generic)

Two or three connections: IDLE on INBOX (+ Sent), priority command queue, optional bulk fetch. Re-issue IDLE every 5–25 min (Yahoo ~3 min). Capability ladder: QRESYNC → CONDSTORE + bounded expunge → windowed flag scans; STATUS to skip unchanged folders. Tiered fetch: envelope + BODYSTRUCTURE → text → attachments on open. Honor RFC 9738 `MESSAGELIMIT`. iCloud: assume no QRESYNC, ≤2 connections, append own Sent. Upgrade imapflow; stop swallowing `error` (`SYNTH-architecture.md` §3.4).

### 3.5 JMAP (Fastmail)

EventSource on `eventSourceUrl` with watchdog after two missed pings, reconnect throttle, `Retry-After`, wait-for-online, reconnect-on-wake (Mustang model). Use `preview` for lists. `/changes` every 60 s as fallback. OAuth registration required before distributing to others.

### 3.6 CalDAV / Google Calendar / iCloud calendars

Replace full 13-month query every 10 min with home PROPFIND → ctag/sync-token → `sync-collection` + multiget; expand recurrences client-side (Mailspring pattern). Never forward Basic credentials across origins (defect C3). Google Calendar webhooks need a relay for true push; otherwise poll with jitter.

### 3.7 Per-account actors

One actor per account owns: provider connections, governor lanes, op flush, incremental loop, backfill, and wake handling (`SYNTH-architecture.md` F6). Serialize token refresh per account; store refresh token + issuing client ID as one Keychain bundle; park on `invalid_grant` until reconnect; check granted scopes at exchange.

> **What this means:** Sync downloads the table of contents first, then the pages you open. Gmail stops blowing its minute budget. Each account has one orderly worker instead of four racing retry loops.

---

## 4. Governor and retry design

**One governor per account**, priced in provider units (`SYNTH-architecture.md` §4.4; Zero / Neverest / Bulwark lessons):

| Lane (priority high → low) | Typical share of Gmail budget |
|---|---|
| Interactive (open thread, search-on-Enter, send) | up to 100% when active |
| Op flush (user mutations) | high |
| Incremental (`history` / delta / IDLE wakeup) | ~90% |
| Body prefetch | medium |
| Backfill | ~70% |
| AI / FTS jobs | lowest; never starve sync |

Rules:

- **Reserve before send**; denied requests are deferred, never fired.
- **One retry layer** (turn SDK/provider auto-retries off or cap at zero). Aplos 0.2.3's two layers turn one 403 into a storm.
- Classify by reason **and** message text (Gmail per-minute refusals may only say `rateLimitExceeded`).
- **Daily / hard quota:** stop until reset (Pacific midnight for Gmail daily concepts); do not retry as if it were a burst.
- Cooldowns **persist** across restarts.
- A pause aborts sibling in-flight requests for that account.
- Target ~75% of the 6,000 u/min ceiling so interactive work has headroom.
- Graph: hard-cap concurrency at 4; treat each `$batch` sub-429 independently.
- IMAP: connection slots + byte/day budget + `MESSAGELIMIT`.

Poison items: quarantine with attempt counts and `next_retry_at` (comail/Flectar `sync_failures`, EmailEngine in-flight marker) instead of failing the whole run.

> **What this means:** The app spends Google's allowance like a budget, not a firehose. When the provider says stop, the app waits — it does not hammer the door.

---

## 5. Outbox, drafts, and timed features

### 5.1 Send safety

Keep Aplos's strengths (stable Message-ID, `sendAttemptAt`, `rfc822msgid:` reconciliation) and harden toward Bulwark / Superlocal / Inbox Zero (`SYNTH-architecture.md` §7):

1. Write durable **intent** before the network call.
2. On failure, classify **provably not sent** (safe to retry) vs **uncertain** (never blind-replay; reconcile via Sent search / placeholder Sent row).
3. Idempotent commands keyed by client-generated IDs across the contract.

### 5.2 Drafts sync

Close the daily-driver gap (local-only drafts today):

- **Gmail:** debounced autosave, fingerprint skip, serialized saves, `drafts.send`, map original draft ID → current ID.
- **IMAP:** UIDPLUS `APPENDUID` then delete previous copy.
- Deterministic Message-ID per revision so server copies reconcile (Nylas pattern).

### 5.3 Undo-send, send-later, Later, reminders

One mechanism: a durable queue row with `not_before` (comail / Flectar / Superlocal / Stalwart). Browser-memory holds are forbidden (Redakt `sendBeacon`, Zero's toast). If due time passed while the Mac was off: **suspend and re-validate**, do not silently send late (Bulwark laptop rule).

One timer process sleeps until the next deadline over a metadata-with-expiration table (Mailspring). Timers only fire while the owner process is alive — the main reason A0/A1 exist. Notifications: durable outbox keyed by message; clients **claim** once there are several (comail/Flectar).

> **What this means:** Sends and reminders survive restarts. Undo-send and send-later are the same reliable queue. Nothing important lives only in a toast.

---

## 6. AI pipeline

### 6.1 Jobs, not the sync path

Move enrichment off the sync critical path (`SYNTH-architecture.md` F5):

- Durable `jobs` table: singleton keys, exponential backoff, dead-letter, budget column (tokens / $ / provider).
- Job kinds: summarize Home card, reader summary, draft suggestion, Ask retrieval prep, FTS index, calendar enrichment.
- **Silent baseline:** first-sync imports enqueue nothing; only post-baseline arrivals do.
- **Heuristic-first Home:** header / list rules (VIP, mailing-list, calendar invite, urgency lexicons) produce a usable card before any LLM call; AI upgrades the same fields asynchronously. Matches owner taste for big summaries without blocking triage.
- Priority: never take interactive or incremental governor lanes.

### 6.2 Consent, providers, keys

- Groq default; BYO keys for OpenAI, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio, custom OpenAI-compatible (AGENTS.md / DECISIONS).
- Keys only in sealed vault / Keychain; never in state, SQLite, logs, or commits.
- Per Google Workspace API policy (2026-09-03, `protocols/proto-google.md`): generative summaries OK; protect against prompt injection; **per-invocation consent for agentic tool use**; no training on inputs. Unpaid Gemini must not receive Gmail content.
- Ask / Space primary actions stay **preset-only** (`SuggestedAction`), never generated code (DECISIONS 2026-10-20).
- No sparkle / wand / star glyphs (owner taste).

### 6.3 Budget

Per-account AI budget: daily token/cost cap in Settings; jobs pause with a clear status when exhausted. Shared with the governor's AI lane so a summary storm cannot starve sync.

> **What this means:** Home works even before AI answers. Summaries and drafts run in the background with your keys and your consent. Sync never waits on Groq.

---

## 7. UI-to-engine contract and transport

### 7.1 Contract (JMAP semantics, RPC envelope)

From `gaps/engine-contract-rpc-stack.md` §0:

- Per type: `get`, `changes`, `set`, `query` with opaque state strings, `cannotCalculateChanges`, `maxChanges`, client creation IDs, `ifInState`.
- Wire: `{id, method, args}` over MessagePort / WebSocket; HTTP `POST /v1/call/<Type>/<verb>`.
- **Do not** implement full RFC 8621 batch envelopes or `queryChanges` for list views.
- **Live windows** (≤ ~200 body-free rows): engine re-runs each open window's keyset query after relevant commits (coalesced 100 ms–1 s); pushes `{windowId, state, ids, total, changed}`; clients `Thread/get` for rows. Measured: full-ID dump at 100k threads = 39 ms / 1.2 MB vs 0.12 ms for a 100-row window.
- Blobs and sanitized HTML: GET routes (`/blob/:id`, `aplos-mail://m/<token>`).
- Schema: zod v4 in a platform-neutral `contract` module; thin registry (~500 lines) generates allowlists for preload / main / server, typed TS client by inference, OpenAPI 3.1 for Swift later. Reject tRPC / Cap'n Web / Mustang-style transparent object RPC.
- Persist change log as `{dbEpoch, seq}` opaque tokens in the **same transaction** as store writes. Gap → `changes(since)` catch-up, not full re-snapshot. Truncation → `cannotCalculateChanges` / `reset.required` (Stalwart / Superlocal). **Acceptance:** restarting the engine never forces every window to re-download the mailbox.

Private `urn:aplos` types carry workflow state, summaries, Later, reminders — JMAP clients would not understand them anyway (`gaps/engine-contract-rpc-stack.md` §2).

### 7.2 Transport matrix

| Client | Transport | Auth |
|---|---|---|
| Renderer ↔ main | MessagePort / IPC (keep) | Electron fuses + `assertCaller` |
| Main ↔ engine (A0) | MessagePort | parent relationship |
| CLI / MCP / preview (A0+) | Unix socket 0600 + token, or loopback HTTP+WS | Per-client token, Host/Origin allowlist |
| Main ↔ A1 daemon | Unix socket + token; optional `LOCAL_PEERPID` + code-sign check | Same |
| Phone (A2) | HTTPS/WSS over LAN or Tailscale | QR pairing, pinned cert/PSK, scoped revocable device sessions, short-lived tickets (T3 Code pattern) |

Latency is not the decider: MessagePort / Unix / loopback HTTP are all sub-millisecond for small JSON (`gaps/macos-daemon-lifecycle.md` §7). Choose on security and lifecycle.

**SSE / WebSocket resume:** journal events carry monotonic ids; clients send `Last-Event-ID` / `since`; below floor → `reset.required` and re-open windows. Coalesce pushes; events are IDs/state only (Bulwark bug: state bump without diff → missed mail).

> **What this means:** Every surface speaks one typed language. Lists subscribe to small windows of IDs. After a crash, clients catch up from a durable journal instead of reloading everything.

---

## 8. Email HTML isolation

Follow the tested prototype (`gaps/electron-email-html-isolation.md` §0):

- Serve each message from custom origin `aplos-mail://m/<token>` via `protocol.handle`.
- Iframe: opaque origin, sandboxed, **one hash-pinned height/paper-color script** of ours (`postMessage`). Email scripts stay blocked by the hash.
- CSP as **HTTP response header** (`default-src 'none'`, tight `img-src` via image proxy, `base-uri 'none'`, `form-action 'none'`). Host CSP is not inherited on custom schemes.
- Shared OOPIF renderer for all mail frames (~+22–35 MB for a 20-message thread), not one process per message.
- Keyboard: main-process `before-input-event` (trusted OS input), never forwarded from the frame.
- Link navigation: cancel in `will-frame-navigate` / `setWindowOpenHandler`; open externally.
- Sanitize in the **engine**, not only in the privileged renderer. Stop `dangerouslySetInnerHTML` of mail in the main frame.
- Acceptable one-day stopgap: opaque `srcdoc` without scripts — still far better than today, still weaker than custom-origin OOPIF against codec bugs (CVE-2023-4863 class).

> **What this means:** Hostile mail runs in a locked box next door, not inside the window that can send mail. Layout and images come back; scripts do not.

---

## 9. Observability and diagnostics

Aplos has none today (`SYNTH-architecture.md` §9). Local-server topology makes this mandatory (engine runs with no window):

- Rotating redacted log file; redaction on the root logger (EmailEngine).
- Ring buffer tagged by account/folder, snapshotted into every UI error (Geary).
- Time-boxed verbose protocol log toggle (Mailspring).
- Per-account **status vocabulary** driving both UI and retry: discovering, importing N of M, paused until T, retrying, blocked auth, unreachable (Zero / Geary).
- Content-free diagnostics bundle + queue inspector (Inbox Zero); scrubbed crash reporter.
- Event-loop delay monitor + per-account heartbeats (Nylas / EmailEngine).
- Long-term: typed event catalog with stable IDs (Stalwart).

**Acceptance:** from a hung sync, the owner can export a diagnostics zip that contains no message bodies, no tokens, and enough governor/status history to see whether the pause is quota, auth, or network.

> **What this means:** When mail stalls, you get a clear status and a safe diagnostics dump — not a silent spinner.

---

## 10. Security

### 10.1 Local listener (`SYNTH-architecture.md` §10; Superlocal / Mailspring / comail MCP lessons)

1. Bind loopback or **0600 Unix socket** only; never `0.0.0.0` by default (Bulwark anti-pattern).
2. Per-client token on every request; constant-time compare; hand to UI out of band; keep token out of the renderer while mail HTML still shares a process.
3. Exact Host + Origin allowlist; never reflect CORS (Nylas / fragile Aplos `server.ts`).
4. Typed scoped operations only — no raw SQL, paths, or sockets (Tuta / Mustang anti-patterns).
5. Token scopes: read / draft / send; device list + revoke; audit remote sends/deletes.
6. Daemon reads Keychain itself; never pass secrets on stdin (Mailspring). Do not use `ELECTRON_RUN_AS_NODE` as a helper path once fuses are off.
7. Replace today's unauthenticated `server.ts` with the same contract + tokens even for browser preview.

### 10.2 Electron hardening

- Fuses as in §1; CSP without `'unsafe-eval'` in the app frame.
- `assertCaller` remains for privileged IPC; mail frames fail it by design.
- Provisioning profiles for keychain-access-groups before A1 key migration.
- Identity note: do not brand the product "Airmail" (`gaps/identity-collision-audit.md`); keep Aplos naming and the sky/hill/envelope icon motif.

### 10.3 Phone pairing (A2)

QR with host certificate fingerprint or 256-bit PSK; TLS pin at pairing; Bonjour only on opt-in; scoped revocable sessions with proof-bound short-lived tickets (T3 Code, not OpenCode shared password). Tailscale app route preferred for off-LAN before embedding TailscaleKit.

> **What this means:** Anything that can talk to the local server must prove it was invited. The open "dev server with no password" shape goes away.

---

## 11. Multi-device and phone future

**Hub model.** One Mac engine owns provider quota and AI. A thin phone spends **zero** Gmail/Graph quota (`gaps/phone-mac-connectivity.md` §5, §7) — A2's real advantage over "engine on every device" (Candidate D).

**A2 path (recommended when a phone is wanted):**

1. Design A0 auth as if a phone already existed (scoped sessions, revoke, tickets).
2. First phone: LAN + Tailscale app; QR pairing; thin client (no OAuth, no AI keys).
3. CloudKit (needs provisioning profile): workflow sync alternative to the hidden Gmail label; Mac-originated visible alerts via `CKQuerySubscription` + NSE; snapshot + command mailbox while the Mac sleeps.
4. Defer Candidate C (Aplos-hosted Pub/Sub/APNs relay) and D (full phone engine) until the owner needs alerts/actions while the Mac sleeps. Sleeping Mac remains the ceiling for **live** access; CloudKit softens it to store-and-forward.

**Honesty:** Within email clients, no production phone→desktop-daemon exists; outside email, T3 Code / KDE Connect / Home Assistant raise A2 precedent to medium-high (`gaps/phone-mac-connectivity.md` §0). Always-on automation while asleep still needs provider-side filters (Gmail filters, Graph `messageRules`, Sieve) or a hosted component that holds tokens — out of SPEC bounds today.

App-owned metadata (workflow, AI, rules) stays a separate cursor-paged feed from mailbox facts (Inbox Zero `assistant_entries`).

> **What this means:** Your Mac is the hub. A phone is a paired remote control that works when the Mac is awake and reachable. Sleeping-Mac magic is a later, separate choice.

---

## 12. Migration from today's code (app stays usable)

Order is additive: **B-shaped foundation inside the current `utilityProcess`, then A0 listener, then A1, then A2.** Each step keeps the app launchable.

| Step | Work | Usability bar | Rough effort |
|---|---|---|---|
| **M0** | Feature-flag plumbing; dual-read settings; no behavior change | Ship as today | 2–3 days |
| **M1 = F1** | Gmail metadata-first + governor + search-on-Enter only | First sync completes under quota on a real test mailbox | 1–2 weeks |
| **M2 = F2** | Normalized schema behind a store port; migrate JSON thread blobs → rows in background; UI still works on old shape until cutover | Memory stable on large demo; no whole-mailbox clone | 2–3 weeks |
| **M3 = F3** | Durable `changes` table; opaque state; renderer moves to live windows | Restart does not full-resnapshot | 1–2 weeks (overlap M2) |
| **M4 = F4** | Schema-first contract; single generated allowlist | Preview and desktop share validators | 3–5 days |
| **M5 = F5–F6** | Jobs table; AI off sync path; per-account actors (IDLE, EventSource) | Home heuristics before AI; IMAP IDLE on iCloud | 1.5–2.5 weeks |
| **M6 = F7–F8** | HTML isolation + logging/diagnostics | Reader uses sandboxed origin | ~1.5 weeks |
| **M7 = A0** | Resident mode + Unix socket listener + wake hooks + lock file | Sync with windows closed; CLI can call local API | 1.5–2 weeks after M4 |
| **M8 = A1** | SEA helper, shim, SMAppService, key migration | Sync after ⌘Q; updates drain cleanly | 3.5–5 weeks after M7; **blocked on keychain-access-groups profile** |
| **M9 = A2** | Pairing, LAN/Tailscale routes, thin phone | Owner pairs one phone on home Wi-Fi | 2–4 weeks host + months for polished iOS |

**Cutover rules:**

- One writer always; never open `aplos.db` from two processes.
- Migrations run before binding the listener.
- Keep demo / isolated storage for autonomous verification; do not send external mail as part of agent tests (AGENTS.md).
- Do not merge unrelated PR #21 as part of this work (CONTEXT).
- Reversibility: through M7, topology can fall back to "evolved utilityProcess" (Candidate B). A1/A2 are harder once a phone depends on them.

> **What this means:** You keep using Aplos the whole time. Sync gets fixed first. The "local server" appears as a quiet upgrade, then as a background helper, then as a phone pairing option.

---

## 13. Effort (one owner + AI agents)

| Block | Weeks | Notes |
|---|---|---|
| Foundation F (M1–M6) | **6–10** | Consensus across audits; heavy overlap; live verification is the bottleneck |
| A0 (M7) | **1.5–2** | After typed contract (M4) |
| A1 (M8) | **3.5–5** | After profile + verified second-Mac signing flow |
| A2 host half (M9) | **2–4** | Thin client is additional product months |
| Optional CloudKit glue | **2–4** | After profiles |
| Optional poke relay C | **2–4 + ops** | Only if sleep-time provider push is required |

**Calendar sketch if phone is not a 6-month goal:** F + A0 ≈ **8–12 weeks** to a daily-driver local-server desktop. Defer A1 until "sync after quit" or headless agent access is painful.  
**If phone is in-scope:** add A1 sooner (pairing wants a daemon that outlives the UI), then A2 — total on the order of **4–6 months** including a first iOS client, assuming Google verification/CASA proceeds in parallel.

Effort numbers are ordering aids; reports disagree by up to ~3× on LaunchAgent alone (`SYNTH-architecture.md` §12.2). Writing code has not been the bottleneck (high commit rate); **live mailbox verification and external OAuth/verification** have.

> **What this means:** Plan on roughly two to three months for a trustworthy local-server desktop. A background helper and a phone are optional sequels with real packaging cost.

---

## 14. Top risks

1. **Gmail quota / verification.** Until metadata-first ships and Cloud console confirms the 6,000 u/min ceiling, Gmail remains unusable. CASA and Testing-mode OAuth block real users (`protocols/proto-google.md`; CONTEXT).
2. **Listener security mistakes.** Most common failure mode in the corpus (Nylas credential = account id, Bulwark `0.0.0.0`, Mustang raw capabilities, Tuta raw SQL, Aplos `server.ts` with no token).
3. **Change-log correctness.** Bulwark shipped delta bugs that only appeared once clients relied on them — budget replay tests before A2.
4. **A1 packaging / Keychain.** Signing exists, but **provisioning profiles** for access groups do not (CONTEXT). Wrong DR → Keychain prompts every update; wrong update choreography → stuck ShipIt or mismatched helpers (`gaps/macos-daemon-lifecycle.md`).
5. **Sleep ceiling.** Owners will expect send-later and phone triage while the lid is shut. Without C or D, that expectation is false — set it explicitly in product copy.
6. **UI migration cost.** Moving off whole-mailbox `AppState.threads` onto windows is the largest contract piece (1.5–3 weeks) and can stall if under-scoped (`gaps/engine-contract-rpc-stack.md` §0).
7. **Private GitHub / distribution.** Repo is private; download and update feed 404 for others (CONTEXT). Architecture assumes eventual open source but must not depend on a public update CDN yet.
8. **No email-native A2 precedent.** Phone-to-Mac is proven outside mail; treat first phone as a beta surface with hard revocation and kill-switch.

> **What this means:** The scary parts are Google's limits, locking down the local port, and promising phone magic the sleeping Mac cannot deliver. Everything else is hard engineering with clear precedents.

---

## Decisions for you

1. **Is a phone on the roadmap within six months?**  
   - **Options:** (a) No — stop after F+A0. (b) Yes, thin client of the Mac (A2). (c) Yes, and it must work while the Mac sleeps (adds CloudKit store-and-forward and/or C/D).  
   - **Recommended default:** (a) if unsure; design auth for (b) anyway.  
   - **If (a):** all known sync/memory bugs still get fixed. **If (b):** schedule A1 earlier. **If (c):** accept SPEC tension around any hosted poke relay and/or put an engine on the phone.

2. **Gmail scopes before verification?**  
   - **Options:** (a) Stay on `gmail.modify` + `settings.basic` (REST + governor). (b) Add `https://mail.google.com/` for IMAP bulk + IDLE.  
   - **Recommended default:** (a).  
   - **If (a):** quota-bound but one code path; first sync becomes minutes not impossible. **If (b):** free doorbell and bulk bandwidth; scarier consent string ("permanently delete"); second protocol path.

3. **First-sync depth?**  
   - **Options:** (a) Newest ~500 Inbox/Sent threads metadata. (b) 30 days. (c) 14 days (Geary-like).  
   - **Recommended default:** (a) with live UI during backfill.  
   - **Trade-off:** deeper history burns more of the 6,000 u/min budget before the mailbox feels "done."

4. **Body retention?**  
   - **Options:** (a) 90 days then refetch. (b) Size-capped LRU. (c) Keep forever.  
   - **Recommended default:** (a) + soft LRU cap.  
   - **If (c):** disk grows without bound; fine on large SSDs only.

5. **Encrypt `aplos.db` at rest?**  
   - **Options:** (a) FileVault + 0600 only (this proposal). (b) SQLCipher / SQLite3MC.  
   - **Recommended default:** (a).  
   - **If (b):** accept 2–4× sync slowdown and a driver change; better for multi-user Macs without FileVault.

6. **When to build A1 (LaunchAgent)?**  
   - **Options:** (a) Immediately after A0. (b) Only once "sync after ⌘Q" or headless agents hurt.  
   - **Recommended default:** (b), after the keychain-access-groups profile exists.  
   - **If (a):** earlier phone-ready daemon; more packaging risk in parallel with sync work.

7. **Hosted content-free push relay (Candidate C)?**  
   - **Options:** (a) Never — poll + provider filters. (b) Opt-in poke relay (mailbox id + push token only). (c) Full always-on automation with tokens on a server.  
   - **Recommended default:** (a) now; revisit (b) only for sleep-time phone alerts.  
   - **If (c):** contradicts SPEC's "no Aplos server stores user data" and widens CASA; effectively becomes Inbox Zero.

8. **Contract envelope preference (confirm gap-report recommendation)?**  
   - **Options:** (a) JMAP verbs + RPC-per-method (recommended). (b) Resource REST + SSE journal (Superlocal).  
   - **Recommended default:** (a).  
   - **If (b):** friendlier curl/OpenAPI; larger migration from today's `invoke(method, payload)`.

---

## Acceptance criteria (for later execution threads)

- [ ] Real Gmail test user: first sync completes without 403; governor never exceeds ~4,500 u/min sustained; search costs units only on Enter.
- [ ] Restart engine: open list windows catch up via `changes(since)` with no full mailbox snapshot.
- [ ] Kill renderer: sync and send-later continue under A0 resident mode.
- [ ] Mail HTML: hostile payload with inline script and tracker `url()` cannot reach `window.aplos` or load arbitrary https images; height still reports.
- [ ] Local listener: unauthenticated loopback call fails; revoked device token fails; CORS reflection absent.
- [ ] Diagnostics zip: no bodies, no refresh tokens, includes per-account status and last governor pause reason.
- [ ] A1 (when built): ⌘Q UI; daemon still IDLE/polls; update drain → relaunch without Keychain prompt on Developer ID + profile builds.
- [ ] A2 (when built): phone pairs by QR; reads inbox windows; send requires confirm scope; Mac asleep → clear offline state (no silent data loss).

---

## Research index (cited)

| Path | Used for |
|---|---|
| `research/email-clients/SYNTH-architecture.md` | Topology candidates, sync, storage, governor, AI jobs, security, effort |
| `research/email-clients/gaps/macos-daemon-lifecycle.md` | A0/A1 mechanics, footprints, Keychain, updates |
| `research/email-clients/gaps/phone-mac-connectivity.md` | A2 precedents, Tailscale, CloudKit, quota sharing |
| `research/email-clients/gaps/engine-contract-rpc-stack.md` | JMAP semantics, live windows, zod registry |
| `research/email-clients/gaps/storage-engine-benchmark.md` | Schema, FTS, bodies, encryption decision |
| `research/email-clients/gaps/electron-email-html-isolation.md` | Custom-origin OOPIF reader |
| `research/email-clients/gaps/identity-collision-audit.md` | Naming / brand collision caution |
| `research/email-clients/protocols/proto-google.md` | Gmail units, push, CASA, adapter defects |
| `research/email-clients/protocols/proto-others.md` | Graph, IMAP, JMAP, CalDAV |
| `plans/_council/CONTEXT.md` | Overrides: Developer ID present; profiles not; owner taste |
| Main `DECISIONS.md` / `AGENTS.md` / `MOBILE.md` | Product constraints, AI keys, mobile intent |

---

*End of local-server-first architecture proposal. No other files modified in this planning pass.*
