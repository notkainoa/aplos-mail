<img src="apps/desktop/assets/icon.png" width="64" height="64" alt="Aplos Mail">

# Aplos Mail

An original macOS email app with a focused inbox, Later todos/bookmarks, rich drafts, Groq intelligence, and calendar commitments. Built from scratch after staged REA behavior investigation of an installed reference app. No reference code, artwork, branding, tokens, or mailbox contents are included.

## Layout

An npm-workspaces monorepo. Run every command from the repo root.

| Path | What it is |
|---|---|
| `apps/desktop` | The Electron app (macOS now; Windows and Linux would be more electron-builder targets). Its source, tests, scripts, assets and build config live here. Paths elsewhere in these docs, such as `src/main` or `scripts/verify-release.mjs`, are relative to this folder. |
| `apps/web` | The marketing website and a draft privacy policy (Vite + React, static output). See `apps/web/README.md`. |
| `packages/` | Reserved for shared code, such as the platform-neutral engine when an iOS app needs it (see DECISIONS.md). |
| `scripts/launch.mjs` | Root shim for the desktop launcher. |

## Run

Requires Node 22.12+ and macOS arm64 for the packaged desktop build.

```sh
npm install
npm run dev       # Browser preview: http://127.0.0.1:5173
npm run desktop   # Build and run Electron
npm run typecheck # every workspace
npm test          # every workspace
npm run package   # apps/desktop/release/mac-arm64/Aplos Mail.app
npm run release:build # DMG + ZIP for arm64 and x64, plus latest-mac.yml, in apps/desktop/release
npm run release -- patch # bump the version, commit and tag (see RELEASING.md)
node scripts/launch.mjs # Launch packaged app with the ignored workspace .env
npm run web       # Website dev server: http://127.0.0.1:5273
npm run web:build # Build the website to apps/web/dist
```

Put the ignored `.env` at the repo root (`apps/desktop/.env` also works). `npm run verify:release` and `npm run verify:large` run the post-package checks described below.

Original demo mail works immediately and stays local, including Send. Demo recipients use reserved `.example` addresses. Connect a real account only when you want real mailbox access; Send and calendar changes then affect that account.

## Releases and updates

Pushing a `vX.Y.Z` tag builds signed (when the certificate secrets exist), notarized DMGs and ZIPs on GitHub Actions and publishes them to a draft GitHub Release; see [RELEASING.md](RELEASING.md). Installed copies check GitHub Releases a minute after launch and every 6 hours, download in the background and offer **Restart** / **Later**; nothing installs until you choose Restart. electron-updater on macOS can only install an update into an app signed with a Developer ID, so updates are switched off (with the reason in Settings → General) in development, the browser preview, and unsigned or ad-hoc signed builds, including every build made before the owner's certificate is configured.

## AI configuration

Run `npm run eval:groq -- --runs=2` for eight focused semantic evaluations per run against the actual Groq adapter. These use only original synthetic text, covering facts, deadlines, exact event times, ambiguity, citations, missing evidence, recipients and email prompt injection. The backend reads `GROQ_API_KEY`; no key is written to the ignored `artifacts/groq-evaluation.json` report. Missing keys or any failed assertion produce a failing exit status. Ordinary `npm test` stays offline. A passing corpus provides evidence for those cases, not a guarantee of all model behavior.

For isolated provider development, run `npm run dev:emulated` and open the displayed local URL. Add Google or Outlook through the normal account dialog: the real adapters complete OAuth/PKCE, refresh and mailbox operations against a loopback-only protocol emulator. Profiles and mail are original synthetic fixtures; delivery stays inside the emulator and only `.test`/`.example` recipients are accepted. Other providers and network discovery are disabled. Storage is a new temporary folder per run, removed at shutdown; normal desktop/preview data and real OAuth configuration are not used. AI is disabled by default; `npm run dev:emulated -- --live-ai` enables actual Groq calls with the backend environment key. The emulator covers the implemented development scenarios, not the complete provider APIs or live-provider acceptance. `tests/emulation.test.ts` repeats onboarding, refresh, incremental sync, triage retry/Undo, reconnect, local send and credential/database restart through the application HTTP API on a random loopback port.

Groq is the default for every AI feature: Groq-hosted `openai/gpt-oss-120b` for Ask, summaries, drafts and plans, and `whisper-large-v3-turbo` for speech. Settings → AI lists the providers (Groq, ChatGPT, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio, a custom OpenAI-compatible server) and lets you pick the model for each feature; Voice can use Groq or OpenAI speech models. Ollama and LM Studio running on this Mac need no key: start the app and pick a model that can use tools. When a feature runs, its email context is sent only to the provider you chose for it. Automatic classification runs for new Google mail; automatic calendar writes require enabling the calendar preference.

