# Aplos Mail: product inventory for competitive comparison

Prepared 2026-10-25 from `/Users/knewton/.t3/projects/aplos-mail` (branch `main`, HEAD `72095ff Release v0.2.3`). Read-only: nothing was edited, committed or run, and no `.env` or key was opened. Sources: SPEC, TODO, PROGRESS, DECISIONS, README, RELEASING, VISION, API and MOBILE (all `.md` at the repo root), then `apps/desktop/src` (engine, main, renderer, shared) and `apps/web/src`. I also queried GitHub with `gh` (release list, secret names only, one CI log) and fetched aplos.email headers.

## 0. Maturity labels and two framing caveats

- **Verified live**: PROGRESS/TODO show evidence against a real external service. In practice this means Groq (synthetic content) and CI notarization.
- **Mocks/demo only**: unit tests, fake servers, the protocol emulator, or the built-in demo mailbox.
- **Partial**: implemented, but with a gap I found in code.
- **Spec only**: written down, not built.

1. **No live mail provider has ever been verified.** TODO.md M11 is unchecked. The only real-Gmail event on record is a failure: the commit message of `99923ca` (v0.2.3) says the first live Gmail sync failed with "Google denied this operation. Enable Gmail and Calendar APIs…" although both APIs were enabled and every permission was granted. The fix assumes per-user rate limits, which Gmail returns as 403, and adds up to five retries with backoff plus Google's own reason in the message (`src/main/google.ts`, `fetchJson`). That is a hypothesis, unconfirmed on a real mailbox.
2. **The prose docs lag the releases.** PROGRESS.md and DECISIONS.md stop at 2026-10-24. They have no entry for v0.2.1 to v0.2.3 and no record of the 403. README.md still says "It has no automatic distribution/update server or Developer ID notarization", which CI contradicts. TODO.md still lists two unchecked release items (Google connecting from a downloaded build, and a signed build verified on a second Mac). Treat code, `gh` output and commit messages as more current.

## 1. Positioning

**Promise.** SPEC.md ("Product direction", 2026-10-20): "the owner's own daily mail and calendar app: a simple, fast, keyboard-first client that unifies every email account across providers (Gmail, Outlook, iCloud/IMAP, Fastmail…) and every calendar (a built-in, Notion Calendar-style view…), with Groq-powered AI throughout".

