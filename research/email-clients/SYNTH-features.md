# Feature comparison: Aplos Mail and the researched clients

Prepared 2026-10-25 for the Aplos revamp (one UI workstream, one or two backend/architecture workstreams).

**Sources.** This is a synthesis. It draws on the 26 reports in `research/email-clients/` (`arch/`, `ui/`, `protocols/`) and the five in `research/inbox-zero/`. Each upstream fact traces to a report, and through it to a file path or URL in the cloned repo or on the vendor site. I re-checked a few Aplos facts in this worktree at `72095ff` (v0.2.3):
- no `List-Unsubscribe`, Gmail drafts endpoint or `crashReporter` anywhere in `apps/desktop/src`;
- `disableAutoIdle:true` in `main/imap-session.ts:71`;
- email HTML goes through DOMPurify into the renderer (`renderer/mailBody.ts:44`);
- `pendingSendAt` is the undo-send hold, not send-later.

No code was run and nothing was copied.

**Facts vs judgment.** Every capability claim comes from a report that cites a path or URL, and the notes under each table point to the report section. The **grades** are my judgment from that evidence, so treat them as inference. Where a report didn't cover a capability I wrote `?`, not a guess.

---

## 1. What was compared

| Code | Product | Kind | License | Providers | Platforms | State (2026-10) | Report |
|---|---|---|---|---|---|---|---|
| Ap | **Aplos Mail** 0.2.3 | Electron client, engine in utilityProcess | Owner's (private repo) | Gmail REST, Graph, IMAP, JMAP, CalDAV | macOS | 2 weeks old; no provider verified live; first Gmail sync hit 403 | `inbox-zero/aplos-product.md`, `ui/aplos-baseline.md` |
| IZ | **Inbox Zero**: hosted assistant plus the new Inbox Zero Mail client | Server layer plus local-replica client | AGPL-3.0 plus a commercial-use ban and an enterprise license for 5+ business users | Gmail, Outlook | Web, Mac, Windows, closed iPhone | Assistant since 2023; client launched 2026-10-18 | `inbox-zero/inbox-zero-product.md`, `arch/inbox-zero-client.md`, `ui/inbox-zero-mail.md` |
| Zr | **Zero** (0.email) | Cloudflare-hosted web client | MIT | Gmail; IMAP behind a flag; Graph disabled | Web | Sporadic; big unreleased sync rework | `arch/zero.md`, `ui/zero.md` |
| SL | **Superlocal** | Local Bun host plus browser UI | None (all rights reserved) | Gmail, iCloud/IMAP presets, Inbound | Browser, Docker | 6-day agent burst, idle since 09-08 | `arch/superlocal.md`, `ui/superlocal.md` |
| Rd | **Redakt** | Hosted web plus thin iOS app | MIT | Gmail, hosted Stalwart domain | Web, iOS (read-only) | v0.1.0, idle since 09-28 | `arch/redakt.md`, `ui/redakt.md` |
| MS | **Mailspring** + Mailspring-Sync | Electron plus C++ engine | GPL-3.0 (closed id backend) | IMAP (Gmail via X-GM), O365 IMAP plus Graph send, CalDAV/CardDAV | Mac, Win, Linux | 9 years, five releases in five weeks | `arch/mailspring.md` |
| Ge | **Geary** | GTK client with in-process engine | LGPL-2.1+ | IMAP/SMTP (OAuth through GNOME Online Accounts) | Linux | Maintenance mode since 46.0 (2024) | `arch/geary.md` |
| Tu | **Tuta** desktop | Electron wrapper of the web app | GPL-3.0 | Tuta only; IMAP import (beta) | All five | Mature, paid team | `arch/tuta-desktop.md` |
| Co | **comail** | Tauri plus Rust core | AGPL-3.0-only | IMAP/SMTP (XOAUTH2 for Gmail/M365); Graph for calendar | Mac, Win, Linux | One main author, v0.2.41 | `arch/extra-comail.md` |
| Fl | **Flectar Mail** | Native Rust/Slint | AGPL-3.0-only | Gmail REST, IMAP, JMAP, POP3; Outlook over IMAP | All five (alpha) | One author, prerelease only | `arch/extra-flectar-mail.md` |
| Pa | **Parula/Mustang** | Electron plus Capacitor | EUPL-1.2 core; Exchange/Graph code proprietary | IMAP, JMAP, POP3, (EWS/Graph closed) | Desktop, mobile | Weekly releases, agent-heavy | `arch/extra-parula-mustang.md` |
| Ve | **Velo** | Tauri, logic in the webview | Apache-2.0 | Gmail REST, IMAP | Mac, Win, Linux | 2.5-week burst, stalled since March | `arch/extra-velo.md` |
| Ta | **Tatem** | Hosted web client, local SQLite in OPFS | Proprietary | Gmail | Web | Probably unmaintained (acqui-hire reported) | `ui/tatem.md` |
| Av | **Avec** | Phone-first client with server enrichment | Proprietary | Gmail | iOS; Mac alpha | iOS 4.94 stars from 444 ratings | `ui/avec.md` |
| DC | **Delta Chat core** | Rust chat-over-email engine | MPL-2.0 | IMAP/SMTP (chatmail-focused) | Via apps | Weekly releases; dropped OAuth, multi-folder and CONDSTORE in 2026 | `arch/deltachat-core.md` |
| Hi | **Pimalaya** (Himalaya v2, Neverest, pimdir, ortie) | Rust CLI tools and engine | MIT/Apache (v2) | IMAP, SMTP, JMAP, Gmail REST, Graph, DAV, ManageSieve | CLI, Android alpha | One maintainer, very active | `arch/pimalaya.md` |
| EE | **EmailEngine** | Self-hosted Node gateway | Commercial, source-available | IMAP, Gmail REST/IMAP, Graph | Server | Very active, one author | `arch/emailengine.md` |
| Ny | **Nylas sync-engine** | Python 2 server | AGPL-3.0 | IMAP (incl. Gmail X-GM) | Server | Archived 2017 | `arch/nylas-sync-engine.md` |
| St | **Stalwart** | Rust mail server | AGPL-3.0 or paid SEL | Is a server; cannot sync upstream | Server | Weekly releases, one maintainer | `arch/stalwart.md` |
| Bu | **Bulwark legacy-proxy** | JMAP-over-IMAP gateway with a Gmail REST backend | AGPL-3.0-only | IMAP, Gmail REST (flagged), CardDAV, ManageSieve | Server | v0.2.0, three fix PRs unmerged | `arch/extra-bulwark-legacy-proxy.md` |