**API keys.** Open a provider in Settings → AI, paste its key and choose Save (or Paste, which saves the key on your clipboard without it passing through the window). Test makes one cheap request, usually listing models, and shows the provider's own error if the key is refused; Remove deletes it. Saved keys are encrypted with the same keychain-protected key as account passwords (`ai-keys.enc.json` in the data folder) and take effect immediately, no restart. The window only ever learns that a key is set and its last four characters. Ollama, LM Studio and a custom server take an optional key the same way.

A key saved in Settings wins. Without one, the backend falls back to the provider's environment variable (`GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `OLLAMA_API_KEY`, `LM_STUDIO_API_KEY`, `CUSTOM_AI_API_KEY`), and Settings shows it as "From GROQ_API_KEY". Development loads an ignored project `.env` into that environment; packaged launches optionally load `~/.config/aplos-mail/.env` (restrict it with `chmod 600`); the package never contains `.env`. The browser preview has no keychain, so it can't save keys and says so; there, use the environment. See `.env.example`; never put real keys in source or a renderer build. `npm run eval:ask -- --model=openrouter:anthropic/claude-haiku-5.5` checks one provider live on demo data; the scripts read the environment only.

**First run.** A fresh data folder opens a short welcome: add an account (or look around with demo mail), connect an AI provider (Groq first, with a link to get a key; skippable), allow the microphone for hold-to-talk now or later, and the four keys that matter. Every step is keyboard-driven and Escape skips it. It runs once; Settings → Help & about → Show welcome opens it again.

Microphone recording requires macOS permission; the app explains permission failures. Voice recordings are capped at two minutes and transcribed by the Voice model chosen in Settings → AI (Groq by default); cancel discards the recording.

## Connect Gmail and Google Calendar

**If you downloaded Aplos Mail**, there is nothing to set up: release builds include Aplos's own Google Desktop OAuth client. Choose Continue with Google and sign in in your browser.

**Developers** running `npm run dev`, `npm run desktop` or `npm run package` use their own client: create a Google Cloud project, enable Gmail API and Google Calendar API, configure the OAuth consent screen/test users, and create a **Desktop app** OAuth client. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env` at the repo root (a packaged app reads `~/.config/aplos-mail/.env`) and restart. A value there overrides the built-in client in development and `npm run package` builds, but a release build ignores it. Without one the dialog says "Google sign-in isn't available in this build." with a hint for developers (release builds show only the first sentence). How the release client gets into the build is in RELEASING.md. The flow uses a loopback redirect with state validation and PKCE. Refresh tokens are encrypted using Electron safeStorage. The browser preview intentionally cannot persist Google credentials.

The implemented adapter supports mailbox sync/search, label mutations, attachments, verified sending aliases and their Gmail signatures, MIME sending with reply headers and Bcc, calendar listing and event create/update/delete. Alias/signature access uses the Gmail settings scope; a missing grant falls back visibly to the primary address. Live Google verification is **not complete** without Aplos-owned OAuth configuration and an authorized test mailbox. Mocked adapter tests are not a substitute for that verification. Aplos never reuses the reference app’s credentials.

## Connect Outlook, iCloud, Fastmail and other accounts

Choose **Add account** (Settings → Accounts, or the welcome screen) and enter your address. Aplos recognizes common mail domains, looks up a custom domain's MX records over DNS-over-HTTPS, then tries the domain's published autoconfig file and Thunderbird's ISPDB. You can also pick a provider directly.

- **Outlook / Microsoft 365** uses Microsoft Graph with browser sign-in (PKCE, loopback redirect, no client secret). Register your own app in Microsoft Entra under "Mobile and desktop applications" with redirect URI `http://localhost`, allow public client flows, grant `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `MailboxSettings.Read`, `User.Read` and `offline_access`, then set `MICROSOFT_CLIENT_ID` (and optionally `MICROSOFT_TENANT`). Saving a calendar event with guests through Outlook sends invitations; Graph has no silent option.
- **iCloud Mail** uses IMAP/SMTP with an app-specific password from your Apple Account, plus iCloud Calendar over CalDAV. Yahoo and AOL use app passwords. **Other** accepts any IMAP/SMTP server over TLS or STARTTLS, with an optional CalDAV calendar.
- **Fastmail** uses JMAP with an API token (Settings → Privacy & Security → Connected apps & API tokens; Email and Email submission access). Calendar is not connected for Fastmail yet.
- Proton Mail needs Proton Mail Bridge, which Aplos does not support yet.

Folder-based hosts (Outlook, IMAP, JMAP) have no labels: Done or Later with the archive action moves mail to the Archive folder, and the read/unread actions leave it in the inbox. Passwords, tokens and refresh tokens are encrypted in per-provider files under the data folder with a key that the macOS keychain protects (`engine-key.bin`), and never reach the renderer or app state. None of these providers has been verified against a live mailbox yet; their tests run against fake servers.

