# Council answer (Claude Opus): Aplos Mail vs Inbox Zero

## 1. Verdict

Today Aplos is not a competitor to Inbox Zero. It is a well-engineered prototype that no outside person can download, sign into Gmail with, or receive updates for, and its one live Gmail sync failed. Inbox Zero is a three-year-old product with real users, push-driven automation that runs while you sleep, a CASA/verification posture that lets the public connect Gmail, and, as of 18 October 2026, a free keyboard-first client on web, Mac, Windows and iPhone. That client overlaps directly with Aplos's pitch. Aplos's real assets are a direct device-to-provider data path with no vendor server, IMAP/JMAP/CalDAV code that Inbox Zero has never shipped, an integrated calendar, and an AI design that only proposes and never acts. None of these assets has been proven on a real mailbox. The next 30 days should be spent getting a reliable sync and a downloadable build onto other people's Macs, not adding features. On breadth Aplos loses by construction.

## 2. Feature comparison

| Capability | Inbox Zero | Aplos | Winner | Evidence / maturity |
|---|---|---|---|---|
| Can a stranger use it today | Yes: hosted, verified Google app (claimed CASA), free client | No: private repo, 404 feed, Google app in Testing (100 users, 7-day tokens), no Microsoft client ID | **IZ, decisively** | Brief facts; aplos-product §5 |
| Gmail sync | Production, push via Pub/Sub. First-sync fan-out is fragile (50× `messages.get`) | Code complete. Only live run failed 403; 0.2.3 untested | IZ | IZ `google.ts:1462`; Aplos `google.ts:171-203` |
| Outlook / M365 | Production, weaker than Gmail | Emulator only, cannot sign in | IZ | `MICROSOFT_CLIENT_ID` absent |
| IMAP / JMAP / iCloud / Fastmail / CalDAV | None (issues #62, #925 open since 2023) | Implemented, fake servers only | Aplos on paper; unproven | aplos-arch §3 |
| Automation while you're away (rules, cold email, auto-label) | Deep: 17 action types, delayed actions, learned patterns, test mode | None. Rules deferred in SPEC | **IZ** | IZ `utils/ai/choose-rule`; Aplos SPEC |
| AI triage / importance / summaries | Rule-based labels and categories | Per-thread summary, importance, due date, Space action. Groq live on synthetic data only | Different shape. Aplos UX is more ambitious and unproven | aplos-product §2 |
| Drafts in your voice | Deep: reply memory learned from edits, knowledge base, calendar slots | Polish, proposed drafts, chip. No learning. Drafts stay local, never in Gmail | IZ | `ReplyMemory` model; Aplos `google.ts` has no `drafts` calls |
| Chat / Ask agent | Deep: ~25 tools, memory, Slack/Teams/Telegram. Inbox actions without confirmation | Bounded 6-step agent, read tools plus confirm-only cards | IZ on breadth, Aplos on safety | iz-arch §4; Aplos `agent.ts` |
| Reply tracking / follow-ups | Deep, cron-driven, nudge drafts | Waiting-on-you / 3-day follow-up sections, local only | IZ | |
| Bulk unsubscribe / cleanup | Deep: RFC 8058 ladder, sandboxed Playwright agent, read rates | Regex finds a body link only; no `List-Unsubscribe` | **IZ** | Aplos `service.ts:939-945` |
| Calendar UI | Scheduling replies, booking links, no calendar view | Full week/day/month, drag edit, multi-provider (unverified live) | Aplos | |
| Snooze / send later | Yes (client) | Later + reminder; no send-later | IZ | |
| Search | Provider search plus local SQLite in client | FTS5 + operators + provider merge, fast on synthetic 10k | Rough tie | PROGRESS M34 |
| Platforms | Web, Mac, Windows, iPhone, old Android | macOS only | **IZ** | |
| Multi-device state | Server is source of truth | Encrypted workflow log in a hidden mailbox label. Clever, but workflow state only | IZ | `workflow-sync.ts` |
| BYO / local AI | BYOK (hosted), Ollama/compatible on self-host only | Nine providers per feature, local Ollama/LM Studio in the shipped app | **Aplos** | `shared/ask.ts` |
| Mail data path | All mail passes through IZ servers, even for the "local-first" client | Device to provider directly. AI text goes to the chosen LLM | **Aplos** | IZ `mail-core/protocol/backend-adapter.ts:56` |
| Security of HTML rendering | Sandboxed frames / image proxy | DOMPurify into privileged renderer, CSP `unsafe-inline`, styles stripped | IZ | Aplos `Reader.tsx:169`, `mailBody.ts:44` |
| Testing | ~1:1 test ratio, emulator Playwright, AI eval matrix (manual) | ~230-260 unit/fake-server tests, no UI E2E in CI, 8-case Groq eval | IZ | |
| Team / enterprise / API / MCP | Orgs, SSO, SCIM, MCP, REST, Slack | None | IZ (irrelevant to Aplos's user) | |
| Price | Free client; AI $18-50/user/mo | Free; user pays their LLM | Aplos for cost-sensitive technical users | |

## 3. Architecture: local-first desktop vs server SaaS

**Push and latency.** IZ gets Gmail Pub/Sub and Graph webhooks, so rules fire seconds after arrival. Aplos polls every 60 s per account (`service.ts:958`), and only while the Mac is awake and the app is running. That is acceptable for a client and fatal for an assistant. IMAP IDLE and JMAP push would work without a server, and Aplos implements neither.

**Rules while the laptop sleeps.** This is IZ's core value and the hard cap on Aplos. Aplos has an escape hatch it isn't using: **provider-side filters**. Gmail filters (`users.settings.filters`, which needs the `gmail.settings.basic` scope Aplos already requests), Outlook inbox rules (Graph `messageRules`) and Fastmail Sieve all run 24/7 on the provider's servers. Deterministic automation such as "block sender", "auto-archive this newsletter" or "label mail from X" can be compiled into real filters. AI rules cannot.

**Multi-device.** IZ's server gives every surface one truth. Aplos re-syncs, re-summarizes (paying the LLM again) and keeps drafts, settings and blocked senders separately on every device. The hidden-label log is solid engineering, but every new surface multiplies the sync problem. A phone app under this design means a second full sync client.

**Privacy.** This is Aplos's strongest structural edge, and it is narrower than the website implies. Mail never touches an Aplos server, while IZ's new client still proxies mail through `/api/mail/v1` (verified). But by default every new email goes to Groq, so "your mail stays on your Mac" holds only with a local model. IZ's hosted users trust IZ plus 14 subprocessors. Aplos users trust Apple, Google and one LLM vendor of their choice.

**Cost and scale.** Aplos costs nothing to run per user, and that is real. IZ pays for Postgres, Redis, queues, LLM calls and CASA renewals, which is why it charges $18-50. Aplos's ceiling is local: the whole mailbox lives in memory as JSON (`store.ts`, `service.ts:268` clones state on each mutation). It is fine at 500 threads plus growth, and it is not built for a 10-year inbox.

**Verification burden.** This is the under-appreciated one. Google's restricted scopes treat a desktop app much like a SaaS app, so Aplos carries IZ-scale compliance work with zero revenue. IZ amortizes CASA across paying users. Aplos has two partial outs. Providers that need no OAuth verification (iCloud, Fastmail, generic IMAP, even Gmail over IMAP with an app password) could ship now. And if Google confirms it, data that never reaches a developer server can mean a lighter assessment. Sending mail to Groq may undermine that argument; ask Google.

## 4. Ten most serious weaknesses relative to Inbox Zero

1. **Nobody else can get in.** The repo is private, so the website's Download button and electron-updater return 404. The Google app is in Testing (100 test users, refresh tokens die after 7 days, unverified warning). Outlook has no client ID, and the website claims Outlook/iCloud/Fastmail support that has never run. *Fix:* publish releases to a public repo or a generic feed (R2/S3/Vercel) and switch electron-updater to it. Move the consent screen to "In production" (unverified) to end the 7-day expiry for the owner and early testers. Register a free Entra app. Make the site claim only what has been verified. *Effort:* 2-3 days, plus 1-3 months of Google verification running in parallel.

2. **Gmail first sync is fragile and has never succeeded live.** It makes 500 `threads.get?format=full` calls at concurrency 4 with `includeSpamTrash=true`, serial attachment fetches, no shared pacing, and no checkpoint. One failure rejects the whole `Promise.all` while sibling workers keep spending quota, and the next attempt starts from zero (verified `google.ts:171-203`). *Fix:* run a metadata-first pass, commit each page with a resume cursor, use a per-account token bucket in quota units, add an AbortController for siblings, exclude Spam/Trash, load bodies lazily for older mail, and treat daily `quotaExceeded` as stop-for-today. Aplos currently retries it (`RATE_REASONS`). *Effort:* 3-5 days, plus one real-mailbox run with evidence.

3. **The product depends on AI the default tier cannot afford.** `classifyIncoming` is awaited inside the account sync (`service.ts:645`) for every new thread, including Spam. Groq's free tier is 200K tokens/day (DECISIONS:259), so summarizing ~500 first-sync threads probably exhausts a day's quota and stalls sync behind 429s. Home's importance ordering has no non-AI fallback, so without a key Home becomes the whole inbox. *Fix:* decouple enrichment into a budgeted background queue and summarize only recent unread inbox mail first. Add a deterministic importance heuristic (bulk headers, `List-Unsubscribe`, known correspondents, replied-to senders) and ask explicit consent before bulk-sending mail to an LLM. *Effort:* 2-4 days.

4. **There is zero observability.** No log file, no crash reporter, about 32 empty catches. Diagnosing the 403 took a release. *Fix:* add a rotating local log with redaction, a "Copy diagnostics" button, and an opt-in `crashReporter`. *Effort:* 1-2 days.

5. **No automation runs while away, and none exists even while open.** There are no rules of any kind. *Fix:* compile deterministic actions (block, auto-archive sender, label) into provider-side filters. Add local "on arrival" rules for the AI layer and label them honestly as "when Aplos is running". *Effort:* 1 week.

6. **It is a Mac-only island.** IZ has web, Windows and iPhone. Aplos's drafts don't sync to Gmail, reminders fire only on an awake Mac, and there is no phone app. *Fix:* sync drafts through Gmail `drafts.*` / Graph / IMAP Drafts so the phone sees them. Accept Mac-only for 2026 and say so. *Effort:* 2-3 days for drafts.

7. **Email HTML has both a security problem and a rendering-fidelity problem.** Sanitized HTML is injected into the privileged renderer with CSP `script-src 'unsafe-inline'`, and `style` is stripped, which breaks most newsletters (verified `mailBody.ts:44`). Electron fuses are not configured and the entitlements are broad. *Fix:* render in a sandboxed `<iframe srcdoc>` without `allow-scripts` under a separate partition, keep styles inside the frame, tighten the CSP, flip `RunAsNode`/`NodeOptions`/`NodeCliInspect` and enable asar integrity, and drop `allow-unsigned-executable-memory` if possible. *Effort:* 3-4 days.

8. **Sync semantics have correctness gaps.** `reset:true` is produced by Gmail, JMAP and IMAP but never consumed (verified), so ghost threads persist. Block is local-only. Unsubscribe ignores `List-Unsubscribe` and RFC 8058. *Fix:* reconcile on reset within the window, block via a provider filter, add a one-click POST then mailto then link fallback. *Effort:* 3 days.

9. **The data model has a hard ceiling.** The full mailbox sits in memory and is copied several times across processes, bodies are never evicted, and `clone(state)` is returned over IPC. *Fix:* keep metadata in memory, read bodies on demand from SQLite, use paged IPC everywhere, and add an eviction policy. *Effort:* 1-2 weeks. Not urgent until real users exist.

10. **There is no product-level verification loop.** No renderer E2E in CI, the AI eval is manual and Groq-only (8 cases), and the code is formatted at roughly minified density. *Fix:* run Playwright against the built-in demo mailbox in CI, add a formatter in one mechanical commit, and add the eval to CI behind a secret. *Effort:* 2-3 days.

## 5. Where Aplos can genuinely win

- **The non-Gmail/Outlook user (strong).** IZ has refused IMAP for three years, and iCloud and Fastmail users have no AI-forward keyboard client. These providers need no Google verification. This is the fastest path to real users *and* the most defensible niche. It depends entirely on verifying the IMAP/JMAP/CalDAV code live.
- **"No vendor server" privacy plus local models (moderate).** The claim holds against IZ's hosted product and its new client (verified server proxying), and Ollama/LM Studio support ships in the app rather than requiring self-hosting. It is weakened by the Groq default; market "local AI mode" explicitly.
- **AI that never acts (moderate).** IZ removed its approval flow (`ExecutedRuleStatus.PENDING` deprecated, verified) and auto-executes reply/forward/webhook rules. Aplos's proposal-only cards are a real trust story for cautious users.
- **Email plus calendar in one keyboard app (moderate).** IZ has no calendar view. This is weakened by Notion Calendar, Fantastical and Apple Calendar existing, and Aplos's calendar can't create recurring events or RSVP.
- **Cost (weak to moderate).** Free plus BYO key beats $18-50/month only for technical users. For normal users, choosing an API key is friction, and the free Groq tier can't cover the default workload.
- **The "finishable Home" UX (unproven, so weak today).** IZ's new client is a Superhuman-style split inbox, and Aplos's single-focus, summary-first Home is a sharper idea. But it has only been seen on demo mail, and its quality depends on importance classification that has never run on real mail. Taste is a moat only after it survives a real inbox.

## 6. What to learn from Inbox Zero (ideas only, no code)

- **Deterministic first, LLM second.** Static matches, header heuristics and learned sender patterns run before any model call. This fixes weakness 3 and cuts cost.
- **Their unused sync-budget design.** Quota-unit token bucket, one in-flight request per account, historyId captured before backfill, a single retry layer, sequential hydration. Their own live path doesn't use it; Aplos should.
- **Classify by Gmail `reason`, not status.** Parse "Retry after <timestamp>" from the message and stop for the day on daily quota.
- **Emulated-provider E2E.** Playwright against fake Gmail/Graph servers. Aplos already has fakes; wire them to UI tests.
- **AI explainability and correction.** A "why" reason on each classification, a test mode on past mail, and a "fix" action that turns corrections into sender patterns. That gives Home a learning loop.
- **Learning drafts from edits.** Store the diff between AI draft and sent text as style memory.
- **Unsubscribe ladder and a sender-grouped cleanup view with read rates.** This makes the "finish your inbox" promise true for backlog.
- **Sensitive-data redaction before LLM calls**, and structural limits on which fields AI can fill.
- **Do not adopt:** open-tracking on by default (`schema.prisma:166`, verified), auto-executing outbound actions, four queue backends, feature-flag sprawl.

## 7. Ranked 30-day plan

1. **Days 1-4: make Gmail first sync survive** (weakness 2) and add diagnostics (weakness 4). Then run it on the owner's real Gmail and record evidence in PROGRESS.
2. **Days 1-2, in parallel: Google console.** Switch to Production unverified, confirm the Gmail/Calendar APIs are enabled on the project whose client ID is in the build, check granted scopes in the token response, and handle `invalid_grant` as "reconnect".
3. **Days 3-5: decouple AI from sync** and add heuristic importance, a first-sync AI budget and a consent prompt (weakness 3).
4. **Days 5-7: distribution.** Public release feed, working Download button, honest website copy, publish 0.3.0, install on a clean second Mac.
5. **Week 2: live-verify iCloud and Fastmail** (no verification gate), plus the Entra registration and an Outlook live test. Fix what breaks.
6. **Week 2: HTML sandbox iframe with styles, fuses, CSP** (weakness 7).
7. **Week 3: `reset` reconciliation, Gmail drafts sync, `List-Unsubscribe` one-click, block via provider filter** (weaknesses 6 and 8).
8. **Week 3: Playwright-on-demo in CI, formatter commit, eval in CI.**
9. **Week 4: recruit 10-20 testers** (inside the 100-user cap, plus IMAP users without a cap) and track day-7 retention by asking. Start Google verification: final privacy policy with Limited Use wording, demo video, and the CASA scoping conversation.
10. **Week 4, only if retention is real:** start the metadata/body split (weakness 9) and the first provider-filter rules (weakness 5).

Not in 30 days: Windows, mobile, teams, MCP, meetings.

## 8. Disagreements and spot checks

**What I checked in source.**
- *Aplos `google.ts:171-203`:* concurrency 4, `includeSpamTrash=true`, `format=full`, `Promise.all` all-or-nothing, serial body-attachment fetches. **Confirmed.**
- *Aplos `reset` ignored:* grep finds only producers (`google.ts:202`, `jmap.ts:267,271`, `imap.ts:434`) and no consumer in `engine/`. **Confirmed.**
- *Aplos AI on the sync path:* `service.ts:645` awaits `classifyIncoming` for fresh, replies and spam inside the account sync. **Confirmed.**
- *Aplos unsubscribe:* body-link regex only (`service.ts:939-945`), zero `List-Unsubscribe` hits. **Confirmed.**
- *Aplos HTML rendering:* `dangerouslySetInnerHTML` in `Reader.tsx:169`, no iframe anywhere in the renderer, CSP `script-src 'self' 'unsafe-inline'`, DOMPurify forbids `style`. **Confirmed.**
- *Aplos binary hardening:* entitlements include `disable-library-validation` and `allow-unsigned-executable-memory`, and no fuses configuration was found. **Confirmed.**
- *Aplos scopes and drafts:* `gmail.settings.basic` is requested (`google.ts:310`), and there are no `drafts` calls. **Confirmed.**
- *IZ `mapProviderError`:* returns `retryAfterMs: 1000` for generic errors (`source.ts:576`), and bootstrap uses `getMessagesWithPagination`, which does `Promise.all` over every ID (`google.ts:~1462`). **Confirmed, with a nuance below.**
- *IZ `syncLocalMail`:* only test call sites. **Confirmed.**
- *IZ Outlook refresh:* saves only `access_token` and reuses the old refresh token (`outlook/client.ts`). **Confirmed.**
- *IZ approval flow:* `PENDING`/`REJECTED` are marked deprecated. **Confirmed.**
- *IZ open tracking:* `@default(true)`. **Confirmed.**
- *IZ client sync path:* goes through `/api/mail/v1`. **Confirmed.**

**Where the reports are wrong or overstated.**
- **aplos-architecture, "no release is signed":** wrong, as the brief already notes. Auto-update is blocked by the private repo, not by signing.
- **aplos-architecture, "it already failed at 10k threads":** overstated. The 210 s non-completion was a *pre-fix* exploratory run. After the fix, the 10k import took 3.2 s (PROGRESS M34). The memory concern (bodies cached in several processes) is real, but the cited failure is stale.
- **aplos-architecture, "the 403s follow directly from these":** unproven, and partly a non sequitur, because the data model has nothing to do with a 403. The full window is about 5,000 quota units, well under 15,000/minute, so only burst or concurrency limits fit the rate-limit theory. `accessNotConfigured` on the build's project, or `insufficientPermissions` from granular consent, are at least as likely. Treat 0.2.3 as a diagnostic build and read the reason before rewriting anything else.
- **aplos-architecture, "dropping `gmail.settings.basic` shrinks the restricted surface":** misleading. `gmail.modify` is restricted on its own, so CASA scoping doesn't change. Keep the scope if Aplos will write Gmail filters, which is its best route to server-side automation.
- **inbox-zero-architecture, "a 403 gets a retry about 1 second later":** partly overstated. Each `messages.get` is wrapped in `withGmailRetry`, which retries 5 times and honours Retry-After (`utils/gmail/message.ts:118-131`) before the 1 s pause applies. The real problem is 50 independent retriers with no shared budget. The lesson stands.
- **Both Aplos reports miss that Aplos repeats an IZ mistake:** `RATE_REASONS` retries daily `quotaExceeded`.
- **inbox-zero-architecture, "local-first client":** this framing overstates IZ's privacy. Local storage is a cache, and all mail still transits their server.
- **aplos-architecture, "sends hundreds of emails with no consent":** directionally right. The user did enter a key, but nothing tells them that connecting an account sends its whole first-sync window to the LLM.