The protocol reports (`protocols/proto-google.md`, `protocols/proto-others.md`) are not products. They supply the provider facts behind several gaps below.

## 2. Grading scale

| Grade | Meaning |
|---|---|
| **A** | Mature: production use at scale, years of hardening, or broad real-world evidence |
| **B** | Solid: shipped end to end and working, with known gaps |
| **C** | Partial: experimental, flag-gated, incomplete, or local-only where it should reach the provider or other devices |
| **D** | Unproven: code exists but was exercised only against mocks, demo data or a stub, or the UI is disabled |
| **–** | Absent |
| **R** | Removed on purpose |
| **n/a** | Not applicable to that product's design |
| **?** | Not determined by the research |

**Aplos rule.** Any Aplos feature that depends on a provider gets D, because no provider has been verified live (`aplos-product.md` §0). Aplos features verified live on Groq with synthetic content get C. Pure UI features verified headless on demo data are graded on completeness.

---

## 3. Capability matrix: end-user clients

Columns: **Ap** Aplos · **IZ** Inbox Zero · **Zr** Zero · **SL** Superlocal · **Rd** Redakt · **MS** Mailspring · **Ge** Geary · **Tu** Tuta · **Co** comail · **Fl** Flectar · **Pa** Parula · **Ve** Velo · **Ta** Tatem · **Av** Avec.

### 3.1 Connectivity and sync

| Capability | Ap | IZ | Zr | SL | Rd | MS | Ge | Tu | Co | Fl | Pa | Ve | Ta | Av |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Gmail | D | A | B | C | B | A | A | C | B | B | C | C | B | B |
| Outlook / Microsoft 365 | D | B | D | D | – | A | A | D | B | C | ? | C | – | – |
| IMAP/SMTP (iCloud, Yahoo, generic) | D | – | C | C | – | A | A | C | B | B | A | C | – | – |
| JMAP (Fastmail) | D | – | – | – | C | – | – | – | – | B | A | – | – | – |
| Ships its own OAuth app (no bring-your-own setup) | C | A | B | – | B | B | n/a | n/a | – | C | ? | – | B | B |
| New mail in near real time | – | B | B | – | B | B | B | A | B | B | B | – | B | B |
| Local store and offline reading | D | B | – | B | – | A | A | A | B | B | B | B | B | ? |
| Resumable, metadata-first first sync | – | C | C | C | n/a | A | A | n/a | B | B | B | – | ? | ? |
| Rate-limit and backoff discipline | – | D | C | C | B | C | C | B | B | C | B | – | ? | ? |
| Bounded storage (lazy bodies, eviction) | – | C | – | ? | n/a | B | B | C | B | B | B | C | ? | ? |
| Durable offline action queue | D | B | C | B | C | C | C | – | B | B | – | C | B | ? |
| Durable change feed to UI and other clients | C | B | C | B | C | C | n/a | A | C | C | ? | C | B | ? |
| Local full-text search | D | B | – | – | – | A | A | B | B | B | – | B | ? | ? |

