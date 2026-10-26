# Inbox Zero (getinboxzero.com) - product research for competitive comparison

Research date: 2026-10-25. Method: WebFetch on the marketing site, docs (Mintlify, via `.md` endpoints and `llms.txt`), GitHub API via `gh`, Product Hunt, Hacker News, third-party review sites, plus downloading the product images used on the site. Tag key: **[V]** verified directly from a primary source (vendor page, GitHub API, docs). **[C]** vendor claim I could not independently verify. **[U]** unverified or not found.

Caveat on method: WebFetch summarizes pages through a small model, so quotes marked as verbatim come from those summaries and should be spot-checked before external use. Raw GitHub data (stars, tags, license text, contributors) was pulled directly with `gh`/`curl`.

Screenshots I saved for reference: `/tmp/iz-compare/img/` (marketing illustrations plus two docs screenshots; see section 8).

---

## 1. Positioning and target user

**Product identity.** "Open-source AI email assistant for Gmail and Outlook" [V] (https://www.getinboxzero.com/llms.txt, https://github.com/elie222/inbox-zero). GitHub description: "The world's best AI personal assistant for email. Open source app to help you reach inbox zero fast."

**Two products under one brand (important for comparison).** [V]
1. The original **assistant layer**: runs in the background on your existing Gmail/Outlook account, labels, drafts, archives, tracks replies. This is what the brand was built on since Dec 2023.
2. **Inbox Zero Mail**, a standalone **email client** (web, Mac/Windows desktop, native iPhone), launched on Product Hunt on **Oct 18, 2026** as "Open-source Superhuman alternative" (https://www.producthunt.com/products/inbox-zero-2; founder tweet https://x.com/elie2222/status/2110756359679426815 per search snippet). The client is free; AI is a paid add-on (https://www.getinboxzero.com/email-client). So as of today the company is pivoting or expanding from "layer" to "client + layer". The homepage FAQ still says "assistant vs client: a client replaces your app, an assistant runs on top... Inbox Zero offers both" (https://www.getinboxzero.com/ai-email-assistant).

**Core promise.** Homepage framing from the main landing page: "The AI email assistant that works for you" - sorts mail, "writes replies that sound like you," removes subscriptions, tracks pending replies. Tagline-level claim: "The work happens before you show up, not after." "Get back an hour a day." [V as quoted by page] Positioned against **Fyxer** (assistant; README says "open source alternative to Fyxer, but more customizable and secure") and **Superhuman** (client), with comparison pages for Shortwave, Serif, Perplexity's email assistant (sitemap, https://www.getinboxzero.com/sitemap.xml).

**Target users.** Broad. Pricing page tiers: Starter = "individuals, entrepreneurs, executives"; Plus = "power users who need integrations"; Professional = "teams and high-volume businesses"; Enterprise = SSO/SCIM/on-prem (https://www.getinboxzero.com/pricing). The sitemap shows ~17 vertical landing pages (founders, small business, creators, real estate, customer support, e-commerce, MSPs, law firms, accounting firms, property management, insurance, recruiting, construction, travel advisors, executive assistants, operations managers). About page: "founders, operators, and professionals who get more email than they can reasonably handle by hand" (https://www.getinboxzero.com/about). This is SEO-driven breadth, not a sharp wedge.

**Comparison table on their own landing page** (self-reported, biased): marks Inbox Zero alone for "reminders when you forgot to reply," open source, self-hosting, full custom categories. Default categories listed on the landing page: Newsletter, To Reply, Marketing, Calendar, Notification, Cold Email, Team, Urgent.

**Trust-led positioning.** Open source + self-hostable + "SOC 2 compliant" is the pitch against closed competitors. Note the licensing caveat in section 4.

---

## 2. Feature inventory

Source for all docs-based items: https://docs.getinboxzero.com (index: https://docs.getinboxzero.com/llms.txt). "Early Access" flag = the docs nav lists the page under "Early Access (experimental, not on all accounts)".

### 2.1 AI assistant with plain-English rules (core) [V]
- Docs: https://docs.getinboxzero.com/essentials/email-ai-personal-assistant.md
- Open **Assistant** in sidebar, describe how mail should be handled in English; AI converts it into rules that you review and save. Or build manually ("Add rule manually").
- Rule = condition + one or more actions. Conditions: AI (semantic description), static (From/To/Subject text match), or both. "Apply to Threads" toggle (otherwise first message only). By default one rule per email; "multi-rule selection" is a setting.
- Actions (provider dependent): label, move to folder, archive, delete, draft reply, send reply, forward, send email, mark read, star, mark spam, add to digest, call webhook, create Todoist task, notify via Slack/Teams/Telegram, send draft to chat for review, notify sender.
- Draft templating: AI instructions inside `{{double braces}}`, fixed text outside.
- **Delayed actions**: 1 minute to 90 days after match (https://docs.getinboxzero.com/essentials/delayed-actions.md).
- **Call Webhook** action posts rule/message metadata to an HTTP endpoint (https://docs.getinboxzero.com/essentials/call-webhook.md).
- Tabs on the Assistant page (from an older docs screenshot): Prompt, Rules, Pending, History, Test, Groups. Rules table shows Name, Condition, Type (AI/Group), Actions, "Automated" toggle and "Threads" toggle. So there is an automate-vs-approve concept (Pending tab) in the UI; the current docs page does not describe it (the docs I fetched say nothing on "automate vs approve"; treat the screenshot as dated, see section 8).
- **Test tab**: run rules against a pasted email or past mail without executing actions; "Test All". **History** tab with a **Fix** action: explain a wrong match and the system updates the rule. **Learned patterns**: sender/domain associations that build up when mail repeatedly matches a rule; viewable/editable/deletable.
- Safety stance (https://docs.getinboxzero.com/essentials/security-and-data.md): enabled rules run automatically with no confirmation; docs advise testing and starting with reversible actions (label/archive/mark read).
- AI: yes, heavily (rule matching, draft text, rule authoring).

### 2.2 Reply tracking ("Reply Zero") [V]
- https://docs.getinboxzero.com/essentials/reply-zero.md (listed under Early Access in the docs nav, but the page itself says nothing about gating; the GitHub README and homepage market it as a core feature - an inconsistency).
- Labels `To Reply`, `Awaiting Reply`, `Follow-up` applied in Gmail (categories in Outlook). Enabled by turning on the To Reply / Awaiting Reply rules.
- Follow-up reminders: thresholds default 3 days ("they haven't replied" and "I haven't replied"), weekends excluded. "Find follow-ups" scans existing mail. Reminders can be delivered to Slack/Teams/Telegram with "Open in Gmail/Outlook" and "Mark done."
- Optional auto-generated nudge drafts to people you are waiting on.
- AI: classification of whether a reply is owed is done through the assistant rules (docs do not explain it further).

### 2.3 AI chat assistant [V]
- https://docs.getinboxzero.com/essentials/ai-chat.md
- Left sidebar "Chat." Find/summarize mail and threads, read attachments (PDF, DOCX, TXT, CSV, HTML), archive/delete/mark read/label/unsubscribe, bulk buttons over result lists, compose drafts/replies/forwards, create/edit/toggle/debug rules, look up calendar events, change assistant settings, "remember" preferences across chats. Image paste (JPEG/PNG/WebP/GIF) as context only. Chat history menu.
- Drafts are never sent automatically; shown on a confirmation card. Same chat available in Slack/Teams/Telegram and on mobile.
- AI: yes.

### 2.4 Draft replies in your voice [V]
- https://docs.getinboxzero.com/essentials/assistant-settings.md
- Auto-draft setting writes drafts into the Drafts folder; never auto-sends. **Draft confidence** (All emails / Standard / High confidence) gates whether it drafts. Writing style description, personal instructions, email signature, **draft knowledge base** (facts for recurring questions), optional referral signature, option to allow "hidden links."
- Drafts use past emails, calendar (for scheduling replies), connected business tools, and meetings recorded in the last 30 days (only if everyone on the thread attended).
- Per-account settings. Editing drafts feeds "learning" (docs claim).
- AI: yes. Quality caveat: reviews call voice-matching "average" (section 7).

### 2.5 Cold email blocker [V]
- https://docs.getinboxzero.com/essentials/cold-email-blocker.md
- AI classifies unsolicited sales/outreach using an editable prompt; applies to new incoming mail only (not backlog). Gmail default: `Cold Email` label + archive + notify sender. Outlook: move to `Cold Email` folder. Anyone who has emailed you before always passes. Tabs: Cold Emails (mark "Not cold email", batch), Marked Not Cold, Settings, Test. Cold-email reason shown (older changelog May 2024).
- AI: yes (optionally a separate "decision model" for self-host: `DECISION_MODEL_COLD_EMAIL_ENABLED`, https://docs.getinboxzero.com/hosting/llm-setup.md).

### 2.6 Bulk unsubscribe [V]
- https://docs.getinboxzero.com/essentials/bulk-email-unsubscriber.md
- Scans mailbox for newsletters, groups by sender with volume and **read rate**. Filters; multi-select; **"Select N suggested"** (rarely-read senders). Per-sender: **Unsubscribe** (only if a link exists; also archives existing mail), **Block** (no link: archive current and future), **Approve**; menu: label future emails, auto-archive, archive all, delete all.
- Page does not mention AI. Public API endpoint `POST /senders/unsubscribe` finds the `List-Unsubscribe` header (https://docs.getinboxzero.com/api-reference/endpoint/post-senders-unsubscribe.md).
- Complaint on Product Hunt: list shows senders you already unsubscribed from (section 7).

### 2.7 Bulk archive [V]
- https://docs.getinboxzero.com/essentials/bulk-archiver.md
- First run "Get Started" categorizes senders (minutes) into **Newsletter, Marketing, Receipt, Notification, Other** cards. Per-card "Archive all", expandable with checkboxes ("Archive 8 of 10"). Pencil icon to re-categorize. Action configurable: archive / mark read / delete (only delete asks to confirm).
- Docs never say AI does the categorization; it is plausibly LLM-driven (uses "smart categories" per README) [U on mechanism].

### 2.8 Deep Clean (Early Access, Gmail only) [V]
- https://docs.getinboxzero.com/essentials/deep-clean.md
- AI decides keep vs archive/mark-read for old threads. Options: time range, "keep in inbox" protections (needs reply, starred, upcoming events, receipts, custom instruction). Runs a **50-message preview** first. No deletion; undo from live results; History of jobs. Requires premium and Early Access toggle. Docs warn "AI classification can be wrong."

### 2.9 Analytics [V]
- https://docs.getinboxzero.com/essentials/email-analytics.md
- Email volume chart (Received/Sent/Read/Archived), top senders/recipients (by address or domain), response-time stats (median, average, within-1-hour, distribution, weekly trend), date presets/custom range, "Load more" to pull older history, "Assistant processed emails" chart per rule. Team analytics for org owners/admins with member consent (section 2.15). Not AI-generated insights.

### 2.10 Smart categories / split inbox [V]
- In the client: AI sorts incoming mail into tabs (To Reply, Newsletter, Calendar...); Tab key moves between splits; create a split by describing it in English (https://www.getinboxzero.com/email-client).
- On Gmail: **Inbox Zero Tabs** Chrome/Firefox extension (below). "Smart Categories" in README refers to sender categorization.

### 2.11 Calendar, booking links, scheduling replies [V]
- https://docs.getinboxzero.com/essentials/calendar-integration.md, https://docs.getinboxzero.com/essentials/booking-links.md
- Google Calendar and Outlook calendars, multiple at once, per-calendar availability inclusion, weekly availability hours, timezone. When an incoming email asks for time, assistant checks conflicts, limits to availability, and drafts a reply: shares booking link for generic requests or offers one specific slot (one unless sender asked for several). Native booking page (guests book/reschedule/cancel) or external link (Calendly, Google, Microsoft Bookings).

### 2.12 Meeting briefs [V]
- https://docs.getinboxzero.com/essentials/meeting-briefs.md
- For events with external guests (external = different domain from yours; public providers never count as internal). Default lead time 4 hours, max 48. Sources: attendee info, recent emails with guest, prior meetings (past 6 months), web research, teammates attending, logistics, plus connected integrations. Delivered by email by default; also Slack/Teams/Telegram. "Send test brief", send history. AI: yes.

### 2.13 Meeting recorder / AI notetaker (Early Access; Plus plan) [V]
- https://docs.getinboxzero.com/essentials/meeting-recorder.md
- Visible bot ("<Name>'s Inbox Zero Notetaker") joins Google Meet, Zoom, Teams based on calendar links. Join rules: all calls / external only / ones you organize / manual only. 48-hour "Up next" list. Output: transcript with speakers/timestamps, summary, action items, follow-up draft in Drafts, optional recap email. Docs do not name the recording/transcription vendor [U]. Consent warning included.

### 2.14 Digest emails [V]
- https://docs.getinboxzero.com/essentials/email-digest.md
- Plus plan. Daily or weekly summary of mail matched by chosen rules; email by default and/or Slack/Teams/Telegram. Does not archive unless the rule also archives. AI summarizes.

### 2.15 Organizations / team [V]
- https://docs.getinboxzero.com/essentials/organizations.md
- Roles owner/admin/member; shared rules pushed to members ("Managed by organization," members can toggle own copy); team analytics visible only for members who click "Allow Access"; invites max 10/batch, expire in 14 days; an email account can be in one org only; shared rules cannot use messaging-channel actions. Client also has **team comments** (@mentions; never sent as email). Open feature request (Oct 2026) to show when a teammate is drafting a reply (https://github.com/elie222/inbox-zero/issues/4204) - suggests no collision detection yet.

### 2.16 Channels: Slack, Microsoft Teams, Telegram [V]
- https://docs.getinboxzero.com/essentials/channels.md
- Per-rule "notify only" or "draft reply in chat"; feature updates (meeting briefs, follow-up reminders, newsletter digests [Plus], filing alerts, scheduled check-ins). Chat with the assistant via DM/@mention.
- Capability matrix: Slack = DM or private channel, editable drafts, send from chat, quick actions (archive/mark read). Teams = bot DM only, view-only, no draft editing or send (use Inbox Zero). Telegram = bot DM, prepared draft send, quick actions Slack-only "for now." Note a vendor comparison page still says Teams is "coming soon" (https://www.getinboxzero.com/best-superhuman-alternative) - stale marketing.

### 2.17 Auto-file attachments [V]
- https://docs.getinboxzero.com/essentials/auto-file-attachments.md
- Plus plan. Connect Google Drive or OneDrive, tick allowed folders, write one plain-English filing prompt, preview (files up to 3 real attachments). AI decides destination; if uncertain it emails you to ask; reply in thread to approve/move/undo. Can create subfolders. Drive access level "Standard" (new folders only) vs "Full access."

### 2.18 Context integrations (Early Access; Plus plan) [V]
- https://docs.getinboxzero.com/essentials/context-integrations.md
- Read-focused lookups to enrich drafts and briefs: Notion, Stripe, Linear, Attio, Intercom, Monday.com; Todoist (write-only via rule action); via Composio: HubSpot, Salesforce, Airtable, Google Sheets, Slack, Asana, ClickUp, Jira, Zendesk, QuickBooks, Calendly; via Pipedream: "hundreds" more. The homepage illustration shows Stripe/Notion/Slack feeding a draft.

### 2.19 Agent / developer surface [V]
- **MCP server** at `https://www.getinboxzero.com/mcp` (OAuth via Google/Microsoft; works with ChatGPT, Claude, Claude Code, Cursor): search, read threads, list rules/stats, create drafts, create/update/delete rules. **Cannot send email**; `mcp:send` scope is off and needs separate approval (https://docs.getinboxzero.com/essentials/mcp.md, llms.txt).
- **REST API + CLI** (`@inbox-zero/api`, keys prefixed `iz_sk_`; stats, rules, unsubscribe), **OpenClaw skill** page (https://www.getinboxzero.com/openclaw), `go.getinboxzero.com/skill.md`.

### 2.20 Other
- **Inbox Zero Tabs extension**: free Chrome/Chromium/Firefox add-on adding Superhuman-style tabs to Gmail (query-defined tabs, per-account, light/dark). Docs claim "100% private," runs locally. Chrome Web Store: 5.0 from 9 ratings, ~1,000 users, v1.2.6 updated Aug 27, 2026 (from a search result, https://chromewebstore.google.com/detail/inbox-zero-tabs-for-gmail/iencpoofingkkakccoknbleilcliokfk; I did not open the listing myself - treat as [C]). "Sync to browser extension" in assistant settings turns label rules into tabs. Gmail only.
- **Sensitive data protection**: Off / Redact / Block credentials and card numbers before sending content to the LLM (per assistant settings; self-host env `SENSITIVE_DATA_POLICY_DEFAULT`).
- **Free tools** (non-product SEO): Gmail quiz, subject-line analyzer, signature generator, deliverability checker, meeting/email cost calculators.
- **Client features** (https://www.getinboxzero.com/email-client): J/K/E/H/R/Z shortcuts, snooze (H), Cmd+K command palette available mid-compose, split inbox, unified multi-account Gmail+Outlook view, schedule send, team comments, Slack alerts.

---

## 3. Platforms, form factor, providers

| Surface | Status | Source |
|---|---|---|
| Web app | Yes (hosted or self-hosted); AGPL+terms | email-client page |
| Desktop (Electron) | macOS arm64/x64 `.dmg`, Windows x64/arm64 `.exe`; **no Linux**; current desktop **v0.1.21 (2026-10-21)** | https://www.getinboxzero.com/download; GitHub releases |
| iPhone | Native app, App Store, **closed source** (not yet) | download, enterprise pages. I could not find an official App Store listing or ratings; the only "Inbox Zero" iPhone app a search found was an unrelated developer's [U] |
| Android | Google Play, flagged "Older version. An update is coming" (README: "older React Native Android app") | download page |
| Browser extension | Tabs for Gmail only | docs |
| CLI / API / MCP | Yes | docs |
| Chat surfaces | Slack, Teams, Telegram | docs |

**Mail providers:** Gmail/Google Workspace and Outlook/Microsoft 365 only [V]. **No IMAP/SMTP**: long-standing requested (issue #62 from Dec 2023, #925 Nov 2025, 20 comments each; "disappointed to find it doesn't support IMAP/SMTP"). No iCloud, Fastmail, Proton, etc.
**Calendar:** Google Calendar and Outlook calendar [V]. **Drive:** Google Drive, OneDrive [V].
**Form factor verdict:** Both. The legacy assistant is a layer over Gmail/Outlook; "Inbox Zero Mail" is a real client that still sits on the provider mailbox ("there's nothing to migrate"; page says it "sits on top of your existing Gmail, Google Workspace, or Outlook accounts"). Outlook parity is weaker (labels become categories; Gmail-only features: Deep Clean, Tabs extension, tab sync; Outlook-related bugs in open issues such as #3580, #2195 AI chat fails to search Outlook inbox).

---

## 4. Pricing, limits, gating, self-hosting, license, enterprise

**Hosted pricing** (https://www.getinboxzero.com/pricing) [V]:

| Plan | Monthly billing | Annual billing | Notes |
|---|---|---|---|
| Email app (client) | Free | Free | Web, desktop, iPhone. AI features need paid plan |
| Starter | $20/user/mo | $18/user/mo ($216/yr) | Sorting/labelling, drafts in your voice, cold-email block, bulk unsubscribe/archive, analytics, meeting briefs. Third-party review says **one email account** only [C: pricing page does not state Starter's account cap] |
| Plus | $35 | $28 ($336/yr) | 2 accounts per user, AI notetaker, Slack and app integrations, digests, auto-file attachments, "unlimited knowledge base" |
| Professional | $50 | $42 ($504/yr) | Adds team-wide analytics, priority support, dedicated onboarding manager |
| Enterprise | Custom | Custom | SSO, SCIM, on-prem, dedicated account manager |

- 7-day free trial, cancel anytime [V]. A third-party reviewer reports a 14-day refund window (slicey.ai) [C].
- Per-user pricing, no usage-credit model stated on the page (Fyxer uses credits; Inbox Zero's page lists none). Whether there are hidden AI usage caps per plan: [U].
- Price messaging inconsistency: "from $20/mo" (monthly) vs "$18" (annual) used interchangeably; a blog post from the founder (2023) said Pro was $10-19/mo, so prices roughly doubled since early days.
- Early Access features (Deep Clean, Context Integrations, Meeting Recorder) are explicitly premium/Plus plus a toggle.
- Gating friction: second inbox forces Plus (+56% from $18 to $28 on annual, per slicey.ai).

**Self-hosting** [V]: Docker + Node 24; `npx @inbox-zero/cli setup` then `start`; deployment guides for Docker/VPS, Vercel (Neon + Upstash), Kubernetes (Helm), AWS (EC2, Terraform, Copilot), GCP + Cloudflare Tunnel (https://docs.getinboxzero.com/hosting/quick-start.md). You must create your own Google OAuth (Gmail API + Pub/Sub) or Azure app registration and bring an LLM key. Realistic effort is larger than the "under 5 minutes" claim; OAuth in Google/Azure consoles and Google verification for production use would be the hard part. Open issues show self-host rough edges: Gmail connection dropping every ~7 days (#3983), rate-limit congestion at 3-5 emails/hour (#1880), slow page loads (#2227), digest action missing in self-host (#2724), OAuth redirects to container origin (#3326).

**License - this matters and third-party sources get it wrong.** [V, read directly from https://raw.githubusercontent.com/elie222/inbox-zero/main/LICENSE] It is **AGPL-3.0 plus "Additional Terms for Inbox Zero"**:
1. You may not use the program for commercial purposes "that involve monetizing the software itself" (selling access, paid service) without written permission from Inbox Zero Inc.
2. "If you are an organization with five (5) or more employees, contractors, or users who will use this Program for business purposes, you must obtain an enterprise license."
3. Exempt: personal, educational, research use, or fewer than 5 business users.
GitHub's API reports the license as `NOASSERTION`. The repo also has a CLA.md. One review (aiemaily.com) and the Inbox Zero "email client" page ("AGPL") oversimplify; aiemaily's claim of "MIT-licensed" is **wrong**. So "open source" is more precisely source-available/AGPL with a commercial-use cap; self-hosting for a company of 5+ people requires paying for an enterprise license. Docs page on SSO says nothing about this requirement.

**Enterprise / compliance claims:**
- "SOC 2 Type 2" [C+]: Trust center at security.getinboxzero.com is "Powered by Comp AI," status "Compliant," 37 controls, 23 policies, 14 subprocessors; **auditor not named, no documents posted publicly (0 documents; "Request Access")**. Marketing says "SOC 2 compliant/certification." A third-party reviewer (slicey.ai) could not verify it. I treat it as claimed, report available on request.
- "Google-verified... CASA Tier 2 accredited" [C]: stated only on the enterprise page (https://www.getinboxzero.com/enterprise); not on the trust center or privacy policy.
- SSO (SAML: Okta, Entra ID, Google Workspace) and SCIM (Users only; roles not auto-assigned) work on hosted (contact sales) and self-host (`/admin`) [V] (https://docs.getinboxzero.com/hosting/sso.md). The enterprise page itself does not mention SCIM.
- No HIPAA/ISO/data-residency claims found; blog posts exist on HIPAA/SOX/GDPR topics but these are SEO content.

---

## 5. AI: models, providers, BYOK, privacy

**Hosted default models:** not stated in docs [U]. Subprocessor list (https://www.getinboxzero.com/subprocessors, updated Sep 22, 2026) names OpenRouter, OpenAI, Anthropic, Google Vertex/Gemini, AWS Bedrock, Groq, TypeSafe AI as AI vendors, "used directly or through OpenRouter." Historically (changelog Aug 2024) Claude 3.5 Sonnet became the default.

**BYOK** [V]: https://docs.getinboxzero.com/essentials/api-keys.md - per email account in Settings > AI Model; providers Anthropic, OpenAI, Azure OpenAI, Google (Gemini), Groq, Cerebras, OpenRouter, Vercel AI Gateway; user types model ID. Docs do **not** say which plan allows BYOK [U]. Self-host supports many more (https://docs.getinboxzero.com/hosting/llm-setup.md): openai, anthropic, azure, azure-foundry, google, vertex, openrouter, groq, cerebras, aigateway, bedrock, **ollama**, **openai-compatible** (LM Studio, vLLM, LiteLLM), plus experimental `codex-cli` and `claude-code` for self-host. Tiered models via env: `DEFAULT_LLMS`, `ECONOMY_LLMS`, `CHAT_LLMS`, `DRAFT_LLMS`, `NANO_LLMS`, each an ordered fallback list. So local-LLM is possible only when self-hosting; open issues show openai-compatible local models have friction (#3502 token limits/structured output, #2892 tool-schema errors).

**Privacy claims** (privacy policy, updated May 4, 2026, https://www.getinboxzero.com/privacy) [V]:
- Subject lines, body text, sender/recipient info and labels may be sent to third-party AI models. AI vendors not named in the policy (named on subprocessors page).
- "We do not allow those providers to train their AI models using your data." Section is headed "Zero Data Retention" but providers may keep data "as required for abuse and misuse monitoring" (so not strict ZDR).
- Does not store full email bodies permanently; stores sender addresses, "summaries and analysis of your email history," and rule metadata. Retention periods: none specified ("as long as necessary").
- Claims compliance with Google API Services User Data Policy Limited Use.
- Data deletion: policy says email elie@getinboxzero.com; docs FAQ says there is a self-serve "Delete Account" in Settings (inconsistent).
- Anonymized/aggregated data may be shared and used indefinitely.
- Docs (https://docs.getinboxzero.com/essentials/security-and-data.md): no claims on encryption at rest/in transit, no training statement on that page.
- Tabs extension: "100% private, no data collection."
- Gmail permissions requested include read, organize, draft, send (getting-started docs).

---

## 6. Traction signals

From GitHub API (direct, 2026-10-25) [V]:
- **Stars 12,806; forks 1,632; open issues+PRs 142** (repo created 2023-07-12; last push today). Trendshift lists "Custom license" and 64 contributors (older snapshot).
- **Contributors: ~82** (API pagination). But heavily founder-driven: `elie222` has **10,276** commits; next are jshwrnr 461, edulelis 356, gentlemandev 144; `cursor[bot]` 75. About 11.7k commits on main. Recent commits show co-authorship by an AI model ("Co-authored-by: Claude Opus 5.5") - the repo is clearly built with agentic tooling (repo contains `.claude`, `.cursor`, `.codex`, `AGENTS.md`, `CLAUDE.md`).
- **Release cadence:** web app tags are sparse: v2.30.0 (2026-05-18), v2.29.3 (04-24), 2.29.2 (04-01), 2.29.1 (03-08), 2.29.0 (02-09), 2.27.0 (01-14) - roughly monthly-to-bimonthly tags, but `main` is committed to daily (e.g. 4 commits on Oct 23 alone) and Docker `latest` tracks main. **Desktop:** v0.1.12 (Sep 24) to v0.1.21 (Oct 21): 10 releases in 4 weeks, bursts of 4 in one day on Sep 25. Mature-looking web, brand-new desktop client.
- Product Hunt: 3 launches - Dec 26 2023 (#1 of day, 801/198 reported), Oct 1 2024 (#5), **Oct 18 2026 (#1 of day, 379 upvotes)**; 4.8 rating from 14 reviews, ~1.9K followers (https://www.producthunt.com/products/inbox-zero-2).
- Show HN Dec 29 2023: 167 points, 143 comments (https://news.ycombinator.com/item?id=38809770).
- **Users:** "25,000+ professionals" / "25k+ sign-ups including Enterprise customers" (founder on PH) - sign-ups, not active users or paying. [C]. Logos shown (Diary of a CEO, Netflix, Compass, Alta, ByteDance, Wix, JOCO, Keller Williams) with the wording "Join 25,000+ professionals, including people at:" - i.e. individuals at those companies, not enterprise deployments. Case studies page linked but not found. slicey.ai could not verify the user count or accolades.
- **Funding / team size / revenue:** none public. About page names no team or investors. Founder: Elie Steinbock (Tel Aviv/Jerusalem; entity "Inbox Zero Inc.", Newark DE per Chrome Web Store listing). A reviewer notes "bus factor"; effectively a very small team around one founder [C].
- **Testimonials on homepage:** ~12 named quotes (Joel Neuenhaus/Outbound Legal, Steven Tey/Dub, Jonni Lundy/Resend, Yoni Belson, Slim Labassi, etc.), many repeated. HN commenters in 2023 alleged some did not correspond to real tweets; founder replied "Every testimonial is real. Not every testimonial is from Twitter." Treat as marketing.
- G2 seller page exists (could not load, 403). Chrome extension: 5.0 / 9 ratings / ~1,000 users.
- Marketing/SEO engine: ~200 blog posts (8 pages), mass-produced "How to stop X emails" pages for 20 brands, vertical landing pages. Blog is all by the founder byline.
- Stale artifact: public Featurebase changelog (https://inboxzero.featurebase.app/changelog) last entry I could see is **Aug 28, 2024** (10 entries shown; "Load more" not reachable). So there is no maintained marketing changelog; GitHub commits/releases are the real changelog.

---

## 7. Weaknesses and complaints

Honest summary: independent complaint data is thin. **I found no Reddit threads** (searches returned none; Trendshift says it aggregates Reddit/HN mentions but I could not load it). Independent reviews on G2/Trustpilot were inaccessible (403/blocked). What exists:

**Hacker News Show HN (Dec 2023)** (https://news.ycombinator.com/item?id=38809770):
- Gmail-only: figassis "This is bait and switch for my time"; felixg3 "This is not an email assistant. It is a Google Mail, or Gmail, assistant." Outlook later added; IMAP still missing (GitHub #62, #925).
- Privacy: Virgil2604 "Handing my whole personal inbox over to OpenAI seems insane"; smy20011 "I don't want my email sent to any third party for analysis"; kazinator "Open source not running locally is closed source, for all intents and purposes"; gardenhedge "How do customers know that the source code on Github is the actual source code used for the product?" Founder: "Trust. There's no way to fully know."
- Testimonial authenticity (aragonite, Cyphase, hnarn) as above.
- Name confusion with the "inbox zero" method (madeofpalk re Merlin Mann).
(Dated 2023; product and privacy docs have since improved - SOC 2 claim, subprocessor list, self-host.)

**Product Hunt reviews** (https://www.producthunt.com/products/inbox-zero-2): Lena Cohen: "when I check the subscriptions, it shows me some I've already unsubscribed from" and uncertainty about Hebrew/non-English email. Positive: "My 20yr old inbox is finally clean with just a few clicks!" (David Kanzen). The three visible reviews are from the 2023 launch. No 2026 reviews of the new client visible.

**Third-party reviews (mostly competitor-authored, treat as biased):**
- aiemaily.com (a competing AI email client) https://aiemaily.com/blog/inbox-zero-app-review-2026: "not a full client" (outdated given the new client), "average drafting... thinner for teams that need per-contact tone," Outlook second to Gmail, "Auto-reply and auto-forward rules can misfire, and there's no formal approval step," self-hosting "free by license, not by month," bus-factor risk. Also wrongly states MIT license.
- usecarly.com (competitor) calls it "primarily an inbox-cleanup tool" that does not act on the content inside messages (via search snippet; I did not open it).
- slicey.ai https://slicey.ai/tools/inbox-zero: second account costs 56% more (Starter one account); unverifiable "20,000+ professionals," SOC 2, accolades; draft quality varies with calendar/email access.

**GitHub issues (live evidence of reliability and rough edges):**
- Gmail disconnects every few days on self-host (#3983, Oct 2026); Google calendar auth revocation handling fixed just today (commit "Mark Google calendars disconnected when the grant is revoked", #4311) - connection-state bugs are an ongoing theme.
- Rate-limit/congestion at low volume (#1880); FAQ itself blames other connected apps for "You have exceeded the rate limit."
- AI chat/tool-schema failures on provider swaps: "Prompt to rules fails with Anthropic: tool schema has 87 optional params" (#2323), OpenAI `saveMemory` invalid JSON schema (#2231), strict openai-compatible endpoints (#2892), updateRule can clear AI instructions (#2797). Indicates AI plumbing is complex and sometimes brittle across models.
- Chat assistant card "spins forever" (#4129), Outlook History "Email unavailable" due to unthrottled Graph calls (#3580), AI chat fails to search Outlook (#2195).
- Safety request: "review before delete" mode so trash/spam go to a label instead (#4126) - implies destructive actions currently go straight to Trash/Spam.
- Bulk process large backfills client-driven and can't complete on self-host (#3441).
- No explicit GitHub issues found for hallucinated drafts, but docs repeatedly admit AI "may be wrong" and "rules can match unintended messages."

**Other weakness signals I derived myself (not user quotes):**
- Pricing: only ~$18-20 entry but per-user, second inbox needs Plus, notetaker/integrations/digest/auto-file all Plus; Starter has no integrations. Early-access features gated by plan + toggle.
- Docs/marketing inconsistency: Reply Zero listed as Early Access in docs nav yet core on homepage; Teams "coming soon" vs documented; "SOC 2 compliant" vs no public report; privacy policy "Zero Data Retention" heading vs abuse-monitoring exception; deletion via email vs in-app button.
- "Open source" with enterprise license for 5+ users (AGPL + additional terms).
- Android app old; iPhone closed source; no Linux desktop; no IMAP.
- Client is brand new (desktop v0.1.x). Superhuman's page-concession by Inbox Zero itself: raw client speed "remains its strongest suit" for Superhuman (https://www.getinboxzero.com/best-superhuman-alternative).
- Privacy: content (subjects, bodies, labels) goes to multiple third-party LLM vendors on the hosted plan; the docs list no per-feature data-flow table.

---

## 8. UX: what it actually looks like

**What I could see.** The homepage and product pages use marketing illustrations rather than raw app captures. I downloaded the key images to `/tmp/iz-compare/img/`:
- `thumb.png` (client video thumbnail): a **Gmail-like web client** with left sidebar (Inbox, Starred, Snoozed, Sent, Drafts, More, Labels: To Reply, Awaiting Reply, Newsletter, Recruitment, Team), pill-shaped colored **AI category chips inline in the row** (Team, Digest, Newsletter, To Reply, Awaiting Reply, Recruitment), a floating compose card "New Message" with an "AI drafting response..." chip and calendar slots ("Finding slots via calendar integration..."). This is stylized and Gmail-lookalike, not a screenshot.
- `an-organized-inbox.png`: before/after illustration: chaotic stack becomes three stacks labeled To Reply / Newsletter / Recruitment.
- `pre-written-drafts.png`: compose card with Google Calendar, Gmail, Outlook icons on the left and Slack, Stripe, Notion on the right feeding a draft. Illustrative.
- Docs screenshots (older, real UI): `ai-rules.png` shows the legacy web app: dark-black left sidebar (AI Personal Assistant, Cold Email Blocker, Bulk Unsubscribe, Analytics, Early Access, User Guide, Join Discord, Feature Requests, Star on GitHub, Premium, Settings), a light content area with a **rules table** (Name, Condition, Type, Actions chips, Automated toggle, Threads toggle). `test-rules.png`: a "Test Rules" modal returning "Rule found!" / "No rule found! ... AI reason: ...". These are likely 2024-era captures (the docs say "Inbox Zero Demo" account; screenshots use an AI sparkle glyph on buttons). They do not show the new client.
- I could not run the app (requires sign-in/OAuth) and did not find a public sandbox/demo. I could not view the product demo video itself (hosted via Mux per docs; not fetched). **Actual look-and-feel of the new Inbox Zero Mail client is unverified.** Recent commit messages ("Calm the list chrome", "Quiet the split tab rule", "Show the compose key in the button", "keep the mac sidebar toggle in place") suggest active visual polish in the desktop client as of Oct 23, 2026 (GitHub commits).

**Interaction model (from docs/pages):**
- Legacy web app: a settings-heavy console. Sidebar sections: Assistant, Chat, Cleanup (Bulk Unsubscribe, Bulk Archive, Deep Clean), Cold Email Blocker, Analytics, Calendars, Meeting Briefs, Channels, Integrations, Attachments, Settings. Most "work" happens in Gmail/Outlook itself; Inbox Zero manages labels and drafts there, and you read the results in your native client (labels like To Reply appear in Gmail). The docs say: "Everything runs in the background, so you keep using Gmail or Outlook as usual."
- New client: keyboard-first, split inbox, Cmd+K, unified accounts, team comments (similar to Superhuman).
- Primary UX paradigms: (1) write rules in English and review a rules table, (2) per-sender bulk lists with checkboxes and suggested selections, (3) AI drafts waiting in the Drafts folder or in a thread, (4) chat sidebar/page, (5) push to Slack with interactive cards.
- Not a layer *only* anymore: it is a layer for the original users and a standalone client for new ones; both share the same account and rule engine.

---

## Key comparison takeaways (for Aplos Mail)

1. Breadth leader in automation: rules engine with delayed actions/webhooks, reply tracking, cold-email, bulk unsubscribe/archive, meeting briefs, notetaker, attachment filing, channels, MCP/API. Lots of surface area but depth is uneven and several items are Early Access.
2. Weak points to press: Gmail/Outlook only (no IMAP), closed iPhone app, old Android, desktop client very new (v0.1.x), per-user pricing with account/feature gating, privacy requires trusting multiple LLM vendors on hosted, "open source" has a 5+ user commercial restriction, SOC 2 report not public.
3. Their strongest trust moves: self-hosting, BYOK with 8 providers, sensitive-data redaction, "never auto-sends" drafts, MCP without send.
4. UX is unverified for the new client; docs screenshots show a utilitarian, table-heavy console and AI sparkle-style icons.

## Primary sources
- https://www.getinboxzero.com/ , /pricing, /email-client, /download, /enterprise, /about, /privacy, /subprocessors, /ai-email-assistant, /openclaw, /best-superhuman-alternative, /llms.txt, /sitemap.xml
- https://docs.getinboxzero.com/llms.txt and the `essentials/*`, `hosting/*` pages cited inline
- https://security.getinboxzero.com
- https://github.com/elie222/inbox-zero (LICENSE, releases, issues via `gh`)
- https://www.producthunt.com/products/inbox-zero-2
- https://news.ycombinator.com/item?id=38809770
- https://inboxzero.featurebase.app/changelog
- https://slicey.ai/tools/inbox-zero, https://aiemaily.com/blog/inbox-zero-app-review-2026