**Custom domain check** (Settings → Accounts) reads a domain's MX, SPF, DKIM, DMARC and MTA-STS records over DNS-over-HTTPS and explains each problem with the record to add.

## Use Aplos on more than one device

Settings → Accounts → **Your other devices** keeps Done, Later, todos, due dates and reminders the same everywhere. Turn it on on the first device and copy its sync code; on each other device choose **Enter code**. Aplos stores this data in a hidden folder named "Aplos Mail Data" in each account (a hidden label in Gmail), encrypted with a key derived from the sync code, so the mail host sees only ciphertext. The code stays in the encrypted credential store on each device. In Gmail the hidden message still appears under All Mail, and replaced copies go to Trash, where Gmail deletes them after 30 days. Outlook, IMAP and JMAP delete replaced copies. Repeating events and meetings with guests are read-only in Aplos; change them in your calendar app. If a send was interrupted and the message is not in Sent mail, Aplos will not send it again on its own; Compose offers **Send anyway** after a warning. Verified with fake servers only.

## Everyday controls

Use Home’s one-at-a-time stack, Done/Later, and `Z` to undo triage. Later separates Todos from Bookmarks, with due dates and reminders. Replies can target the sender or everyone; drafts autosave and support separate windows. Send waits for the configured undo delay. Provider errors preserve a recoverable draft.

Search supports `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:bookmarked`, `in:`, `after:`, and `before:`. Ask cites messages and offers drafts for review; it never sends them. Press `?` for the shortcut guide. Appearance includes light/dark/system, zen counts, and three original Dock icons.

## Data and verification

Desktop state is stored under `~/Library/Application Support/Aplos Mail`; browser development uses a separate `Aplos Mail Preview` directory so simultaneous development cannot overwrite desktop mail (override with `APLOS_DATA_DIR`). It is a local SQLite database (`aplos.db`, written in small transactions); a `state.json` from an older build is imported on first launch and kept as `state.json.imported`. Builds from before this change cannot read the database, so run only the current build against the same data folder. OAuth credentials are a separate encrypted file. Mail/drafts are not encrypted at rest by this personal build. Export includes cached mail; keep exports private. Reset Demo preserves connected accounts.

`npm test` covers persistence, triage/undo, reminders, draft concurrency/recovery, delayed sends, validation, scoped AI proposals/citations/cancellation, OAuth PKCE/state, MIME, label mapping, encrypted credentials, calendar mutations, and desktop request/ownership policies. Live Groq was verified with synthetic text and audio. Browser and packaged-app acceptance results, exact remaining blockers, and REA limitations are recorded in `PROGRESS.md` and `TODO.md`.

After packaging, run `npm run verify:release` for a repeatable check of the actual release bundle. It uses a fresh temporary demo mailbox and separate Chromium profile, checks the renderer/preload/engine bridge, search/paging, triage/Undo, attachments, local send/Undo, calendar, popout ownership and immediate-close draft saving, then kills the engine and restarts the desktop to verify recovery. It never connects a mailbox or sends external email. The temporary folder retains its log and JSON report. Add `--live-ai` to verify Groq summaries, proofreading, proposals, Ask/citations, calendar extraction and transcription of generated speech with an existing backend key. Add `--keep-open` to leave the isolated test app running for manual inspection; quit it afterward. The test enables a temporary loopback debugging port only for its own app process.

`npm run bench:mailbox -- --label=optimized --keep` creates 10,000 original synthetic threads with 20,000 messages, approximately 2,000 characters of text plus HTML per message. It measures ingestion, search, changed-row writes, database reopen, service startup, paging and compact triage/Undo. Results go to ignored `artifacts/mailbox-optimized.json`. `--count=N` changes the size; omit `--keep` to remove its temporary database automatically. The ordinary suite includes one lighter 10,000-thread regression. After packaging, `npm run verify:large` uses the retained default fixture to verify actual desktop windowing, scrolling to both ends, keyboard navigation, search and compact mutations, with a separate Chromium profile. Only synthetic demo accounts are accepted. Its report is `artifacts/large-desktop-verification.json`; no live mailbox is used. Measurements are host/fixture-specific; benchmark peak RSS includes harness copies, not just the app. The engine and renderer still cache message bodies in memory; windowing limits mounted rows, not mailbox memory.

This is a local personal build. It has no automatic distribution/update server or Developer ID notarization. Rebuild to update.

## Resume work

Read `SPEC.md`, `TODO.md`, `DECISIONS.md`, and `PROGRESS.md` first. Pick the next unchecked item, investigate one feature/module at a time, implement independently, verify, record evidence, check off only completed acceptance, and commit. Do not claim full reference parity while live integration or reference behavior remains unverified.