Notes (sources in the reports named in §1):
- **Gmail transport.** REST: Ap, IZ, Zr, SL, Rd, Fl, Ve, Ta (via its server). IMAP with X-GM extensions: MS, Ge, Co, Pa. Avec's is unknown. Tu only *imports* Gmail into Tuta (beta). Pa stores one folder per message, duplicating multi-label mail. SL never backfills past about 25 messages.
- **Outlook.** Aplos's release builds lack `MICROSOFT_CLIENT_ID`, so Graph can't sign in (`aplos-product.md` §3). Zero's Graph sign-in is commented out, and SL's host has no OAuth flow. MS, Ge and Co use IMAP XOAUTH2.
- **Real time.** IZ, Zr and Rd use Gmail Pub/Sub through their servers, which a desktop app can't copy (`proto-google.md` §5). The local clients use IMAP IDLE, mostly on INBOX only, and Fl and Pa add JMAP EventSource. SL and Ve poll by design.
- **Rate limits.** IZ's quota bucket has no production caller (`inbox-zero-client.md` §3c). Rd, Fl and Aplos retry Google's daily `quotaExceeded` like a burst limit. Under the May 2026 quotas, Aplos's first sync costs about 60,000 units, ten times the per-user minute (`proto-google.md` §0).
- **Change feed.** Aplos's `{epoch, rev}` diffs beat most peers' ID-only events, but they live in memory (`API.md`). The durable models are SL's journal with SSE resume, IZ's live queries and Tuta's server event log.

### 3.2 Triage and organizing

| Capability | Ap | IZ | Zr | SL | Rd | MS | Ge | Tu | Co | Fl | Pa | Ve | Ta | Av |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Archive/Done with undo | D | B | C | C | B | A | A | ? | B | B | ? | B | B | B |
| Snooze | – | B | B | C | – | B | – | – | C | B | – | C | B | ? |
| Later/todo list with due dates | D | – | – | – | – | – | – | – | – | – | – | C | – | B |
| Reply-owed and follow-up tracking | D | B | – | – | C | B | – | – | ? | ? | – | C | – | B |
| Split inbox or AI categories | D | B | C | B | B | – | – | – | B | B | C | B | B | B |
| Sender-grouped bulk cleanup | D | B | – | B | – | – | – | – | – | – | – | C | – | B |
| One-click unsubscribe (List-Unsubscribe, RFC 8058) | – | B | D | – | – | B | – | – | B | B | – | B | B | C |
| User-defined rules | – | A | – | C | – | B | – | B | B | B | B | C | ? | – |
| Rules that run on the provider (Gmail filters, Sieve, Outlook rules) | – | – | – | – | – | – | – | – | – | – | – | – | – | – |
| Labels and folders (apply, move) | – | B | B | C | B | A | B | A | C | B | B | B | B | ? |
| Duplicate cleanup | D | – | – | B | – | – | – | – | – | – | – | – | – | – |

Notes:
- **Local-only state.** SL's Done and snooze never reach the provider, so the phone still shows the mail in Inbox. Aplos maps Done to archive by default, which is better.
- **Timers need something running.** IZ and Zr wake snoozed mail from a server cron. MS, Ve and Co fire only while the app runs. Aplos has no snooze, yet Ask accepts the word (`engine/writer.ts:27`, `engine/ask.ts:207`; `SYNTHESIS.md`).
- **Rules.** IZ's English rules are the deepest (17 actions, delays, test mode, learned patterns) but run on its server, unattended. MS and Pa run rules client-side while syncing. Tuta elects one "leader" client.
- **Provider-side rules.** No client writes Gmail filters, Outlook rules or Sieve. Only engines do (Pimalaya and Bulwark via ManageSieve). See §7.
- **Unsubscribe.** Aplos regex-scans the body for a link and never reads the header. Zero's RFC 8058 UI is commented out. Tatem's mechanism wasn't verified.

### 3.3 Reading and compose

| Capability | Ap | IZ | Zr | SL | Rd | MS | Ge | Tu | Co | Fl | Pa | Ve | Ta | Av |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Email HTML isolated and script-free | – | B | – | B | B | C | A | C | ? | C | B | ? | ? | ? |
| Remote images off by default or proxied | D | B | – | B | – | ? | A | B | ? | B | ? | B | ? | ? |
| Undo send | D | B | C | B | C | ? | A | B | C | B | ? | C | ? | B |
| Send later | – | B | – | C | – | B | – | A | C | B | – | C | ? | ? |
| Drafts synced to the provider | – | B | B | – | B | – | A | A | – | B | B | C | ? | ? |
| Send-once guarantee (no duplicate sends) | D | B | – | B | C | ? | A | – | – | B | – | – | ? | ? |
| Templates or snippets | – | B | B | C | – | A | C | ? | ? | ? | ? | B | ? | ? |
| Address book sync (CardDAV, People, Graph) | – | – | B | – | – | A | B | A | ? | B | B | ? | – | ? |
| PGP or S/MIME | – | – | – | – | – | ? | – | A | – | B | B | – | – | – |
| Open and link tracking | – | B | – | – | – | B | – | – | – | – | – | – | – | – |

