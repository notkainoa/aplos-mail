# Council answer: Aplos Mail vs Inbox Zero

## 1. Verdict in five sentences

Today, Aplos Mail is not a competitor to Inbox Zero; it is a two-week-old prototype with good bones that has never successfully read a single real email from any provider, while Inbox Zero is a three-year-old, 320k-line product with 12.8k stars, paying customers, and a feature surface (rules engine, follow-ups, calendar, notetaker, channels, MCP) that Aplos does not even have stubs for. Aplos's one and only live Gmail sync attempt failed with a 403, and the v0.2.3 "fix" is an untested hypothesis against a first-sync design (500 threads, `format=full`, all-or-nothing, per-worker retries with no shared pacing) that is structurally likely to keep failing on real mailboxes. Distribution is broken in a way the docs don't mention: the GitHub repo is private, so the website's Download button 404s and electron-updater's feed is unreachable for anyone but the owner, meaning there is currently no way for a second human being to install or update this app even if it worked. The honest comparison is not "Aplos vs Inbox Zero" but "Aplos vs its own first successful sync," because until one real account syncs, classifies, and survives a day of use, every other feature claim is demo-data fiction. Where Aplos has a genuinely defensible idea — local-first, BYO/local AI, no server ever touching mail, broader protocols than Gmail/Outlook — it is pointing at a real weakness in Inbox Zero's server-centric design, but a positioning advantage you cannot download is worth zero.

## 2. Feature comparison

