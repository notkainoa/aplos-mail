# Architecture proposal: portable engine on every device (Candidate D)

**Angle.** Make the mail engine a platform-neutral core (`packages/engine`) that runs embedded on every device: Mac now, iPhone later via a JS runtime (or a thin native port of the same contract). Devices talk to providers directly. Cross-device workflow state rides CloudKit and/or the existing encrypted provider-side channel. An optional stateless push relay (Candidate C) can be layered later for provider-originated wakes. The Mac does not have to be awake for the phone to work.  
**Evidence base.** `research/email-clients/SYNTH-architecture.md` §11 Candidate D; `MOBILE.md` on main; gap reports under `research/email-clients/gaps/` (especially `phone-mac-connectivity.md`, `storage-engine-benchmark.md`, `engine-contract-rpc-stack.md`, `electron-email-html-isolation.md`, `macos-daemon-lifecycle.md`); protocol reports under `research/email-clients/protocols/`; Aplos DECISIONS (2026-10-15 multi-provider / workflow sync). Facts that override older research notes are in `plans/_council/CONTEXT.md` (Developer ID signing and notarization exist; CloudKit / keychain-access-group provisioning profiles do not).  
**Word target.** Planning document for later execution by architecture threads. No implementation in this phase.

---

## In plain English

Today Aplos is a Mac app whose brain already aims to be portable: the engine bundles without Node, and a spike proved it can run in JavaScriptCore. The product plan on record is the same idea — one shared engine on desktop now and on a phone later, with no Aplos server holding your mail. This proposal takes that plan seriously as the *target* architecture, not a distant maybe.

What changes: we lift the engine into a real shared package, fix the sync and storage foundations so Gmail works under the new quota, and design every Mac feature so a second engine on a phone can run the same code against the same providers. Your Done / Later / reminders sync through CloudKit when you are in Apple's world, or through the encrypted hidden-folder channel that already exists, so the phone does not need your Mac online. New mail on the phone comes from Google, Microsoft, Fastmail or iCloud directly — not from a daemon on a sleeping laptop.

Why it matters: a phone that only works while your Mac is awake is a thin remote control, not a mail client. Five production mail projects already ship "engine per device." The hard part is honesty about cost. Gmail's per-user limit is shared across every device in the same Google Cloud project, so a Mac sync and a phone sync can starve each other. AI keys and OAuth live on every device. iOS background time is short, so timely alerts still need CloudKit pushes or, later, a tiny poke relay. This is the path where the phone is real — and where quota discipline is non-negotiable.

What you get on the Mac first: the same foundation every topology needs (metadata-first sync, normalized store, governor, typed contract, AI jobs, safe HTML). The portable bet adds packaging and multi-device rules from day one, so the phone is not a rewrite. Nothing from this plan merges to main until an execution thread implements it.

> **What this means:** One shared brain on every device you own. The Mac can sleep; the phone still syncs. You pay for that independence with a shared Gmail budget and more moving parts to keep honest.

---

## 1. Process topology and lifecycle

### 1.1 Target shape

| Stage | Where the engine runs | Who owns provider I/O | Lives while Mac sleeps? |
|---|---|---|---|
| **Today** | Electron `utilityProcess` on Mac | That one process | No |
| **D0 — Mac foundation** | Same topology, but core lives in `packages/engine` with ports for SQL, keychain, sockets, OAuth, timers | One Mac process per mailbox (unchanged) | No |
| **D0′ — resident Mac** | Optional menu-bar resident mode (same as Candidate B/A0 without a network API) | Same | No — lid shut still stops live sync |
| **D1 — phone engine** | React Native / Hermes or JSC host loads the same bundle; native ports for SQLite, Keychain, TLS sockets, system OAuth | **Each device** talks to Gmail / Graph / IMAP / JMAP | **Yes** for mail and triage the phone can do alone |
| **D+C — optional relay** | Stateless poke relay for Pub/Sub / Graph webhooks / APNs | Devices still own I/O; relay only says "mailbox X changed" | Alerts yes; actions still need a device awake |

This is Candidate D in `SYNTH-architecture.md` §11.4–11.5, aligned with DECISIONS 2026-10-15 and `MOBILE.md`. Precedents that ship it: Pimalaya (Android), Flectar, Mustang (nodejs-mobile), Delta Chat (FFI), and likely Inbox Zero's iPhone app. **No studied email project uses the Mac as the only hub for a sleeping-phone-independent client** — D is the evidence-backed path for that requirement (`SYNTH-architecture.md` §0 finding 3; `gaps/phone-mac-connectivity.md` §0 softens A2 but confirms live Mac-hub access dies on sleep).