Notes:
- **HTML isolation.** Aplos injects DOMPurify output into the page that holds the privileged bridge, under `unsafe-inline` (`SYNTHESIS.md` weakness 6). Zr and Tu use a Shadow DOM, which isolates styles but isn't a security boundary. MS iframes allow same-origin. The models: IZ, SL and Rd (script-less `srcdoc` iframe, strict CSP), Ge (WebKit process, JS off) and Pa (a `<webview>` guest without preload).
- **Remote images.** Zr and Rd load them by default. SL's DNS-pinned, SSRF-safe proxy is the strongest design.
- **Undo send.** Zr and Rd hold sends in a browser timer that a closed tab drops. Aplos persists the hold as `pendingSendAt`, so it survives a restart.
- **Drafts.** Aplos drafts never reach Gmail, a gap shared with MS, SL, Co and Delta Chat. Ve's IMAP autosave piles up copies. References: Ge (a save queue that drops stale saves, APPEND then delete the old copy) and Rd (debounce, fingerprint, `drafts.send`).
- **Send once.** Co regenerates the Message-ID on retry, so a crash can double-send. Aplos's stable Message-ID plus a Sent check already beats Co, Zr and Ve.
- **Tracking** is on by default in IZ and a cloud-backed Pro feature in MS. Zr, Rd, Av and unlicensed Pa add a **promotional signature** by default. Aplos's is opt-in.

### 3.4 Calendar

| Capability | Ap | IZ | Zr | SL | Rd | MS | Ge | Tu | Co | Fl | Pa | Ve | Ta | Av |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Calendar view and editing | D | – | – | D | – | B | – | A | B | B | B | C | – | – |
| Recurrence creation and RSVP | – | – | – | – | – | B | – | ? | ? | ? | B | ? | – | – |
| Events found in mail | C | C | – | – | – | – | – | – | – | – | – | C | C | C |
| Scheduling help (booking links, meeting briefs) | – | B | – | – | – | – | – | – | – | – | – | – | – | – |

Notes:
- **Aplos's calendar** has the most polished week view in the set. Behind it, Google saves use a full PUT that wipes Meet links and RSVPs, CalDAV re-queries every calendar every 10 minutes, and recurring or guest events are read-only (`proto-google.md` §7, `proto-others.md` §4). SL's calendar is UI only, in browser storage.
- **Mail-to-calendar.** Aplos's Plans extract events and need a confirm click with clash detection. Av adds events to Google Calendar, Ta shows a detected-date chip, and IZ drafts scheduling replies.

### 3.5 AI

| Capability | Ap | IZ | Zr | SL | Rd | MS | Ge | Tu | Co | Fl | Pa | Ve | Ta | Av |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Thread summaries | C | C | B | – | – | C | n/a | n/a | B | ? | n/a | C | – | B |
| AI importance or categories | C | A | B | B | B | – | n/a | C | B | B | n/a | B | – | B |
| Works without AI (deterministic baseline) | – | B | ? | B | B | n/a | n/a | n/a | B | B | n/a | B | n/a | ? |
| Ask or chat over your mail | C | B | B | – | – | – | n/a | n/a | B | C | n/a | C | – | B |
| AI drafting and polish | C | B | B | – | B | C | n/a | n/a | B | ? | n/a | C | – | B |
| Voice (dictation, talk to AI) | C | – | B | – | – | – | n/a | n/a | C | – | n/a | – | n/a | B |
| Bring-your-own keys and local models | C | C | – | C | – | C | n/a | n/a | B | B | n/a | C | n/a | – |
| Explains decisions and learns from corrections | – | B | – | B | B | n/a | n/a | n/a | ? | ? | n/a | ? | n/a | B |
| AI off the sync path, budgeted, with consent | – | B | C | B | B | n/a | n/a | n/a | B | B | n/a | B | n/a | ? |
| AI proposes, the user confirms | B | C | C | B | B | n/a | n/a | n/a | ? | ? | n/a | ? | n/a | ? |
| MCP or agent API | – | B | B | – | – | B | – | – | B | – | – | – | – | – |

Notes:
- **Breadth.** Aplos has the widest per-feature model choice (nine providers; a model each for Ask, Summaries, Drafts, Plans, Voice), but only Groq has run live, on synthetic content.
- **Sync path.** Aplos awaits `classifyIncoming` inside sync, Spam included, with no consent step (`SYNTHESIS.md` weakness 4).
- **No-AI fallback.** With no key, Aplos classifies nothing and the reader leads with an error card (`aplos-baseline.md` §6.9). SL, Rd, Co, Fl and Ve classify from header facts first.
- **Confirmation.** IZ's rules send, forward and call webhooks unattended. Zero's chat labelled mail on one sentence in its 2025 demo. Rd never lets AI touch the mailbox, and SL separates Preview from Apply. Aplos's validated confirm cards are among the strictest.
- **Local models.** MS runs on-device only (Apple Foundation Models or Qwen). Co adds Apple's on-device model to any OpenAI-compatible endpoint.
- **Explanations.** IZ's "Fix" turns a correction into a sender pattern, SL has "Why?" plus W (Done and "not important"), Rd shows reasons and confidence, and Av toasts when it learns. Aplos shows nothing.
- **MCP.** MS and Co bind to loopback with a token, read/write/send tiers and an activity log: the template for Aplos.

