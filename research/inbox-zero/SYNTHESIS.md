# Aplos Mail vs Inbox Zero — council synthesis

2026-10-25. Built from four research reports (Inbox Zero's product and code; Aplos's product and code) and four independent council critiques (Claude Opus 5.5, Kimi K3, GLM-5.3, DeepSeek V4 Pro). The source reports are in this folder and the council answers are in `council/`. Facts I verified directly override the reports.

## Verdict (unanimous)

Aplos is not competing with Inbox Zero yet. It is a well-engineered two-week-old prototype that has never synced a real mailbox, and nobody but the owner can download it. Inbox Zero is a three-year-old product with 12.8k stars and about 90 contributors, though one founder wrote roughly 88% of the commits. It has paid tiers and push-driven automation, and on 2026-10-18 it launched a free keyboard-first client for web, Mac, Windows and iPhone. That client overlaps directly with Aplos's pitch.

Aplos's real assets are structural. It talks to the provider directly with no vendor server in between. It can use local AI models. It supports IMAP, JMAP and CalDAV, which Inbox Zero has refused to build since 2023. It has a real calendar. Its AI proposes actions and never takes them on its own. None of these advantages has been proven on a real mailbox. **The next 30 days are about one real sync and one stranger's download, not features.**

## The overall picture

| Area | Inbox Zero | Aplos | Winner |
|---|---|---|---|
| Can a stranger use it today | Yes | No: private repo, so download and update feed 404; Google app in Testing; no Outlook client ID | IZ, decisively |
| Live Gmail / Outlook | In production, with push (Pub/Sub, Graph webhooks) | Gmail's only live run returned 403. Outlook can't sign in. | IZ |
| IMAP / JMAP / iCloud / Fastmail / CalDAV | None (issues #62, #925 open since 2023) | Code exists, tested only against fakes | Aplos on paper |
| Automation while you're away (rules, cold email, nudges) | Deep: 17 action types, delayed actions, test mode, learned patterns | None | IZ |
| Drafts in your voice | Learns from your edits, knowledge base, confidence gating | Polish and chips; no learning. Drafts never sync to Gmail. | IZ |
| Chat agent | About 25 tools, plus Slack, Teams and Telegram. Outbound actions run without approval. | 6-step agent, read-only tools, confirm-only cards | IZ on breadth, Aplos on safety |
| Unsubscribe and cleanup | `List-Unsubscribe`, RFC 8058 one-click, sandboxed agent, read rates | Body-link regex only | IZ |
| Calendar | Booking links and briefs; no calendar view | Full week, day and month views with drag editing; no recurrence or RSVP | Aplos, unverified |
| Mail data path | All mail passes through IZ's servers, even in their "local" client (`/api/mail/v1`) | Device to provider directly; AI text goes to the LLM you choose | Aplos |
| Local AI | Self-hosters only | Ships in the app (Ollama, LM Studio) | Aplos |
| Platforms | Web, Mac, Windows, iPhone | macOS only | IZ |
| Rendering email HTML | Sandboxed frames, image proxy | DOMPurify into the privileged renderer, CSP `unsafe-inline`, styles stripped | IZ |
| Testing | About 1,300 test files, emulated-provider Playwright, eval matrix (manual) | About 230 to 260 unit and fake-server tests, no UI end-to-end in CI, 8-case eval | IZ |
| Observability | Sentry, Axiom, PostHog | None: no log file, no crash reporter | IZ |
| License | AGPL plus an enterprise license required for 5+ business users | The owner's choice | Aplos opportunity |
| Price | Client free, AI $18-50 per user per month | Free; you pay your own LLM | Aplos, for technical users |

## Architecture in one paragraph

A server can act while your Mac sleeps, and a Mac app cannot. That is Inbox Zero's moat and Aplos's hard ceiling. Inbox Zero can add local-first (it just did), but Aplos cannot add an always-on automation layer without becoming a hosted service. Aplos has two escape hatches that need no server, and it uses neither. The first is **provider-side filters**: Gmail `settings.filters`, Outlook `messageRules`, and Fastmail Sieve all run around the clock on the provider's own servers. The second is **IMAP IDLE / JMAP push**, which delivers new mail instantly while the app is open. In exchange, Aplos costs nothing to run per user, keeps mail out of anyone's servers, and can talk to any protocol. Google's verification burden is about the same for both products, but Inbox Zero spreads it across paying users and Aplos has no revenue to cover it.

## Ranked weaknesses (council consensus, with fixes)

1. **Nobody else can install or update it.** The private repo makes the Download button and `latest-mac.yml` return 404. *Fix:* make the repo public, or publish releases to a public releases-only repo and point electron-updater and `releasesUrl` at it. Then publish one release and test a clean install plus an auto-update. *Hours.* All four council members ranked this first or second.
2. **Gmail first sync is unsound.** It fetches 500 `threads.get?format=full` at concurrency 4, including Spam and Trash. Body attachments are fetched serially. There is no shared quota budget, no batching, no `fields` mask, and no checkpoint. One failure rejects the whole run while sibling workers keep spending quota, and the next attempt starts from zero. *Fix:* metadata-first pass, a per-account token bucket measured in quota units, page commits with a resume cursor, cancel siblings on failure, exclude Spam and Trash, lazy bodies, and a smaller first window. *3-5 days.* Inbox Zero's unused `local-mail-sync-budget.ts` is the right design to learn from. Their shipped path has the same bug.
3. **No observability.** It took a whole release just to read Google's 403 reason. *Fix:* a rotating, redacted local log file; `crashReporter`; a "Copy diagnostics" button; and a per-account connection report showing granted scopes, token expiry and last error. *1-2 days.*
4. **AI is on the sync critical path.** `classifyIncoming` is awaited inside account sync for every new thread, including spam. On Groq's free tier (about 200K tokens a day), a 500-thread first sync can stall every account behind 429 responses. It also sends hundreds of emails to a third party without explicit consent. Home has no fallback ordering without AI. *Fix:* a budgeted background enrichment queue (recent unread inbox first); a deterministic importance heuristic based on bulk headers, `List-Unsubscribe`, known correspondents and replied-to senders; and a consent card before the first bulk AI pass. *2-4 days.*
5. **Google OAuth isn't production-ready.** The app is in Testing (100 users, 7-day refresh tokens) and requests restricted scopes, so CASA is needed. The code never checks which scopes were granted, and `invalid_grant` isn't mapped to "reconnect". *Fix:* switch to Production (unverified) now, check the token's `scope`, add a Reconnect state, and start verification (privacy policy with Limited Use wording, demo video, CASA). *Code days; Google takes weeks to months.*
6. **Email HTML is a security and rendering problem.** It is injected into the document that holds `window.aplos`, under `script-src 'unsafe-inline'`. One sanitizer bypass would let an email send mail or export the mailbox. Styles are stripped, which breaks newsletters. No Electron fuses are set. *Fix:* a sandboxed opaque-origin `iframe srcdoc` with styles allowed inside it, a tighter CSP, fuses (RunAsNode off, asar integrity), and narrower entitlements. *3-7 days.*
7. **It isn't a daily driver.** Drafts never reach Gmail, so your phone can't see them. There is no send-later, no first-class snooze, no `List-Unsubscribe`, no rules, and "Block" only works locally. *Fix, in this order:* Gmail draft sync, one-click unsubscribe, block via a real Gmail filter, snooze, send-later, then a small deterministic local rules feature. *2-3 weeks.*
8. **Sync correctness gaps.** Adapters return `reset:true`, but the engine never reads it, so threads deleted on the host stay in Aplos as ghosts. *Fix:* reconcile the window on reset. *1-2 days.*
9. **The data model has a ceiling.** The whole mailbox lives in memory and is cloned on each change, bodies are never evicted, and full state crosses two IPC hops. *Fix:* metadata in memory, bodies loaded on demand from SQLite, paged IPC (`threads.page` already exists), and eviction. *1-3 weeks; not urgent until real users arrive.*
10. **Maintainability and verification loop.** The code is written in very dense one-liners with no formatter or linter, `service.ts` is a god closure, the IPC allowlist is copied in three places, there is no renderer end-to-end test in CI, and the eval is manual. *Fix:* one Biome/Prettier formatting commit, a typed IPC contract, Playwright on the demo mailbox in CI, and the eval in CI behind a secret. *About a week, mostly mechanical.*

## Disagreements, resolved

- **Is the 10k-thread failure real?** Kimi and GLM cite it. Opus checked PROGRESS: the 210 s failure happened *before* the fix, and the 10k import took 3.2 s after it. **Stale.** The memory concern still stands.
- **Was the 403 caused by rate limits?** The full window is about 5,000 quota units, well under 15,000 per minute, so only a burst or concurrency limit fits the rate-limit theory. A disabled API on the build's project, or `insufficientPermissions` from granular consent, fits just as well. **Treat 0.2.3 as a diagnostic build.** Read Google's reason before rewriting anything.
- **Should we drop `gmail.settings.basic`?** Three members said drop it. Opus said keep it. **Keep it.** `gmail.modify` is restricted on its own, so dropping the other scope doesn't reduce the CASA review. `settings.basic` is also what lets Aplos write Gmail filters, which is its best route to automation that runs while the Mac sleeps.
- **What's the wedge?** DeepSeek: "the private, multi-protocol, keyboard-first client for people whose mail is *not* on Gmail." Opus agrees it is the strongest and fastest option, since iCloud, Fastmail and IMAP need no Google verification. GLM and Kimi lean toward privacy plus local AI plus calendar. **Synthesis:** lead with iCloud, Fastmail and IMAP users, plus privacy and local AI. Keep Gmail as a first-class provider, but don't make it the launch gate.
- **Is the claimed privacy advantage real?** It's real but narrower than the website says. With Groq as the default, every summarized email goes to Groq. The honest claim is "your mail goes only where you choose," backed by a one-click local-AI mode.

## New findings that only one or two members caught

- **Bug in 0.2.3 (Opus):** `RATE_REASONS` retries `quotaExceeded`. Daily quota should be stop-for-today, not five retries. Also parse "Retry after <timestamp>" from Google's message.
- **The AI says it can snooze (DeepSeek):** `writer.ts` accepts "snooze" as an alias for Later, and `ask.ts` advertises snoozing, but snooze doesn't exist as a state. This is a trust bug.
- **The website overclaims (Kimi, DeepSeek):** "Works with Gmail, Outlook, iCloud, Fastmail" is false today. Outlook can't sign in, and nothing non-Gmail has run live.
- **Cross-device sync litters Trash (GLM, DeepSeek):** the hidden-label sync messages are trashed after every merge.
- **Inbox Zero safety regression (all):** their approval flow was removed (`PENDING` is deprecated), so rules send, forward and call webhooks without confirmation. Their Outlook refresh also discards rotated refresh tokens. Open tracking is on by default. Don't copy any of this. Aplos's confirm cards are a real trust story.

## Learn from Inbox Zero (ideas only; their code is AGPL, never copy it)

- Deterministic matching first and the LLM second: static rules, header heuristics and learned sender patterns before any model call.
- A sync budget in quota units, one in-flight request per account, one retry layer, `historyId` captured before backfill.
- Classify errors by Google's `reason`, not the HTTP status.
- Emulated-provider Playwright end-to-end tests.
- A "why" on every AI classification, plus a "fix this" action that turns a correction into a sender pattern. This gives Home a learning loop.
- Learn drafting style from the difference between the AI draft and what was sent.
- A sender-grouped cleanup view with read rates, and the unsubscribe ladder (one-click POST, then mailto, then link).
- Redact sensitive data before LLM calls, and limit structurally which fields the AI may fill.

## 30-day plan (merged ranking)

1. **Days 1-2: distribution.** Public release feed, a working Download button, honest website copy, publish one release, and install and auto-update it on a clean Mac.
2. **Days 1-3: diagnostics.** Log file, crash reporter, Copy diagnostics, connection report.
3. **Days 1-2, Google console:** switch to Production (unverified). Read the 0.2.3 error reason and fix the actual cause.
4. **Days 3-8: first-sync rework** (weakness 2), plus `invalid_grant` and scope checks. Gate: the owner's real Gmail fully synced, with evidence in PROGRESS.
5. **Days 4-8: take AI off the sync path,** add heuristic importance and a consent card (weakness 4).
6. **Week 2: dogfood daily.** Live-verify iCloud and Fastmail, which need no Google verification. Register the Entra app and test Outlook, or remove Outlook from the site.
7. **Week 2: HTML sandbox, CSP and fuses** (weakness 6).
8. **Week 3: daily-driver gaps** (weakness 7) and `reset` reconciliation (weakness 8).
9. **Week 3: formatter commit, typed IPC, Playwright-on-demo in CI, eval in CI.**
10. **Week 4: 10-20 external testers.** Start Google verification and CASA. Ship 0.3.x with a real update from one version to the next. Track day-7 retention by asking.

**Not in 30 days:** Windows, mobile, teams, MCP, meeting tools, server push.

**30-day success test:** a stranger downloads a signed build, connects a real Gmail or IMAP account, syncs a 10k-thread mailbox without errors, uses it for a week without losing a send or a draft, and receives an update in place.