**Website** (`apps/web/src/Landing.tsx`, live at https://aplos.email, HTTP 200): headline "Finish your inbox, one email at a time." and a keyboard-first Mac app for email and calendar where "every message arrives with a short summary of what it says and what it needs from you." Sections cover Home, one week of every calendar, Ask ("It never sends anything on its own"), keys, and bring-your-own AI. It closes with "Works with Gmail, Outlook, iCloud, Fastmail and any IMAP account. No Aplos server ever sees your mail" and "Windows and Linux later". The privacy page is flagged as a draft with placeholders for Google Limited Use wording and a contact address.

**Target user.** One Mac user, in practice the owner, who wants Avec-style triage (my comparison, not the repo's), a unified calendar and bring-your-own AI without a vendor cloud. SPEC.md says the app began as "an independent take on Avec's interaction model", built after reverse-engineering analysis of the installed Avec app. Avec stays the reference for feel, and Aplos's own choices now take precedence. There is no team, enterprise or shared-inbox positioning. The architecture is serverless by design: the mail host is the sync server (DECISIONS.md, "Multi-provider, serverless architecture").

## 2. Feature inventory

Scale: about 17k lines of dense TypeScript in `apps/desktop/src`; CI on the v0.2.3 tag ran 228 tests, all passing. Provider code is covered by fake servers and an emulator, never a live account.

### Home, triage, Later, Done

| Feature | Evidence | Maturity |
|---|---|---|
| Home focus list | One focused email expands into a card (sender, due chip, large AI summary). Other mail is one-line "Sender: summary" rows that fade with distance. `renderer/components/MailList.tsx`, `styles/focus.css`. | Demo only. Never run on a real mailbox. |
| Home sections | New (important), a low-importance bundle line, "Waiting on you" (Done mail that needs a reply), follow-ups for sent mail unanswered 3+ days. `shared/mailbox.ts`: `isHomeNew`, `isHomeLow`, `isReplyDue`, `isFollowUp`. | Demo only. |
| Importance sorting | Comes from the AI summary pass. With no AI key, `classifyIncoming` returns early and nothing is classified, so Home would show the whole inbox. | Partial. |
| Done, Later, Bookmark | Keys: Done → or E, Later ← or L, Bookmark B, Z undo, `#` trash, U read/unread. Direction is configurable. Drag or swipe (mouse, touch, two-finger trackpad) with spring-back and flick (`ui/useSwipe.ts`). | Demo only; packaged-app check on demo data. |
| Host mapping | Done and Later map to archive, keep read, or keep unread (defaults: Done = archive, Later = mark read). Done and Later are Aplos workflow state that survives sync (`engine/merge.ts`). | Mocks only. |
| Durable offline queue | Triage is local-first and reaches the host through a persisted queue with retry and backoff; sync never reverts a pending change. | Fake Gmail only. |
| Exact-duplicate cleanup | Archives older identical copies of a thread in the same account (`engine/duplicates.ts`). Unusual. | Emulator only. |
| Block sender | Local list plus move to Spam (`sender.block` in `engine/service.ts`). Not a provider-side filter. | Partial. |

**Later.** Todos and Bookmarks tabs, grouped Overdue, Today, Upcoming and No due date, with editable due dates and reminders. When a reminder fires, `checkReminders` returns the thread to Home and the host inbox. This is the nearest thing to snooze; there is no "snooze until" verb. **Done** is not its own view: Done mail lives in All mail, and Done mail that needs a reply returns to Home. Maturity: demo only.

### Reading

- **Reader.** One email at a time. Split view was removed on 2026-10-21.
- **Rendering.** DOMPurify-sanitized HTML (`renderer/mailBody.ts`), remote images off by default, CID images loaded on demand, quoted-history collapse, attachment preview, ⌘F find with counts, sender and date popovers.
- **Summary card.** It sits above the subject and summarizes on open when the summary is only the provider snippet. It shows failure reasons with Retry.
- **Suggested action (Space).** One AI-proposed next step, validated to presets only: link, attachment, reply, calendar or read. A link must literally appear in the thread (`engine/writer.ts`, `suggestedAction`).
- **Maturity.** Synthetic fixture and Gmail MIME mock only; no real-world HTML mail rendered.
- **Unsubscribe is link-only.** It regex-scans the HTML body for a link whose text says "unsubscribe" or "manage preferences" and asks before opening it in the browser. It never reads the `List-Unsubscribe` header (no hit in `src`) and does no one-click POST. Partial.

### Compose

- **Editor.** Rich text with bold, italic, underline, strikethrough, lists, quote, links and inline images. Recipient chips with suggestions from existing correspondents, invalid-address chips that block sending, Cc and Bcc, attachments by paste, drop or picker (20 MB per file, 25 MB total).
- **Flow.** Pre-send checks (no subject, missing attachment), undo-send delay of 0 to 30 s (default 8 s), autosave, pop-out windows, reply, reply all, forward.
- **Safe send.** Each draft gets a stable Message-ID. A send of unknown outcome is checked against Sent and never auto-retried. "Send anyway" is an explicit choice after a warning.
- **Identity.** Gmail send-as aliases and per-alias signatures; a plain-text signature elsewhere.
- **Maturity.** Mocks only against Gmail, Graph, IMAP and JMAP. Popout and immediate-close persistence is verified in the packaged app.
- **Drafts are local only.** `main/google.ts` has no drafts endpoint, so drafts never appear in Gmail or on another device. Partial.

### AI Ask

- **Agent.** Streamed and tool-using (`engine/agent.ts`, `engine/ask.ts`), default 6 steps with 6 calls per step. Tools: `search_mail`, `read_thread`, `list_events`, `find_contact`, `current_context`, `propose_draft`, `propose_event`, `propose_triage`.
- **Read versus propose.** Read tools run automatically. Drafts, events and Done/Later/Bookmark triage arrive only as cards the user confirms.
- **Output.** Numbered citation chips, step lines, persisted chats, cancel.
- **UI.** A docked right panel. The owner moved it back from the centered overlay on 2026-10-20. A or ⌘J opens it, and holding A talks to it. The dock also has an "Ask | Today" switch (⇧A).
- **Search scope.** `search_mail` runs over the local FTS5 index. The `search` method also merges provider server search.
- **Maturity.** Verified live on Groq with synthetic or demo data: `npm run eval:groq` 16/16 across two runs, and `npm run eval:ask` 5/5 on demo data for three Groq models (PROGRESS, "Ask agent"). Never run on a real mailbox, and the free-tier daily quota was hit during testing.
- **Other providers.** Fake transports only ("live checks wait for the owner's keys"); Ollama and LM Studio against a stand-in server.

### Summaries and classification

- **Output.** One phrase of about 14 words, plus importance, reply status, todo, due date and suggested action.
- **Automatic runs.** `classifyIncoming` (`engine/service.ts`) summarizes every newly synced thread, Spam included, at a concurrency of 3.
- **First-sync cost.** The first Gmail sync pulls up to 500 threads (`INITIAL_THREADS`), so up to 500 AI calls go to the chosen provider. The `await classifyIncoming` is inside the sync path, so a free-tier rate limit could slow or stall the first sync. This is my reading of the code, not a run. I flag it as a risk, not a confirmed bug.
- **Other.** Failures are surfaced with a retry. Owner edits made while the model runs win.
- **Maturity.** Live on Groq with synthetic text only.

### Drafts and polish

Polish in the composer, optional auto-polish of dictation, drafts proposed by Ask, and an AI draft chip on suggested replies. Chips never change recipients or subject, and oversized input fails instead of truncating. Live on Groq with synthetic data; other providers only through fake transports.

### Plans (AI to calendar)

- **Extraction.** `extractEvents` validates ISO times, real days and end after start. A live Groq run went from 10 of 12 to 15 of 15 correct after a weekday-table fix.
- **Review.** A found plan shows as a dashed outline in the dock's Today view with a confirm card (clash detection, Add, Not now, Edit). Nothing is saved without a click.
- **Auto-add.** An opt-in setting, off by default.
- **Maturity.** Extraction is live on Groq with synthetic mail. Saving to Google, Outlook or CalDAV is mocks only.

### Voice

Hold A in the app, hold Space in the composer (dictation), or use the Ask chip; recordings are capped at 2 minutes (`renderer/useVoice.ts`). Transcription uses Groq `whisper-large-v3-turbo` by default or OpenAI transcribe models, the only two speech-to-text providers here. Transcription of locally generated synthetic speech is verified live on Groq. Real microphone capture and the macOS permission prompt are not (fake microphone in tests; TODO M11).

### Calendar

- **Views.** Unified week (default), day and month, with a 24-hour grid, now line and mini month. A rail lists calendars by account with colours, show/hide, "Only" and ⌥-click. The sidebar account selector filters it.
- **Editing.** Drag to create, move and resize at 15-minute snaps, with an Undo toast. Quick popover and full editor. Keys T, D, W, M, J, K, N, E, ⌫.
- **Backends.** Google Calendar (`calendar.events` and `calendar.calendarlist.readonly`), Microsoft Graph, and CalDAV for iCloud and generic IMAP accounts (own iCalendar parser, `main/ical.ts`). Fastmail (JMAP) has no calendar.
- **Limits found in code.**
  - Recurring events and meetings with guests are read-only. There is no recurrence creation.
  - Google saves use `sendUpdates=none`, so adding guests sends no invitations. Outlook does send them.
  - No video-conference links and no RSVP.
  - Weeks start on Sunday, with no preference.
- **Maturity.** The UI is verified headless on six demo calendars. Live Google, Outlook and CalDAV calendars are unverified (TODO M38 and M11).

### Search

SQLite FTS5 over subject, people and text with prefix matching, operators (`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:bookmarked`, `in:`, `after:`, `before:`), recent searches, and provider server search merged in. On a synthetic 10k-thread, 20k-message mailbox (PROGRESS, M34) import took 3.2 s (before a fix it did not finish in 210 s), selective search 3.5 ms and broad search 88.8 ms, with under 100 rows mounted; bodies are still cached in memory. Mocks and synthetic only. No saved searches.

### Keyboard shortcuts and notifications

- **Shortcuts.** Six tabs in the in-app guide (`?`): General, Moving around, Email, Calendar, Ask, Writing. `⌃1`, `⌃2`, `⌃3`, `⌃4`, `⌃6` jump to Home, Later, All mail, Drafts and Calendar; `/` searches, `C` composes. They pause while typing, and hovering a row moves the keyboard target. No user remapping. Verified on demo data only.
- **Notifications.** Only genuinely new arrivals notify (first sync silent, at most 3 per sync); clicking opens the thread. Global and per-account toggles, plus a Dock badge. Logic is unit-tested; real macOS delivery is unverified (TODO M11).

### Multi-account

Account switcher with "All accounts"; Home and Calendar aggregate. Add-account discovers the provider from an address (MX over DNS-over-HTTPS, autoconfig, Thunderbird ISPDB), and a custom-domain checker covers MX, SPF, DKIM, DMARC and MTA-STS. Discovery ran against live DNS; everything after it is fake servers only.

### Cross-device sync

Settings → Accounts → "Your other devices". Done, Later, todos, due dates and reminders sync through an encrypted record in a hidden "Aplos Mail Data" folder or label in each mail account, keyed from a sync code copied between devices. Workflow state only: drafts, settings, Ask chats and AI keys do not sync. Opt-in; in Gmail the hidden message stays visible in All Mail. Mocks only: three services sharing one fake mailbox (`tests/devices.test.ts`).

### Settings and onboarding

- **Settings.** Tabs: General, Mail, Calendar, AI, Notifications, Accounts, Help & about. They cover theme, sidebar style, Zen mode, open at login, default mail app, microphone, triage direction, Done/Later mapping, undo-send length, signature, remote images, blocked senders, JSON export of the cached mailbox and demo reset.
- **Welcome.** Once per data folder: add an account (or "look around with demo mail"), an AI key (Groq preselected), microphone, and the four keys that matter. Escape skips each step.
- **Maturity.** Headless Chromium plus a packaged check of the welcome and a synthetic key save. The real microphone prompt and a real provider accepting a key are unverified.

### Updates

electron-updater with the GitHub provider checks 60 s after launch and every 6 hours, downloads in the background and shows "Aplos X.Y.Z is ready · Restart · Later"; it never installs until Restart. It is off in dev, browser preview, a mounted DMG and unsigned builds (`src/main/updates.ts`). The state machine is unit-tested and the real updater reached "ready" against a local fake feed, but the install step was never exercised. Two blockers apply (section 5).

## 3. Providers

| Provider | Code | Configuration | Verified |
|---|---|---|---|
| **Gmail** (`main/google.ts`) | Complete: OAuth loopback with PKCE, incremental `history.list` sync, labels, attachments, MIME send, send-as aliases and signatures. | Release builds inline Aplos's own Google Desktop client ID and secret (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are repo secrets). | **No.** The first real sync failed with a 403, and the v0.2.3 retry fix is unconfirmed. |
| **Google Calendar** | Same adapter: list, create, update, delete. | Same client. | No. |
| **Outlook / Microsoft 365** (`main/microsoft.ts`, Graph) | Complete: PKCE public client, per-folder delta sync, calendar. | **No client ID.** The `MICROSOFT_CLIENT_ID` secret is absent and empty in the v0.2.3 CI log. The app says "Outlook sign-in isn't available in this build." | No. Emulator only. |
| **IMAP/SMTP** (`main/imap.ts`) | Complete: UIDVALIDITY checks, no unsafe EXPUNGE, own threading from Message-ID and References. | User-supplied app password. No OAuth client needed. | No. Fake servers only. |
| **JMAP / Fastmail** (`main/jmap.ts`) | Complete for mail. No calendar. | User-supplied API token. | No. |
| **CalDAV** (`main/caldav.ts`) | Own iCalendar parser, 30 days back to 1 year ahead. | Same credentials as IMAP. | No. |
| **iCloud** | IMAP/SMTP plus CalDAV preset. | App-specific password. | No. |
| **Proton Mail** | Detected and refused; needs Proton Bridge, which is unsupported. | None. | N/A. |

**OAuth scope risk (my inference, not in the repo).** Gmail access requests `gmail.modify` and `gmail.settings.basic`. Google generally requires app verification, and for restricted scopes a security assessment, before the public can use them without an unverified-app warning and a test-user cap. The repo records nothing about the consent screen's status. The code also never checks which scopes were granted on the token response, so with Google's granular consent an unticked scope would produce a later 403 like the one reported. That is one plausible, unconfirmed explanation.

**Polling, not push.** Every provider syncs every 60 s and on window focus. IMAP IDLE is disabled in the session options. Initial windows are bounded (Gmail 500 threads, IMAP inbox 500).

**Side effects on a real Gmail account.** Bookmark maps to STARRED, and a manual importance change writes the IMPORTANT label (AI classification stays local). Done archives and Later marks read by default.

## 4. AI

**Providers** (`shared/ask.ts`, `main/llm.ts`, `main/providers.ts`, `main/anthropic.ts`): Groq (default for every feature), OpenAI ("ChatGPT"), Claude (official Anthropic SDK), Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio and a custom OpenAI-compatible server. Settings → AI picks a model per feature: Ask, Summaries, Drafts, Plans, Voice. Defaults are Groq `openai/gpt-oss-120b` and `whisper-large-v3-turbo`. Voice can only use Groq or OpenAI. Ask needs tool-capable models.

**Features using AI.** Summaries (with importance, reply status, todo, due date and suggested action), Ask, drafts and polish, Plans, and voice transcription. Unsubscribe, block and duplicate detection are not AI.

**Key storage** (`main/ai-keys.ts`, `main/keyring.ts`, DECISIONS "AI keys in Settings"):
- A key typed in Settings is encrypted into `ai-keys.enc.json`, sealed with a data key held in the macOS keychain through Electron safeStorage.
- The renderer sees only the source (saved or environment) and the last four characters.
- Paste happens in the main process. A typed key does pass through the renderer once, at entry.
- A saved key beats the environment variable. Keys apply with no restart. The browser preview cannot save keys.

**What runs where.**
- **Cloud (default).** Every AI feature goes to Groq. A feature's email text goes only to the provider chosen for that feature.
- **Local when chosen.** Ollama, LM Studio or a localhost server keep a feature's text on the Mac. Voice has no local option.
- **Always local.** Mail storage (SQLite `aplos.db` with FTS5), search, the operation queue and the engine, which runs in an Electron utility process.
- **Not encrypted at rest.** The mail database relies on FileVault.
- **No telemetry.** I found no crash reporter, analytics or tracking code, and the site declares none.

**Injection posture.** Mail is treated as untrusted data and model output is validated (links and attachments must exist in the thread, dates must be real). The model cannot send mail or write an event without a click.

**Evidence level.** Only Groq has run live, and only on synthetic or demo content. Other providers are verified through fake transports.

## 5. Distribution

- **Platform.** macOS 12 or later only, Apple silicon and Intel. No Windows or Linux builds. The site's hidden `download/` page lists Windows and Linux from sample data (`release.sample = true`).
- **Pipeline.** A `v*` tag triggers `.github/workflows/release.yml` on `macos-26`, which typechecks, tests, builds DMG and ZIP per architecture plus `latest-mac.yml`, signs, notarizes and uploads a draft release (RELEASING.md).
- **Signing and notarization.** Verified in the v0.2.3 CI log: both architectures were signed with a Developer ID Application identity, and "notarization successful" appears twice. Secrets present: the signing and `APPLE_*` set and the Google pair; `MICROSOFT_CLIENT_ID` is absent. No one has opened the DMG on a clean second Mac (TODO), so Gatekeeper acceptance is untested.
- **Versions.** All four are drafts (`gh release list`); none is published.

| Version | Draft created (UTC) | Change |
|---|---|---|
| v0.2.0 | 2026-10-24 23:59 | First successful release run, after two failed runs. Fix: electron-builder upgraded to 26.18 so CI signing can unlock its keychain. |
| v0.2.1 | 2026-10-25 01:01 | OAuth clients built into release builds. On a second Mac, v0.2.0 could not connect Google. |
| v0.2.2 | 2026-10-25 01:29 | Says why an account failed to sync. |
| v0.2.3 | 2026-10-25 03:05 | Retries Google rate limits and shows Google's own reason for refusals. Awaiting the owner's test. |

- **Two blockers the docs do not mention.**
  - **The repository is private** (`gh repo view` returns `PRIVATE`). The site's Download button (`releasesUrl`, GitHub `/releases/latest`) and its GitHub link point at a repo that gives the public a 404 (confirmed for `/releases/latest`). The GitHub provider in electron-updater also needs a token for a private repo, and `updates.ts` sets none. After the owner publishes, updates would not reach other users unless the repo or releases go public, or a feed is hosted elsewhere.
  - **The first signed build needs a manual install.** RELEASING.md says so, because the updater is off in unsigned builds.
- **Website.** Static Vite and React site on Vercel with working demos. It names Outlook, iCloud, Fastmail and IMAP support although none has run live, and Outlook cannot sign in at all in this build.
- **Mobile.** `MOBILE.md` is a portability spike only; there is no mobile app and `packages/` is empty.

## 6. Gaps

Absence was checked by searching the code, not assumed.

**Missing or minimal for a daily mail client**
- **Rules and filters:** none. SPEC.md defers "reusable automation rules". Aplos creates no Gmail filters either.
- **Snooze:** no verb. Later with a due date and reminder is the substitute.
- **Send later:** none. Only the undo-send delay exists.
- **Templates, snippets, canned replies:** none.
- **Contacts:** no address book. Suggestions come from correspondents already in the mailbox. No Google People or Microsoft contacts integration.
- **Unsubscribe:** body-link scan only, with no `List-Unsubscribe` header and no one-click.
- **Labels and folders:** no label management or move-to-folder; folder providers expose only Inbox, Archive, Trash and Spam roles.
- **Tracking and read receipts:** nothing beyond remote-image blocking.
- **Encryption:** no PGP or S/MIME. Mail is not encrypted at rest.
- **Out-of-office, shared inboxes, delegation, team features:** none.
- **Calendar:** no recurring-event creation, no RSVP, no conference links, no week-start setting.
- **Delivery:** polling only, with no push and no IMAP IDLE.
- **Platforms:** no mobile, web app, Windows or Linux (the browser preview is for development).

**Risks specific to the current state**
- No provider is verified live, and the one real Gmail attempt failed.
- First-sync AI cost and rate-limit behavior is unmeasured.
- OAuth app verification status is unknown.
- The updater cannot reach users while the repo is private.
- Doc drift: README and PROGRESS contradict the release pipeline.

## 7. UX character

- **Keyboard-first.** Every visible action carries its key, hovering a row retargets the keyboard, and shortcuts pause while typing. Most actions are single keys (E, L, B, U, R, F, Z, `/`, `?`).
- **Home you can finish.** One card in focus, other mail as faded one-liners, low-importance mail collapsed to one line, "All clear for now" as the empty state, and a Zen mode that hides every count except Home. This depends entirely on the AI importance pass, which has only been proven on demo mail.
- **Space is the AI primary action.** On an email it runs the model-suggested next step: open a link, preview an attachment, start a reply with a suggestion chip, or open the calendar confirm card. Enter or O always opens the email. In the reader, Space opens an inline reply and holding Space dictates.
- **Docked Ask.** A right-hand panel opened with A or ⌘J, with hold-A voice and an "Ask | Today" dock switch. It cites mail and returns drafts, events and triage as confirmable cards; it never acts on its own.
- **Big summaries, sender-first reader.** The AI summary is the largest text on the Home card and sits above the subject in the reader. Each message shows the sender and a relative date, with addresses in a popover.
- **Craft.** A real design system (`renderer/ui/`), compositor-only drag and swipe, reduced-motion support, native SF Symbols through a Swift helper, vibrancy sidebar. The owner bans the sparkle and wand AI icon.
- **Website.** Airmail palette from the app icon, light and dark following the system, and working demos of the real interaction instead of video.