### 3.6 Platform, trust and operations

| Capability | Ap | IZ | Zr | SL | Rd | MS | Ge | Tu | Co | Fl | Pa | Ve | Ta | Av |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| macOS app | C | C | – | C | – | A | – | A | B | C | B | C | – | C |
| Windows or Linux | – | C | – | – | – | A | A | A | B | C | B | C | – | – |
| Phone | – | C | – | – | C | – | – | A | – | C | C | – | – | B |
| Web | – | A | B | B | B | – | – | A | – | – | C | – | B | – |
| Command palette | – | B | B | B | – | ? | – | ? | ? | ? | ? | ? | B | ? |
| Keyboard model (coverage and consistency) | C | B | C | B | C | B | B | ? | ? | ? | ? | ? | B | B |
| Cross-device state | D | A | B | C | B | C | – | A | – | – | – | – | B | B |
| Logs, diagnostics, crash reports | – | A | ? | C | ? | B | B | C | – | – | ? | ? | ? | ? |
| Credentials protected by the OS keychain | B | n/a | – | C | C | B | B | A | B | B | – | – | n/a | n/a |
| Try it with demo data | B | – | – | B | B | – | – | – | – | – | – | – | – | – |

Notes:
- **Aplos's macOS build** is signed and notarized in CI, but the private repo makes the download and update feed 404 (`aplos-product.md` §5).
- **Aplos's keyboard** is broad, but Space has four meanings, arrows are destructive, and ⌘K only searches (`aplos-baseline.md` §5). The best models: IZ's scoped registry, SL's table-tested resolver, and Ta's "four doors" (key, palette, right-click, overflow menu, identical labels).
- **Cross-device state** comes from a server everywhere except Aplos, whose encrypted hidden-label record is serverless (Delta Chat syncs settings the same way). It is mock-only and leaves trashed messages behind.
- **Credentials.** Pa "encrypts" with a constant passphrase, and Ve and SL keep the key next to the database. Aplos's safeStorage-wrapped key is sound.
- **Observability.** Co and Fl have none, like Aplos.

---

## 4. Capability matrix: engines, gateways and servers

These aren't consumer clients, so only the infrastructure rows apply. Aplos is included for reference.

| Capability | Ap | DC | Hi | EE | Ny | St | Bu |
|---|---|---|---|---|---|---|---|
| Gmail REST | D | – | B | A | – | n/a | C |
| Microsoft Graph | D | – | B | A | – | n/a | – |
| IMAP/SMTP | D | A | B | A | A | server | B |
| JMAP client | D | – | B | – | – | server A | serves JMAP (B) |
| CalDAV/CardDAV | D | – | B | – | C | server A | B (CardDAV) |
| OAuth handling | C | R | B | A | C | n/a | B |
| Push (IDLE, EventSource) | – | A | C | A | B | A | C |
| Rate or quota governor | – | A | B | B | C | n/a | B |
| Resumable first sync | – | B | B | B | A | n/a | n/a |
| Lazy, evictable bodies | – | A | B | n/a | B | A | B |
| Send-once outbox | D | A | B | A | C | A | B |
| Send later | – | – | ? | A | – | A | B |
| Provider draft sync | – | – | C | C | B | n/a | B |
| Server-side rules (Sieve) | – | – | B | – | – | A | B |
| Durable change feed or API | C | B | B | B | A | A | C |
| Local full-text search | D | – | D | R | – | B | – |
| Logs and observability | – | B | B | A | B | A | ? |

Notes:
- **Delta Chat** removed OAuth (2.56), its provider database (2.57) and CONDSTORE (2.54). It is a reference for IDLE loops, connection throttling and its outbox, not for mailbox features.
- **EmailEngine** removed its Elasticsearch "Document Store" in 2.82.0. That store held unified search, plain-IMAP threading and embeddings.
- **Pimalaya's** FTS layer is specified but not implemented. Its Neverest throttle budgets Gmail quota units per second and per minute.
- **Nylas** is a design reference only: its delta API is the clearest change-feed model, and its successor, Nylas Mail, ran a local HTTP API on the desktop.
- **Stalwart** can't pull from Gmail, Outlook or upstream IMAP, so it is useful to Aplos only as a JMAP/IMAP/CalDAV test server.
- **Bulwark's** in-memory change log loses state on restart, and IDLE advanced its state without recording the change (fixed in unmerged PR #35).

---

## 5. What the matrix says

1. **There are three camps, and Aplos is in the third.**
   - **Gmail-first clients, mostly AI-led:** IZ, Zr, Rd, SL, Ta, Av. Most run a server, none serves IMAP users well, and none has a real calendar.
   - **Mature clients without LLM features:** MS, Ge and Pa (multi-protocol), and Tu (its own service only).
   - **2026 local-first, multi-protocol, AI clients:** Co, Fl, Ve and Aplos. All are built by one developer with agents, and all are pre-1.0.

   Within the third camp each has a hole: Co has no draft sync and can double-send, Fl has no logs, and Ve's sync is incorrect. Aplos's holes are a sync that has never worked live, no push, no draft sync and unsafe HTML rendering. The camp is open, but its winner will be whoever is *reliable* first.