| Capability | Inbox Zero | Aplos | Winner | Evidence |
|---|---|---|---|---|
| Works on a real mailbox today | Yes, daily, thousands of users | No; only live attempt 403'd | IZ, decisively | iz-arch §0; aplos-product §0, commit 99923ca |
| AI rules / automation | Deep: 17 action types, delayed actions, webhooks, learned patterns, test mode | None (deferred in SPEC) | IZ | iz-arch §5; aplos §6 |
| Reply tracking / follow-ups | Deep (To Reply/Awaiting, reminders, Slack) | Home "follow-ups" section, 3+ days, demo only | IZ | iz-arch §5; aplos §2 |
| AI drafting | Deep: voice matching, knowledge base, confidence gating, reply memories | Draft chips + Ask proposals, Groq-only, synthetic data | IZ | iz-arch §4–5; aplos §4 |
| AI summaries on arrival | Via rules/labels | Core differentiator (14-word summaries, importance), but coupled to sync and unproven | Aplos (design), unproven (execution) | aplos §2, §4 |
| Chat agent | ~25 tools, confirmation for sends, multi-channel (Slack/Teams/Telegram) | 9 tools, confirm-cards, strong containment design | IZ on breadth; Aplos's safety model is cleaner | iz-arch §4; aplos §4 |
| Bulk unsubscribe | Deep: List-Unsubscribe, one-click POST, sandboxed Playwright agent | Body-regex link scan only, no `List-Unsubscribe` header | IZ | iz-arch §5; aplos §2, §6 |
| Cold email blocking | Yes, LLM + prior-contact | No | IZ | iz-arch §5; aplos §6 |
| Providers | Gmail + Outlook only | Gmail, Outlook (no client ID, can't sign in), IMAP, JMAP, CalDAV — all unverified | IZ today; Aplos's coverage is the best structural idea | iz-product §3; aplos §3 |
| Calendar | Deep: booking links, availability, briefs | Built-in week/day/month UI, drag editing; no recurrence creation, no RSVP | IZ | iz-product §2.11; aplos §2 |
| Meeting briefs / notetaker | Yes (Recall.ai bot) | No | IZ | iz-product §2.12–13 |
| Snooze / send later | Snooze + scheduled send | Later-with-due-date substitute; no send later | IZ | iz-product §2.20; aplos §6 |
| Multi-device / mobile | Web, Mac, Windows, iPhone, old Android; server is the sync hub | macOS only; workflow-state-only sync via hidden mailbox message; no mobile | IZ | iz-product §3; aplos §2, §8 |
| Privacy | Mail content flows to their server + multiple LLM vendors; SOC 2 claimed not proven | Mail never leaves the Mac except to user's chosen AI; local models possible | Aplos (structural, real) | iz-product §5; aplos §4 |
| Distribution | Published, signed, working updater, homebrew, Docker | Signed/notarized drafts, but private repo → 404 download + dead updater | IZ | verified facts; aplos §5 |
| Offline / native feel | Client is v0.1.x, new; server-mediated sync | Local-first SQLite engine, works offline, native Mac polish | Aplos | iz-arch §1; aplos §1–2 |
| Team / enterprise | Orgs, shared rules, SSO/SCIM, Stripe | None, by design | IZ | iz-product §2.15 |
| Automation while asleep | Yes (server crons, push) | Impossible (no server) | IZ, fundamental | iz-arch §8; aplos §8 |

Maturity note: Aplos's "yes" column entries are mostly demo-or-mock maturity; Inbox Zero's are production with known bugs. Presence without maturity is not a tie.

## 3. Architecture: local-first desktop vs server SaaS

**Where the server design (Inbox Zero) is fundamentally advantaged.** Push (Gmail `users.watch`/Pub/Sub, Graph subscriptions) requires a public endpoint; a laptop behind NAT cannot have one. Everything Inbox Zero is famous for — rules firing on arrival, cold-email blocking, follow-up nudges, digests, scheduled send, meeting briefs at 7am — happens *while the user's laptop is asleep*, because the server holds the tokens and runs the crons. Multi-device is free: the server is the sync hub. Whole-mailbox features (analytics, bulk unsubscribe over years of mail, deep clean) are feasible because the server can grind history at its own pace. The cost is enormous and visible in the audit: 102 Prisma models, four queue backends, webhook-inline LLM work with no backpressure, encrypted-token custody, CASA burden, per-user hosting and LLM cost, and a blast radius where one breach exposes every user's mail pipeline. It also forces trust: content flows through their backend to "OpenRouter, OpenAI, Anthropic, Google, Bedrock, Groq" (subprocessors page), and "Zero Data Retention" has an abuse-monitoring asterisk.

**Where local-first (Aplos) is fundamentally advantaged.** Privacy is structural, not policy: no server to breach, no subprocessor list, no CASA transfer problem for the mail store itself (though sending content to Groq by default reopens the Limited Use question). Cost is the user's: BYO keys mean no per-seat LLM margin problem, which is why Inbox Zero must charge $18–50/user/mo and Aplos could charge once or nothing. Offline and latency are free. Provider breadth (IMAP/JMAP/CalDAV) is free too — the client talks to hosts directly, no per-provider server infrastructure. **Verification burden flips:** Inbox Zero observes and fixes failures centrally (Sentry, Axiom); Aplos has zero telemetry, so every field failure requires a new release to even see the error. That is literally what happened with the 403: v0.2.3 exists to *display Google's reason*.

**Where local-first is capped.** No push (Aplos doesn't even implement IMAP IDLE or JMAP push, which are server-free), no rules while asleep, no scheduled send (the Gmail API has no endpoint), no mobile story without each phone being its own full sync+AI client, and cross-device state is a clever but fragile hack (AES-sealed records in a hidden Gmail label, trashed-and-rewritten copies filling the user's Trash, last-writer-wins on device clocks). Inbox Zero's audit even shows the local-first path done more carefully than Aplos does it: their unused `local-mail-sync-budget.ts` is a quota-unit token bucket with one in-flight request per account — exactly the discipline Aplos's first sync lacks. Punchline: both products independently built an unbudgeted `format=full` fan-out first sync that trips Gmail's per-user limits; Inbox Zero has the better design written but not wired in, Aplos doesn't have it at all.

## 4. Aplos's 10 most serious weaknesses, ranked

1. **No provider has ever worked live.** One real Gmail attempt, one 403, fix untested. Everything below is secondary to "sync one real mailbox." *Fix:* one real Gmail account through first sync, incremental sync, send, and triage round-trips (TODO M11), then Outlook and one IMAP account. *Effort: days of debugging, gated on #2 and #4.*
2. **First sync is architecturally unsound** — 500 threads, `format=full` including spam/trash, concurrency 4 with no shared limiter, no batch endpoint, no `fields` mask, all-or-nothing with no checkpoint, siblings keep spending quota after a failure, restart from zero. The 403 was the predictable outcome, not bad luck. *Fix:* `format=metadata` + `fields` first pass, batch `messages.get`, shared token bucket (~150–200 units/s), commit per page with resume, AbortSignal on failure, lazy bodies. *Effort: 3–5 days; a design template exists in Inbox Zero's unused `local-mail-sync-budget.ts` (ideas only, §6).*
3. **Distribution is silently dead: private repo.** Download button and update feed 404 publicly; electron-updater's GitHub provider has no token. Notarization (which the architecture report got wrong — releases ARE notarized) is wasted while nobody can fetch the DMG. *Fix:* public repo, or releases mirrored to a public bucket with `releasesUrl` and the updater feed pointed there. *Effort: hours — the cheapest high-impact fix on the list.*
4. **Google OAuth verification is a launch blocker, not a formality.** Testing-mode app: 100 test users, 7-day refresh-token expiry (weekly forced reconnects), restricted scopes, and content sent to third-party LLMs complicates Limited Use. The code never checks granted scopes and mishandles `invalid_grant`, so consent/scope failures surface as mystery 403s — a plausible alternate cause of the observed failure. *Fix:* verify scopes on the token response, map `invalid_grant` to "reconnect", drop `gmail.settings.basic` if possible, start verification + CASA now. *Effort: 1–2 days of code + weeks of Google process.*
5. **No observability.** Five `console.*` calls, no log file, no crash reporter. Every field failure costs a release cycle to diagnose. *Fix:* rotating scrubbed log file, `crashReporter`, in-app "copy diagnostics". *Effort: 1–2 days.*
6. **Data model won't scale.** Whole mailbox in memory ×4 (engine, JSON cache, main, each window), `structuredClone` of everything per mutation, re-stringify compare on every commit, bodies never evicted, FTS delete on an UNINDEXED column; already failed at 10k threads / 1 GB. *Fix:* page threads from SQLite on demand, lazy bodies, eviction, rowid-mapped FTS delete. *Effort: 1–2 weeks; touches everything.*
7. **AI classification is on the sync critical path.** First sync fires up to 500 LLM calls at concurrency 3 inside the sync promise, blocking all accounts; on Groq free tier that's many minutes of 429s, and it ships hundreds of emails to a third party with no explicit consent. *Fix:* background enrichment lane with caps and checkpoints, first-run consent card, spend accounting. *Effort: 2–3 days.*
8. **Email HTML renders in the privileged renderer.** DOMPurify → serialize → mutate → `dangerouslySetInnerHTML` into the document holding `window.aplos`, with CSP `unsafe-inline`. One mXSS bypass = send mail / export mailbox as the user. *Fix:* sandboxed `<iframe srcdoc>`, strip `unsafe-inline`, remove dev origins from prod CSP. *Effort: 2–4 days.*
9. **Cursor resets silently ignored.** Adapters report `reset:true` on expired cursors; `merge.ts` never reads it, so host-side deletions leave ghost threads forever. *Fix:* honor `reset` with a bounded, paced reconciling resync. *Effort: 1–2 days.*
10. **Electron hardening gaps + unencrypted mail at rest.** No fuses (RunAsNode on = known keychain-bypass class), broad entitlements, `aplos.db` plaintext relying on FileVault. *Fix:* configure fuses, tighten entitlements; decide explicitly on at-rest encryption. *Effort: 1 day; +2–3 if encrypting the store.*

## 5. Where Aplos can genuinely win

**Real:** privacy as architecture (no server holds mail; local models via Ollama/LM Studio are a *feature*, not a self-host exile — Inbox Zero only offers local LLMs if you run their whole stack). Provider breadth: Inbox Zero has refused IMAP since Dec 2023 (issues #62, #925, "bait and switch" on HN); Aplos's IMAP/JMAP/CalDAV coverage targets exactly the Fastmail/iCloud/Proton-via-Bridge users Inbox Zero cannot serve. Price structure: BYO keys + no server means Aplos can be a $0–$49-once product against $18–50/user/month forever; for a privacy-sensitive individual with 3 accounts, Inbox Zero's gating (second inbox forces Plus) is genuinely annoying. Interaction model: the finishable Home, Space-as-primary-action, and confirm-only AI are a coherent differentiated take, and the AI containment design (ref-scoped citations, proposals-only tools, validated suggested actions) is arguably cleaner than Inbox Zero's, whose rule actions can auto-send/auto-forward with the approval flow *removed* (deprecated `PENDING`/`REJECTED` statuses in the schema).

**Weak or wishful:** "keyboard-first Mac polish" is not a moat — Inbox Zero's desktop client is 4 weeks old, shipping 10 releases in 4 weeks, with a founder who has 10k commits of velocity; any craft lead is measured in months. "Offline" is real but niche for mail, an inherently sync product. The cross-device workflow sync is clever engineering solving a problem the server model solves trivially; users will experience it as a quirk (Trash full of sync messages). And the website already overclaims ("Works with Gmail, Outlook, iCloud, Fastmail" — none verified, Outlook can't even sign in), which burns the credibility the privacy positioning earns.

## 6. What to adopt from Inbox Zero (patterns, never AGPL code)

1. **Quota-unit token bucket with one in-flight request per account** (`local-mail-sync-budget.ts` as a *design*): budget in Gmail units, not requests; interactive lane priority over backfill; slow refill after a throttle; durable per-account "rate-limited until" that only moves later, defaulting to 30–60 s when Google gives no time (their 1 s fallback is the documented mistake).
2. **Classify Gmail errors by `reason`, not HTTP code**; parse "Retry after <timestamp>" from the message; treat `dailyLimitExceeded` as stop-for-today; 403s are not all rate limits.
3. **historyId before backfill, checkpoint per page, replay from cursor.** Aplos reads the historyId first already, but must make commits granular for it to matter.
4. **Confirm-cards for outbound AI actions.** Aplos already has this; Inbox Zero's `{{template}}`-only arg filling (injected `to/cc/bcc` ignored) and spoofable-From blocking of auto-reply rules are guardrails worth copying as concepts.
5. **Test mode and History-with-Fix for any future rules feature** (run against past mail without acting; explain a wrong match, fold it into the rule), plus **learned sender/domain patterns** as a deterministic pre-LLM pass — cheap and cuts LLM spend.
6. **Emulator-based E2E tests.** Their Playwright suite runs against emulated Google/Microsoft/Stripe/LLM; Aplos's fake-server tests are the same idea one level down — promote them to packaged-app flows in CI.
7. **Structured-output discipline:** schema-validated outputs everywhere and version-stamped pipelines (`draftPipelineVersion`), so behavior changes can be attributed to prompt changes.
8. **Content sanitizer for LLM input** (strip hidden/zero-width content before sending bodies to a model) — Aplos sanitizes for *rendering* but should also sanitize for *prompting*.

## 7. Ranked 30-day plan

**Week 1 — make it installable and diagnosable.**
1. Fix distribution (hours): public repo or public release mirror; verify Download button and updater end-to-end from a clean Mac. Without this nothing else matters.
2. Land observability (1–2 days): log file, crash reporter, in-app diagnostics. Every subsequent fix depends on seeing failures.
3. Rework first sync (3–5 days): metadata-first + fields mask, batch endpoint, shared token bucket, per-page commit with resume, abort siblings on failure, honor `reset`. Gate: sync a real, large Gmail mailbox to completion.
4. Fix OAuth robustness (1 day): verify granted scopes, `invalid_grant` → reconnect state, surface Google's reason everywhere.

**Week 2 — prove it live.**
5. Complete TODO M11 for real: one Gmail account daily-driven by the owner for a full week (sync, triage round-trips, send with alias, notifications). Fix what breaks.
6. Register the Microsoft client ID (hours) or remove Outlook from the website. Run one IMAP (Fastmail) and one CalDAV account live.
7. Add the AI consent card on first sync; move classification off the sync path.
8. Submit Google OAuth verification, start the CASA clock, publish the privacy page (currently a flagged draft — that alone blocks launch).

**Week 3 — survive real mailboxes.**
9. SQLite paging + lazy bodies + eviction + FTS fix, so a 20k-thread mailbox doesn't 1 GB the renderer.
10. Sandbox email HTML in an iframe; tighten CSP; set Electron fuses and entitlements.
11. Live-provider smoke tests in CI (owner's test account, nightly): sync, send to self, archive.

**Week 4 — ship something keepable.**
12. Publish v0.3.0 publicly with honest website copy (drop unverified provider claims), a changelog, and a real exercised updater (0.3.0 → 0.3.1).
13. Implement `List-Unsubscribe` header + one-click POST (half day, high visible value).
14. Add hold-then-send-later (honest about needing an awake Mac) and saved searches — client table stakes absent today.
15. Recruit 5–10 external testers from the privacy/self-host community (the audience HN showed exists on Inbox Zero's own thread). Do not add rules, teams, or mobile this month; the wedge is "a fast private Mac client that actually works with your Gmail + Fastmail."

## 8. Disagreements with the reports

1. **Aplos architecture report §5 is factually wrong on signing:** "no release has been signed or notarized yet; auto-update is disabled for everyone." Verified directly on 2026-10-25: 0.2.0–0.2.3 are Developer-ID signed and notarized (spctl: "source=Notarized Developer ID", stapled), confirmed in CI logs. The updater is nonetheless *effectively* dead for the opposite reason: the repo is private, so the feed 404s. The report's §5 updater paragraph even contradicts itself (praises the signed-feed design, then says no release is signed). The conclusion (updater can't reach users) survives; the stated mechanism does not.
2. **The same report overstates its "Transferable lessons" framing:** it treats the 403 as certainly a rate-limit problem. The OAuth app is in Testing with restricted scopes, so `insufficientPermissions` from granular consent, the test-user cap, or unverified-app refusal are equally consistent with a 403 — and 0.2.3's premise (retry rate limits) is untested. The pacing fix is necessary regardless, but "we don't know which 403 this was" deserved higher billing.
3. **Inbox Zero product report's "two products" framing is generous to Inbox Zero.** The client launched Oct 18, 2026 at v0.1.x; calling it "a standalone email client" alongside the assistant overstates its maturity — desktop is one week old, the iPhone app is closed-source with no findable App Store listing, and Android is self-admitted "older version." On desktop-client maturity specifically, Aplos is not far behind Inbox Zero; it's behind on everything the server does.
4. **Inbox Zero product report under-weights the license.** It documents AGPL+additional-terms correctly, then still lists self-hosting among "their strongest trust moves." A license requiring an enterprise contract for any 5+ organization is a compliance trap for exactly the self-host audience (third-party reviewers already misread it as "MIT"). Aplos, with a clean license, has an easy honest win here.
5. **Inbox Zero architecture report's "local-first client" label is misleading.** Its SQLite engine syncs *through their server* (`/api/mail/v1`); tokens and sync mediation stay server-side. It is an offline-capable cache, not local-first in Aplos's sense — so the privacy gap is even sharper than the reports state: not even Inbox Zero's own desktop client keeps mail off their backend.
6. **Both Aplos reports grade maturity generously in one direction:** UX features get "demo only," but the provider table calls Gmail/Graph/IMAP/JMAP code "Complete." Code that has never run against the real service is not complete; the 403 proved that within hours.