### 1.2 What stays on the Mac shell vs what moves to the package

**Into `packages/engine` (platform-neutral, already the intent of `tests/portability.test.ts` and `MOBILE.md`):** store, merge rules, sync orchestration, governor, op queue, outbox, drafts, timers metadata, AI job scheduling, workflow merge, provider *contracts*, Gmail/Graph/JMAP/CalDAV HTTPS adapters (fetch-based), change-log / window queries, HTML sanitize pipeline (output only).

**Stay in device hosts (`apps/desktop`, later `apps/mobile`):** Electron main / utilityProcess wiring; `safeStorage` or Keychain unwrap of the data key; notifications; `openExternal`; IMAP/SMTP raw sockets (behind existing `ImapSession` / `SmtpSender` ports — mobile needs `react-native-tcp-socket` or MailCore2); OAuth loopback vs `ASWebAuthenticationSession`; CloudKit native helper; sandboxed mail iframe / WKWebView; UI.

**Do not require a LaunchAgent for D.** Resident mode (D0′) is nice for Mac-only timers with windows closed; it is not the phone story. If A1 is ever wanted for CLI/MCP with the UI quit, it layers on later (`gaps/macos-daemon-lifecycle.md`) — but a network listener is *optional* here, not the spine.

### 1.3 Lifecycle rules that make multi-device safe

1. **Exactly one writer per local database file** (WAL, mutex). Phone and Mac never share a file; they share *provider* and *workflow* state (`SYNTH-architecture.md` §0 finding 6 applies *per device*, then a cross-device quota lease — §9).
2. **Crash restart** stays as today: utilityProcess (Mac) or OS process death (phone); durable ops and cursors mean restart resumes a page, not the mailbox.
3. **Sleep / background:** Mac `powerMonitor` → `engine.wake()` for catch-up. Phone: BGAppRefresh is short and unguaranteed; visible CloudKit pushes and/or Candidate C are required for timely alerts (`gaps/phone-mac-connectivity.md` §4).
4. **Single-flight sync per account *per device***, plus a **cross-device soft lease** for Gmail units (CloudKit or workflow channel) so two engines do not both run a 4,500 u/min backfill at once (§9).

> **What this means:** The Mac app keeps looking like an app. Under the hood the brain is a library you can also run on a phone. Closing the laptop lid does not turn the phone into a brick.

---

## 2. Storage design

### 2.1 Schema sketch

Same validated shape as every candidate (`gaps/storage-engine-benchmark.md` §0–1; `SYNTH-architecture.md` §5):

```
accounts, labels
messages          — indexed columns, parts bitmask, UNIQUE(account_id, remote_id)
threads           — rollup via SQL aggregate on touched threads
message_labels    — WITHOUT ROWID
thread_labels     — (thread_id, label_id, last_date, unread) + keyset indexes
changes(seq PK)   — same transaction as the write
bodies(message_id, codec, raw_size, data BLOB)  — zstd-3
fts5(subject, people, body, content='', contentless_delete=1)
ops / outbox / jobs / notifications / timers
workflow_entries  — local copy of the multi-device log
quota_leases      — optional soft leases for shared Gmail budget (device_id, until, lane)
```

Three tiers per message: mutable flags/labels; immutable parsed metadata; lazy body. `parts` bitmask unifies partial fetch, eviction, and refetch.

**Measured:** 50-row pages 0.04–0.07 ms at any depth; unread ~0.5 ms; label change ~0.2 ms p50; cold first screen ~10 ms; ~65 MB Electron RSS at 1M scale. In-memory whole-mailbox clones cannot scale (V8 ~4 GB cap; 200k HTML bodies ≈ 5.2 GB).

### 2.2 Bodies and blobs

- **Default:** separate `bodies` table, zstd level 3 (`gaps/storage-engine-benchmark.md` §0.4). Content-addressed files used 32% more disk and opened threads 4.5× slower at 200k.
- **Extend `SqlDatabase` port for BLOBs** (`Uint8Array`) so Mac `node:sqlite` and mobile op-sqlite / expo-sqlite share one path. Driver is not the bottleneck; keep `node:sqlite` on desktop for now.
- **FTS:** write FTS last in the transaction (1.8×), and move body indexing to a paced job (FTS is ~80% of write cost). Prefer date-ordered message rowids so "newest hits" stay ~0.05 ms.

### 2.3 Encryption at rest