2. **Timed features need something always running.** Snooze, send-later, reminders and follow-ups run on a server cron in IZ, Zr and Tu. In MS, Ve and Co they fire only while the app runs. Aplos has no server, so these features need a login-item or menu-bar engine that catches up on wake. Late sends should be suspended rather than sent hours late (Bulwark's rule, `arch/extra-bulwark-legacy-proxy.md` §6).
3. **Draft sync is a common gap, even in mature clients** (MS, SL, Co, DC), and it is solved in Ge, IZ, Zr, Rd, Fl and Pa. It sits high among Aplos's daily-driver gaps because the owner's phone can't see drafts.
4. **HTML isolation separates careful clients from the rest.** IZ, SL, Rd, Ge and Pa isolate email HTML properly. Zr, Tu and MS do not, and Aplos is the most exposed: one sanitizer bypass reaches a bridge that can send mail.
5. **Nobody authors provider-side rules.** It is the one serverless way to have automation run while the Mac sleeps, and no client researched offers it.
6. **AI safety postures are diverging.** IZ moved toward autonomous rules, while Rd, SL and Aplos stay propose-only. Aplos's confirm-only model is a real position, provided the rest of the product is trustworthy (sync, sends, drafts).
7. **Indie clients ship without observability.** Only IZ, MS and EE have real diagnostics. Aplos needed a whole release just to read one 403 reason.

---

## 6. Table stakes Aplos lacks

Ranked by how directly each one stops daily use. "Has it" names the strongest examples from the matrix.

1. **A first sync that finishes on a real mailbox, with honest progress.** *Has it:* MS, Ge (A); Co, Fl (B). Without this, nothing else is real.
   - Metadata-first, newest first: for Gmail, the newest message per thread at `format=metadata`, about 20 units a thread.
   - Each page committed with its resume token.
   - Bodies fetched on open.
   - One per-account quota governor shared by sync, search, the op queue and AI.
   - Daily quota treated as stop-until-reset.

   The UI shows importing N of M, paused until a time, or reconnect (`arch/zero.md` §6, `proto-google.md` §2.3). *Backend.*
2. **New mail without waiting a minute, and no server.** *Has it:* MS, Ge, Co, Fl, Pa.
   - IMAP IDLE on a dedicated connection beside a command connection.
   - JMAP push through `eventSourceUrl`, which the JMAP session already advertises and `main/jmap.ts` never reads.
   - Gmail `history.list` polled at 15 s while focused and 60 s in the background (2 units a call).
   - Graph delta polled adaptively.

   Each push is only a hint that triggers a checkpointed pull (`proto-others.md` §8). *Backend.*
3. **Drafts that live in the mailbox.** *Has it:* Ge (A); IZ, Zr, Rd, Fl, Pa (B).
   - Gmail: the drafts API, with debounced upload and sending through `drafts.send`.
   - IMAP: APPEND to Drafts, then remove the previous copy using UIDPLUS.
   - JMAP: `Email/set`.
   - Hide phone drafts that currently render as messages (`proto-google.md` §6).

   *Backend.*
4. **Safe email rendering.** *Has it:* Ge (A); IZ, SL, Rd, Pa (B).
   - A script-less, opaque-origin sandboxed frame with a strict CSP and styles allowed inside it, which also fixes broken newsletters.
   - Remote content blocked by default and fetched through an engine-side image proxy.
   - Electron fuses on.

   This is a security floor, not polish (`SYNTHESIS.md` weakness 6). *Backend plus UI.*
5. **One-click unsubscribe from headers.** *Has it:* MS, Co, Fl, Ve, IZ.
   - Store `List-Unsubscribe` and `List-Unsubscribe-Post` at sync time.
   - Try RFC 8058 POST, then mailto, then the link, guarded against SSRF.
   - Pair it with the low-importance bundle grouped by sender.

   *Backend plus UI.*
6. **A real snooze, or an honest Later.** *Has it:* IZ, Zr, MS, Fl, Ta.
   - Aplos's Later with a reminder already does most of what snooze does.
   - Add "Later until…" presets that hide the thread until the time, and run that timer in the engine, not the window.
   - Either implement snooze or remove the word from Ask's vocabulary, which is a trust bug today.

   *Both.*
7. **Send later.** *Has it:* Tu (A); IZ, MS, Fl, EE.
   - Build it on the existing persisted `pendingSendAt` hold: one "not before" time covers both undo-send and send-later.
   - Needs the always-running engine from §5 point 2.
   - When a send comes due while the Mac was asleep, ask before sending.

   *Backend.*
8. **Labels and folders.** *Has it:* nearly every client.
   - Apply and remove Gmail labels, move to an IMAP or Graph folder, and list user folders.
   - Today Aplos exposes only the Inbox, Archive, Trash and Spam roles.
   - Derive roles from SPECIAL-USE and Graph well-known folders, never from folder names.

   *Both.*
9. **Basic rules.** *Has it:* IZ (A); MS, Co, Fl, Tu, Pa (B).
   - Block a sender, skip the Inbox, and mark a sender or list as low importance.
   - Write each as a provider filter where one exists (keep the `gmail.settings.basic` scope), and fall back to a local deterministic rule that runs inside the sync write.
   - "Block" currently works only on the Mac.

   *Backend.*
10. **Diagnostics.**
    - A rotating, redacted log file.
    - `crashReporter`.
    - A per-account connection report: granted scopes, token expiry, last error with the provider's reason.
    - A Copy diagnostics button.

    *Has it:* IZ, MS, EE. *Backend.*
11. **A command palette and one command registry.** *Has it:* IZ, Zr, SL, Ta. ⌘K currently just searches. Generate the palette, the shortcut sheet and the tooltips from one table so they can't drift (`aplos-baseline.md` §8). *UI.*
12. **Calendar correctness basics.** *Has it:* MS, Pa (B).
    - RSVP.
    - Recurring events that can be edited.
    - Google saves through `events.patch` with ETags, so Meet links and attendee responses survive.
    - Guests invited when added.
    - CalDAV sync tokens.
    - A week-start setting.

    *Backend plus UI.*
13. **Search that covers mail not yet downloaded.** *Has it:* IZ, Zr.
    - Run provider search only on Enter, about 25 metadata results, cached briefly.
    - Today each typing pause costs about 12,000 Gmail units and swallows errors (`proto-google.md` §0.2).

    *Backend.*
14. **Outlook that actually signs in**, or remove it from the site.
    - Register the Entra app and start publisher verification.
    - Cap Graph at 4 requests in flight per mailbox.
    - Drop the `receivedDateTime` filter from delta queries (`proto-others.md` §0).

    *Backend.*

Lower priority, but expected by daily users: simple templates or snippets (IZ, Zr, MS, Ve) and contacts ranked by how often you write to them (Ge, Nylas). Desktop notifications and a signed public download already exist in code but are unverified, and they belong to `SYNTHESIS.md`'s 30-day plan.

---

## 7. Differentiators worth building

These are places where the matrix shows an empty or thin column and the owner's taste already points.

1. **One keyboard-first Mac client that covers every provider type, with a real calendar.**
   - The Gmail-first AI clients skip IMAP, iCloud and Fastmail. IZ still lacks IMAP despite requests open since 2023 (issues #62, #925).
   - The multi-protocol peers lack AI (MS, Pa) or reliability (Fl is alpha and keeps no logs; Co can double-send).
   - Prove it by verifying iCloud and Fastmail live first; neither needs Google verification (`SYNTHESIS.md`, "What's the wedge?").
2. **A summary-first Home that works without AI and learns from you.**
   - Order mail from header facts first (List-Id, List-Unsubscribe, Precedence, Auto-Submitted, known correspondents) and let the model refine that order, as SL, Rd, Co and Fl do.
   - Give each AI classification a short reason in plain words.
   - Add one key that corrects importance and records a deterministic sender rule.
   - Show a visible "from now on" toast with Undo (Av).

   No single product combines all four.
3. **AI that proposes, with provenance.**
   - Keep Ask's confirm cards, citations and validated links and dates. Present them against IZ's unattended rules and Zero's autonomous chat.
   - When an MCP surface comes, copy the MS/Co pattern: loopback only, a token, read/draft/send tiers with send off by default, and an activity log.
4. **Plans: mail to a calendar you can see.** Event extraction with clash detection into a full week view is unique in the set. IZ offers booking links and meeting briefs on a server; Av only adds events to Google Calendar.
5. **Automation that runs while the Mac sleeps, with no Aplos server.**
   - Author Gmail filters, Outlook inbox rules and Fastmail/ManageSieve scripts from Aplos's own rule UI.
   - Apply each rule to existing mail with `batchModify`.
   - No client researched does this. It also answers the moat argument ("a server can act while your Mac sleeps"): the provider is the server.
6. **Your mail goes only where you choose.**
   - A model per feature, including Ollama and LM Studio. Consider Apple's on-device model, as Co and MS already ship.
   - Add a consent card before any bulk AI pass, versioned the way Rd does it, so a scope change turns AI off until the user agrees again.
   - Redact sensitive data before cloud calls.
   - Keep summaries off the sync path in a budgeted queue.
7. **A guided way to clear Home.**
   - The existing stack and deck.
   - A low-importance sheet grouped by sender, with read rates and unsubscribe on each sender.
   - "Press twice" bulk confirm instead of a dialog (Av).
   - A resumable two-phase session: first a checklist of no-action mail, then one at a time (SL).
8. **"How you know this sender," computed locally.**
   - Two-way thread count, a 12-week sent/received rhythm, recent threads (SL).
   - Contact ranking weighted by how recently you sent to them (Nylas, Ge).
   - It costs nothing, needs no AI, and supports both importance and autocomplete.
9. **Cross-device continuity without a vendor server.**
   - Keep the encrypted workflow record, but stop it littering Trash, and move app metadata (Done, Later, due dates, AI results) to its own cursor-paged feed.
   - Later, the Mac engine can become the local server a phone pairs with. Nylas Mail's local API is the nearest precedent, and no current product serves a phone from the desktop.
   - The architecture reports converge on this shape: a typed, JMAP-shaped contract with a durable change log, then loopback HTTP with SSE, then pairing (`arch/stalwart.md` §7, `arch/nylas-sync-engine.md` §7).
10. **Duplicate hygiene across accounts.** Aplos's exact-duplicate archive plus SL-style hiding of forwarded copies suits people who forward one account into another, which unified-inbox users often do.

---

## 8. Features to skip deliberately (and some to defer)

**Skip:**
- **Open and link tracking, read receipts.** These are a privacy cost to the recipient. They need a cloud service (MS Pro) or ship on by default (IZ). Remote-image blocking already protects Aplos's own user.
- **Promotional signature by default.** Zr, Rd, Av and Pa spend user trust on growth. Keep Aplos's footer opt-in.
- **Server-hosted features.** Gmail Pub/Sub and Graph webhooks need a public endpoint or a privileged credential on every Mac (`proto-google.md` §5). Also skip email digests, meeting briefs, AI notetakers, Slack/Teams/Telegram channels and third-party context integrations. Each needs an always-on server and a privacy story Aplos doesn't want.
- **Team features:** organizations, shared rules, comments, shared inboxes, SSO/SCIM. Aplos is a one-person Mac app.
- **Unattended AI actions** (auto-send, auto-forward, webhooks). This conflicts with the confirm-only position that is one of Aplos's real advantages. Deterministic rules that only archive, label or set low importance are fine.
- **An LLM rewriting every search query** (Zr). It leaks private queries and adds latency. Parse operators locally, and if natural language is ever added, show the rewrite as editable operator tokens.
- **Mirroring the whole archive plus an embedding store.**
  - EmailEngine removed its Elasticsearch document store after years of upkeep.
  - IZ deletes every body under disk pressure.
  - Keep a bounded window and lazy bodies. Local semantic search can come later, opt-in (Co, Fl).
- **Running a mail server or hosting mail** (Rd's Stalwart domains, Stalwart as Aplos's store). Stalwart can't sync from upstream and it re-threads Gmail mail (`arch/stalwart.md` §7).
- **Plugins, mini-app runtimes and theme marketplaces** (MS Views and plugins, Delta webxdc). These carry a large maintenance and security burden for a one-developer app.
- **Gmail over IMAP to escape quotas, and bring-your-own OAuth client as the main path** (Co, Ve, SL, Fl testers). The IMAP scope is also restricted and loses history and labels, and BYO OAuth loses non-technical users.
- **Split view, tabs, and Needs-reply/Awaiting-reply mailboxes.** The owner already rejected these. Rd's tabs piled up after a short session, and Av's reply mailboxes duplicate Home.
- **Analytics dashboards** (IZ, MS Pro). The per-sender panel in §7 point 8 gives one user what matters.
- **POP3, Exchange EWS/ActiveSync, mail merge, SMS assistants.** Graph covers Exchange, and the rest are niche.

**Defer (worth doing, not now):**
- **Phone app.** It needs the typed contract and durable change log first. It should reach mail through the Mac engine, so per-account connection and quota budgets aren't split (`proto-others.md` §0.10).
- **Windows and Linux.**
- **PGP and S/MIME** (Fl, Pa).
- **Encrypting the database at rest.** Tuta does this with SQLCipher; Delta Chat deprecated it because attachments stay in plaintext. FileVault suffices until there's demand.
- **MCP.**
- **On-demand translation** (IZ, MS).
- **Templates beyond simple snippets.**

---

## 9. Open questions

- Does the owner want snooze as a separate verb, or should "Later until…" with presets be the only deferral? The answer changes the Later UI and the vocabulary cleanup (`aplos-baseline.md` §6.6).
- Should Aplos stay running in the menu bar after its last window closes? Send-later, snooze wake-ups, reminders and IDLE all depend on that, and Tuta, Ge and Co each offer a background or tray mode.
- For Gmail: keep `gmail.modify` plus `gmail.settings.basic` (filters, history polling), or move to `mail.google.com/` (adds IMAP IDLE as a free wake signal and a broader review)? `proto-google.md` §4 favours staying on REST.
- Avec and Tatem are closed source, so their storage, search, drafts and unsubscribe mechanisms are unverified (the `?` cells). If Avec stays the feel reference, a careful hands-on session with the owner's own test account would close those gaps without inspecting its bundle.
- Several `?` cells for comail, Flectar, Parula and Velo (command palette, contacts, explainability) would take a quick targeted read of their clones in `/Users/knewton/.t3/aplos-research/src/` if any decision depends on them.