**Decision for D:** rely on **FileVault / iOS data protection + 0600 files + Keychain-wrapped data key**, not SQLCipher by default. Benchmarks: AES page commits 4.2× slower, cold reads up to 14×; ChaCha20 still 2.2× / 6.5×; and `node:sqlite` cannot load a codec (`gaps/storage-engine-benchmark.md` §0.6). Delta Chat made the same call. Credentials never beside the DB (already true). Phone: platform Keychain / Keystore instead of `safeStorage`.

### 2.4 Retention and eviction

Default recommendation matching Mailspring's spirit: keep **~90 days of bodies**, headers forever, size-capped LRU for very large mailboxes; refetch costs Gmail 20–60 units so eviction must be gentle (`SYNTH-architecture.md` §5; storage gap §0). Phone disks are smaller — same policy, tighter size cap (e.g. 500 MB bodies). First sync is a **silent baseline**: no notifications or AI until live arrivals (EmailEngine / Flectar pattern).

### 2.5 Change log

Persist `{dbEpoch, seq}` opaque state tokens in the same transaction as writes (`gaps/engine-contract-rpc-stack.md` §0). Truncation → `cannotCalculateChanges` / `reset.required`, never a silent desync. This is required for multiple windows on Mac and for any future local listener; on phone it keeps the UI cheap across process death.

> **What this means:** Mail lives in a real database on each device, not a giant blob in RAM. Bodies load when you open them. Secrets stay in the system keychain. Old bodies can be dropped and fetched again when needed.

---

## 3. Sync per provider

### 3.1 Shared rules (every provider)

From the consensus family in `SYNTH-architecture.md` §4:

1. Capture the incremental cursor **before** listing.
2. Commit each page with its resume token in one transaction.
3. Infer deletions only after a complete round within that round's scope (fixes ignored `reset:true`).
4. Show new mail during long backfill (head catch-up / parallel new-mail poller).
5. Leave Spam/Trash out of first pass; one backfill per account; live import ahead of it.
6. Confirmed vs effective state with pending ops overlaid (Inbox Zero / Superlocal), replacing clone/`touched` heuristics.

### 3.2 Gmail — metadata-first under 6,000 units/min

**Facts** (`protocols/proto-google.md` §0–1; CONTEXT): new projects get **6,000 units/user/project/min**. `threads.get` = 40 (120 full); `messages.get` = 20 (60 full/raw). Today's 500 × full threads ≈ **60,000 units** → 403. Batch saves RTT, not units. Search-as-you-type at full format ≈ 12,000 units per pause — must die.

**Target algorithm:**

| Phase | Calls | Rough units |
|---|---|---|
| First 50 Inbox threads, newest message metadata | list + metadata gets | ~1,000 |
| First 500 threads metadata | | ~10,000 (~2.5 min at 4,500 u/min target) |
| Open thread | one full get | 60–120 |
| Incremental | `history.list` (2) + metadata for adds; apply label deltas from history records with **no** refetch | cheap |
| Server search | on Enter only; ~25 results metadata | ~500 |

**Governor:** one per account per device, priced in Gmail units; lanes interactive / op flush / incremental / body prefetch / backfill / AI; target **~75%** of budget; denied requests deferred, never sent; one retry layer; daily/`quotaExceeded` → stop until reset (Neverest / Zero pattern; Aplos 0.2.3's double retry of daily quota is a bug — `SYNTH-architecture.md` §0 finding 9).

**Scope choice (owner decision):** stay on `gmail.modify` + `settings.basic` (one path, quota-bound) vs add `mail.google.com` for IMAP bulk + IDLE (scary consent string). Research recommends shipping (a) with the governor first (`SYNTH-architecture.md` §3.2).

**Multi-device tax:** Mac + phone in the **same Cloud project share 6,000 u/min** (`gaps/phone-mac-connectivity.md` §5). A separate phone project doubles verification/CASA. Soft leases (§9) are mandatory under D.

### 3.3 Microsoft Graph

Cap **4 concurrent** and 10k/10 min per app+mailbox (`protocols/proto-others.md` §1). Unordered `$batch` = 4 in flight; retry sub-429s only. Drop permanent `receivedDateTime` filter from the initial delta (baked into deltaLink — hides re-entering mail). Adaptive polling 30–60 s focused / 2–5 min background. Optional IMAP IDLE doorbell needs extra scope and may be tenant-disabled. Immutable IDs already correct in Aplos.

**Shared across devices** with the same app registration — phone and Mac share the 4 slots.

### 3.4 IMAP (iCloud, Yahoo, generic)

Two connections max: IDLE on INBOX (+ Sent if useful); command connection for user actions and outbox; optional third for bulk only if the host allows (`SYNTH-architecture.md` §3.4). Re-IDLE every 5–25 min (Yahoo ~3). Capability ladder: QRESYNC → CONDSTORE + bounded expunge → windowed scans. **iCloud:** disable QRESYNC; ≤2 connections; append own Sent. Respect `MESSAGELIMIT` (Yahoo 1000); never infer deletion from a partial answer. Tiered fetch: envelope + BODYSTRUCTURE → text → attachments on open. Upgrade imapflow 2.4.3 → 2.9.x; stop swallowing `error`.

**Portable cost:** HTTPS adapters travel; IMAP needs native TLS sockets on phone (`MOBILE.md`). Connection caps are **per account across clients** — two devices × two connections can hit iCloud's low cap (`protocols/proto-others.md` §0.10). Prefer phone IDLE only while foreground; Mac holds the long IDLE when both are on.

### 3.5 JMAP and CalDAV

- **JMAP:** use `eventSourceUrl` (Aplos ignores it today — defect). Mustang loop: watchdog after missed pings, reconnect throttle, `Retry-After`, wait-for-online, reconnect-on-wake. Use `preview` for lists. Fastmail OAuth for distributed apps.
- **CalDAV:** home PROPFIND for ctag/sync-token → `sync-collection` / multiget; client-side recurrence expand; never forward Basic across origins (defect C3). Stop full 13-month query every 10 min.

> **What this means:** Every provider gets a polite, page-by-page sync. Gmail stops drowning itself. The phone uses the same recipes — but must share the Gmail minute-budget with the Mac.

---

## 4. Governor and retry design

**One governor module in `packages/engine`, parameterized per provider:**

| Provider | Currency | Hard caps |
|---|---|---|
| Gmail | units / sliding minute | 6,000 u/user/project; target 4,500; batch ≤10–25 (Neverest refusal curve) |
| Graph | concurrency + 10k/10 min | semaphore 4; unordered batch counts as 4 |
| IMAP | connections + MESSAGELIMIT + daily bytes | ≤2–3 conns |
| JMAP | `maxConcurrentRequests` | session-advertised |

**Lanes (priority):** interactive UI → op flush → incremental → body prefetch → backfill → AI. A pause stops the whole account and aborts siblings. Cooldowns **persist** across restarts.

**Retry:** exactly one layer. Classify by provider reason *and* message text (Gmail often returns only `rateLimitExceeded` for per-minute vs daily — `arch/pimalaya.md` via SYNTH §0.9). `invalid_grant` → park account until reconnect. Token 408/429/5xx → transient. Keep refresh token on network failure. Check granted scopes at exchange. Serialize refreshes per account; store refresh token + issuing client ID as one Keychain bundle.

**Cross-device:** before starting backfill or heavy prefetch, try to acquire a short lease (`quota_leases` via CloudKit or workflow channel). If another device holds "backfill", this device stays on incremental + interactive only. Leases are soft (clock skew, offline): worst case both run and Google 403s — then both honor cooldown.

> **What this means:** The app asks permission from a budget before every Google call. When the budget is empty, it waits. Two devices try not to spend the same minute twice.

---

## 5. Outbox, drafts, and timed features

### 5.1 Send safety

Keep and strengthen today's model (already better than most — `SYNTH-architecture.md` §1, §7): durable intent before network; stable Message-ID; `sendAttemptAt`; Sent reconciliation; never blind-retry uncertain outcomes. Add Bulwark/Inbox Zero split: **provably not sent** (release) vs **uncertain** (user "Send anyway").

### 5.2 Undo-send and send-later

One mechanism: `not_before` on the queued send. If due time passed while the **owning device** was off, **suspend** and re-validate rather than send late (Bulwark laptop rule). Under D, the phone can be the owner of a send-later — Mac sleep is fine. Document that "which device owns the timer" is the device that created it, with optional handoff via workflow sync.

### 5.3 Drafts sync

Close the daily-driver gap: Gmail `drafts.*` with debounce, fingerprint, serialized saves, ID remapping; IMAP UIDPLUS `APPENDUID`; JMAP create/update. Local-only drafts (Mailspring/comail/Superlocal/Aplos today) are not enough for multi-device.

### 5.4 Later, reminders, notifications

Durable notification outbox keyed by message; clients claim once. One timer sleeps until next deadline over metadata-with-expiration (snooze, send-later, reminders). On phone, schedule via OS notifications where possible; do not assume BGAppRefresh fires on time.

> **What this means:** Send never double-fires. Send-later and reminders live in a real queue on whichever device created them. Drafts follow you to the phone through the provider, not through a sleeping Mac.

---

## 6. AI pipeline

**Off the sync path** (`SYNTH-architecture.md` §11 F5): durable `jobs` table with singleton keys, backoff, dead letter. Enrichment, FTS indexing, calendar polish, and summaries are jobs after commit.

**Heuristic-first Home:** header / address / list-id rules classify before any LLM call (consent + cost). Big summaries and Ask stay owner-taste features (CONTEXT); **never** sparkle/wand/star glyphs in UI (product constraint).

**Budget:** per-account daily token/cost ceiling; content-hash cache (DECISIONS). Groq default from backend env on Mac; phone **must** use user-supplied keys or a future proxy — a shared key cannot ship in an App Store binary (`MOBILE.md`).

**Consent:** Workspace AI policy (2026-09) wants prompt-injection hardening and per-invocation consent for agentic tools (`protocols/proto-google.md` §0.6). Gemini unpaid tier trains on inputs — blocked for mail. Silent baseline: no AI on first-sync backlog.

**Multi-device:** prefer computing a summary once and syncing the result through the workflow/metadata channel (encrypted), so two devices do not pay twice. If the channel is unavailable, each device may compute with its own key under the local budget.

> **What this means:** AI runs as background chores after mail is saved, with your keys and your limits. Home can feel smart from simple rules before any model spends money. Summaries should sync, not re-bill every device.

---

## 7. UI-to-engine contract and transport

**Recommendation** (`gaps/engine-contract-rpc-stack.md` §0):

- JMAP **semantics** per type (`get` / `changes` / `set` / `query`) with opaque state, `ifInState`, client creation IDs.
- Wire shape: RPC `{id, method, args}` — not the heterogeneous JMAP batch envelope (Swift OpenAPI pain).
- **Live windows** (≤~200 body-free rows) re-run on commit; push `{windowId, state, ids, total, changed}`; clients `Thread/get` by ID.
- Schema: zod v4 in a platform-neutral `packages/contract`; thin registry generates allowlists, validators, OpenAPI; Swift via swift-openapi-generator when the phone exists.
- Blobs and sanitized HTML on GET routes / custom scheme (separate origin).

**Transports by host:**

| Host | Transport |
|---|---|
| Mac Electron | MessagePort via main (today), same methods |
| Browser preview | HTTP loopback speaking the same contract (tokenized — §10) |
| Phone | In-process calls into the engine bundle (primary); optional later: talk to Mac only as a *cache*, never as the source of truth |

Migration from `invoke(method, payload)` is the smallest jump (Delta Chat shape). Kill the triple-copied allowlist drift (66 / 47 / 47 entries today).

> **What this means:** One typed language between UI and brain. Lists ask for a window of IDs, not the whole mailbox. The phone calls the same verbs in-process.

---

## 8. Email HTML isolation

Follow the tested prototype (`gaps/electron-email-html-isolation.md` §0):

- Serve mail at `aplos-mail://m/<token>` via `protocol.handle`.
- Opaque sandboxed iframe; **one** hash-pinned height/paper script; email scripts blocked by CSP hash.
- CSP as **response header** (`default-src 'none'`, tight img via proxy); not meta-only.
- OOPIF: mail decoder bugs land outside the privileged renderer that can send mail (~+25–35 MB for a thread).
- `before-input-event` for keyboard; verify OOPIF focus by hand before relying on it.
- Engine sanitizer runs in the portable core; Mac uses iframe, phone uses WKWebView with analogous CSP / script bridge.

Same-origin `srcdoc` is an acceptable one-day stopgap only.

> **What this means:** Hostile newsletters run in a locked box. They cannot reach Send. Layout and images can come back without giving away the keys to the app.

---

## 9. Multi-device, phone future, and shared quota

### 9.1 Coordination channels (no Aplos mailbox server)

| Channel | Carries | Needs | Sleep-safe? |
|---|---|---|---|
| **Provider truth** | read/star/trash/spam/inbox, drafts | OAuth on each device | Yes |
| **Encrypted hidden folder** (DECISIONS 2026-10-16 M29) | Done/Later/reminders/todos | Works on Gmail/Graph/IMAP/JMAP; costs Gmail insert units; Trash copies | Yes |
| **CloudKit** (`gaps/phone-mac-connectivity.md` §4) | same workflow + quota leases + optional snapshot; visible pushes via `CKQuerySubscription` + NSE | Developer ID **provisioning profile** (not done); Apple-only; ADP for E2E `encryptedValues` | Yes for workflow/alerts; not for brand-new provider mail without a device pull |
| **Candidate C relay** (optional later) | content-free "mailbox changed" + APNs | Aplos ops; CASA conversation | Alerts while all devices sleep |

Keep workflow as its own cursor-paged feed, separate from mailbox facts (Inbox Zero `assistant_entries` pattern; `SYNTH-architecture.md` §8).

### 9.2 Phone milestones

1. **D0:** `packages/engine` + foundation F on Mac; portability tests green; lease table stubbed.
2. **CloudKit profile** on the signed Mac app (CONTEXT: profiles missing).
3. **D1 spike:** load engine in RN/Hermes; expo-sqlite/op-sqlite with FTS5; one HTTPS provider (Gmail metadata sync); Keychain; ASWebAuthenticationSession.
4. **IMAP port** behind existing interfaces.
5. **Store review** of mail scopes — calendar months, not weeks.
6. **Optional C** only if provider-originated pushes while every device sleeps are required.

### 9.3 Honest quota math

Example: Mac backfill targeting 4,500 u/min leaves **1,500** for a phone doing interactive opens (each full thread 60–120). Two uncoordinated first syncs ≈ both 403. Soft leases + "phone defers backfill to Mac when Mac lease fresh" is the practical rule; phone still must work alone when Mac is off for days (then phone owns backfill).

Separate Cloud projects per platform double CASA/verification cost — usually wrong.

> **What this means:** Devices share homework through Google/Microsoft/Fastmail and a small encrypted notebook (CloudKit or hidden folder). They must take turns spending the Gmail minute. The phone is a real client, not a viewer for your desktop.

---

## 10. Observability and diagnostics

Aplos has none today (`SYNTH-architecture.md` §9). Portable requirement: the same redacted logger and status vocabulary on every host.

- Rotating file / OS log with redaction on the root logger (EmailEngine).
- Ring buffer by account/folder snapshotted into UI errors (Geary).
- Time-boxed verbose protocol log (Mailspring).
- Status: discovering / importing N of M / paused until / retrying / blocked / auth (Zero + Geary).
- Content-free diagnostics zip (Inbox Zero): governor history, cursors, lease state, job queue — **no bodies, no tokens**.
- Heartbeats and event-loop delay monitors once resident or phone background exists.

> **What this means:** When sync hangs, you can export a safe report that shows "quota pause" vs "reconnect Google" without leaking mail.

---

## 11. Security

### 11.1 Even without a daemon listener

- Electron fuses: `RunAsNode`, `NodeOptions`, `NodeCliInspect` off; asar integrity on (`gaps/macos-daemon-lifecycle.md`).
- HTML isolation §8; image proxy; no `unsafe-inline` script in the privileged page longer than needed.
- Keychain / `safeStorage` for data key; never print or commit secrets (AGENTS.md / CONTEXT).
- Scope checks at token exchange; park on `invalid_grant`.

### 11.2 If preview / CLI expose loopback (`SYNTH-architecture.md` §10)

Bind loopback or 0600 Unix socket; per-client token (constant-time); exact Origin/Host allowlist; no CORS reflect; typed scoped ops only; no raw SQL/fs/sockets. Phone pairing (if ever talking to Mac as cache): QR with cert fingerprint or 256-bit PSK, pinned TLS, revocable per-device sessions (T3 Code pattern in `gaps/phone-mac-connectivity.md` §1.1) — **secondary** to embedded engine.

### 11.3 Phone-specific

Credentials on device; App Store privacy labels; mail-scope review; no bundled Groq key; consider separate OAuth client IDs with clear naming but **same** Cloud project only if leases exist.

> **What this means:** Lock down the Mac app the usual hardened-Electron way. Any local network door needs a real key. The phone holds its own keys and never ships yours.

---

## 12. Migration from today's code (app stays usable)

Ordered so each step ships to the owner on `revamp` / draft releases without requiring the phone:

| Step | Work | Acceptance evidence | Est. |
|---|---|---|---|
| **M1** | Gmail metadata-first + governor + search-on-Enter; Spam/Trash deferred | Real test mailbox completes first sync under 6,000 u/min; no 403 storm | 1–2 wk |
| **M2** | Normalized store + lazy bodies + contentless FTS; drop whole-mailbox clone / `latestState` | bench: page <0.1 ms; typecheck + mailbox tests; memory flat on large fixture | 2–3 wk |
| **M3** | Persisted change log + live windows in UI | Restart does not full re-snapshot; multi-window OK | 1–2 wk (overlaps M2) |
| **M4** | Extract `packages/engine` + `packages/contract`; hosts become composition roots | `portability.test.ts` + desktop green; no behavior change | 1 wk |
| **M5** | AI/FTS/calendar as jobs; heuristic Home | Sync path free of LLM; job inspector in diagnostics | 0.5–1 wk |
| **M6** | Per-account actors: IMAP IDLE+command, JMAP EventSource, Graph scheduler, CalDAV tokens | Defects in `proto-others.md` closed with tests | 1–2 wk |
| **M7** | HTML isolation per gap report | Prototype behaviors in app; keyboard triage still works | ~1 wk |
| **M8** | Observability + diagnostics zip | Hung sync → actionable status | 3–5 d |
| **M9** | Drafts sync + send-later/`not_before` + notification outbox | Multi-device draft round-trip on Gmail test users | 1–2 wk |
| **M10** | CloudKit profile + workflow port dual-write (label + CK) | Two Macs or Mac+simulator merge Later without Trash pile growth | 2–4 wk after profiles |
| **M11** | Soft quota leases | Instrumented dual-process test does not exceed ~75% combined sustained | 3–5 d |
| **M12** | Phone spike D1 | Engine syncs metadata in RN against test mailbox | months for store-ready app |

**Usable throughout:** M1 alone fixes daily driver Gmail. M2–M3 fix memory and restart. Phone work never blocks Mac releases. Do not merge PR #21 from this phase (CONTEXT). Live Google verification / CASA remain external gates — mocked OAuth ≠ acceptance (AGENTS.md).

> **What this means:** Fix Gmail and the database first so the Mac is a joy. Package the brain for reuse. Only then grow the phone. You can live in the app the whole time.

---

## 13. Effort (one owner + AI agents)

| Block | Weeks |
|---|---|
| Foundation F (M1–M8), heavily overlapped | **6–10** (`SYNTH-architecture.md` §11.0) |
| Package extraction + lease plumbing (M4, M11) | **~1–1.5** inside / beside F |
| Drafts + timers multi-device (M9) | **1–2** |
| CloudKit workflow (M10) after provisioning profiles | **2–4** |
| Phone app to TestFlight-quality (M12) | **~8–16** calendar weeks (OAuth UX, IMAP native, HTML, review) |
| Optional Candidate C relay | **2–4** + ongoing ops |

**Desktop-usable "revamp backend" without phone:** about **8–12 weeks**.  
**Phone that works while Mac sleeps:** add CloudKit + phone app — think **a quarter or more**, not a sprint. Writing speed is not the bottleneck (169 commits in 11 days historically); **live verification**, App Store review, and Google CASA are.

> **What this means:** Expect about two months to make the Mac engine excellent and portable-shaped, then a longer stretch to ship a real iPhone client. The relay is optional icing.

---

## 14. Top risks

1. **Shared Gmail quota** — two devices thrash into 403s; leases fail open under partition. *Mitigation:* lane caps, phone deferral, visible "budget" status, confirm 6,000 in Cloud console.
2. **Medium evidence for Gmail-REST-on-new-project under D** — five portable engines exist, but not as REST clients on post-2026 quotas (`SYNTH-architecture.md` §11.4). *Mitigation:* ship M1 on Mac before phone spend.
3. **iOS background / timely mail** — without CloudKit visible pushes or C, the phone feels stale. *Mitigation:* CK subscriptions early; honest UX copy.
4. **IMAP connection caps** — Mac+phone exhaust iCloud. *Mitigation:* foreground-only phone IDLE; capability negotiation.
5. **Duplicate AI cost / key UX on phone** — *Mitigation:* sync summary ciphertext; BYO keys only.
6. **CloudKit profile / ADP / Electron helper packaging** — profiles not set up (CONTEXT); CK from Electron needs nested helper or native addon (`gaps/phone-mac-connectivity.md` §4). *Mitigation:* treat profiles as an external prerequisite like OAuth verification.
7. **CASA / Limited Use** if C ships or mail hits LLMs — unresolved for poke relays (`protocols/proto-google.md`). *Mitigation:* defer C; document AI destinations.
8. **Identity / branding collisions** are a product risk parallel to architecture (`gaps/identity-collision-audit.md`) — keep "Airmail" out of user-visible strings.
9. **Hidden-label workflow defects** (clock LWW, Trash piles) — *Mitigation:* CloudKit change tags preferred when available; keep label as fallback port.
10. **Scope creep to "Mac daemon + phone engine"** — most complex untested combo (`SYNTH-architecture.md` §11.5). *Mitigation:* pick D *or* A2 as phone strategy; do not combine until both alone work.

> **What this means:** The biggest danger is two hungry syncs and a phone that cannot wake often enough. Profiles, Google review, and discipline about not boiling the ocean are what keep this honest.

---

## Decisions for you

1. **Is a phone that works while the Mac sleeps a near-term goal (≤6 months)?**  
   - **Options:** (a) No — build foundation only; revisit D later. (b) Yes — commit to Candidate D (this doc). (c) Phone OK only when Mac awake — prefer local-server A2 instead.  
   - **Default:** (b) if you said "Mac never has to be awake"; else (a).  
   - **If (a):** still extract `packages/engine` as insurance. **If (c):** stop reading this proposal and use the local-server plan.

2. **Gmail scopes before verification?**  
   - **Options:** (a) `gmail.modify` + `settings.basic` only. (b) Add `mail.google.com` for IMAP bulk + IDLE.  
   - **Default:** (a).  
   - **If (a):** minutes of metadata sync, quota math everywhere. **If (b):** scary consent string, second code path, freer bandwidth.

3. **Workflow sync primary channel?**  
   - **Options:** (a) Keep hidden provider folder only. (b) CloudKit primary, folder fallback. (c) CloudKit only (Apple users).  
   - **Default:** (b).  
   - **If (a):** works cross-ecosystem, burns Gmail units, Trash debris. **If (b):** needs profiles; best multi-device UX on Apple. **If (c):** simpler, excludes non-iCloud users.

4. **Body retention?**  
   - **Options:** (a) 90 days + size cap. (b) Everything. (c) Aggressive LRU (e.g. 500 MB).  
   - **Default:** (a) on Mac, (c) on phone.  
   - **Trade-off:** disk vs refetch quota.

5. **Encryption at rest beyond FileVault / iOS protection?**  
   - **Options:** (a) No SQLCipher. (b) SQLCipher / SQLite3MC despite cost and driver change.  
   - **Default:** (a).  
   - **If (b):** accept 2–4× sync slowdown and abandon pure `node:sqlite` on desktop.

6. **Optional poke relay (Candidate C)?**  
   - **Options:** (a) Never (SPEC purity). (b) Later, content-free only, after CASA talk. (c) Build with D1.  
   - **Default:** (b).  
   - **If (a):** polling + CloudKit Mac-originated alerts only. **If (c):** ops burden before the phone is proven.

7. **First sync scope?**  
   - **Options:** (a) Inbox+Sent ~30 days. (b) Newest 500 threads metadata. (c) ~14 days (Geary).  
   - **Default:** (a) or (c) for quota comfort; show progress.  
   - Sets the "time until useful" clock under 6,000 u/min.

8. **Same Google Cloud project for phone OAuth client?**  
   - **Options:** (a) Same project + leases. (b) Separate project (separate 6,000 — double verification).  
   - **Default:** (a).  
   - **If (b):** only if verification cost is acceptable and leases still confuse you less than dual budgets.

> **What this means:** The fork in the road is whether the phone must outlive a sleeping Mac. If yes, this portable-engine plan is the evidence-backed bet — with eyes open on Gmail's shared minute and Apple provisioning work still ahead.

---

## Evidence index (non-exhaustive)

| Path | Used for |
|---|---|
| `research/email-clients/SYNTH-architecture.md` | Topology D, foundation F, sync, storage, AI, security, effort |
| `research/email-clients/gaps/phone-mac-connectivity.md` | Sleep ceiling, CloudKit, quota sharing, C vs D |
| `research/email-clients/gaps/storage-engine-benchmark.md` | Schema, bodies, FTS, encryption cost |
| `research/email-clients/gaps/engine-contract-rpc-stack.md` | Contract, windows, codegen |
| `research/email-clients/gaps/electron-email-html-isolation.md` | Reader isolation |
| `research/email-clients/gaps/macos-daemon-lifecycle.md` | Resident mode optional; fuses; profiles |
| `research/email-clients/protocols/proto-google.md` | Quota units, push, CASA/AI policy |
| `research/email-clients/protocols/proto-others.md` | Graph, IMAP, JMAP, CalDAV defects |
| `MOBILE.md` (main) | JSC spike, ports, IMAP non-portability |
| `DECISIONS.md` (main) | Serverless multi-provider intent, workflow sync |
| `plans/_council/CONTEXT.md` | Signing facts, quota failure, owner taste |
