<img src="apps/desktop/assets/icon.png" width="64" height="64" alt="Aplos Mail">

# Aplos Mail

An original macOS email app with a focused inbox, Later todos/bookmarks, rich drafts, Groq intelligence, and calendar commitments. Built from scratch after staged REA behavior investigation of an installed reference app. No reference code, artwork, branding, tokens, or mailbox contents are included.

## Layout

An npm-workspaces monorepo. Run every command from the repo root.

| Path | What it is |
|---|---|
| `apps/desktop` | The Electron app (macOS now; Windows and Linux would be more electron-builder targets). Its source, tests, scripts, assets and build config live here. Paths elsewhere in these docs, such as `src/main` or `scripts/verify-release-real.mjs`, are relative to this folder. |
| `apps/web` | The marketing website and a draft privacy policy (Vite + React, static output). See `apps/web/README.md`. |
| `packages/` | Shared workspaces: `engine` (the platform-neutral engine), `contract` (contract v1), plus `contract-fixture`, `emulators` and `mail-html`. |
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

Put the ignored `.env` at the repo root (`apps/desktop/.env` also works). `npm run verify:release:real` runs the post-package check described below.

Original demo mail works immediately and stays local, including Send. Demo recipients use reserved `.example` addresses. Connect a real account only when you want real mailbox access; Send and calendar changes then affect that account.

## Releases and updates

Pushing a `vX.Y.Z` tag builds signed (when the certificate secrets exist), notarized DMGs and ZIPs on GitHub Actions and publishes them to a draft GitHub Release; see [RELEASING.md](RELEASING.md). Installed copies check GitHub Releases a minute after launch and every 6 hours, download in the background and offer **Restart** / **Later**; nothing installs until you choose Restart. electron-updater on macOS can only install an update into an app signed with a Developer ID, so updates are switched off (with the reason in Settings → General) in development, the browser preview, and unsigned or ad-hoc signed builds, including every build made before the owner's certificate is configured.

## AI configuration

Groq is the default for every AI feature: Groq-hosted `openai/gpt-oss-120b` for Ask, summaries, drafts and plans, and `whisper-large-v3-turbo` for speech. Settings → AI lists the providers (Groq, ChatGPT, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio, a custom OpenAI-compatible server) and lets you pick the model for each feature; Voice can use Groq or OpenAI speech models. Ollama and LM Studio running on this Mac need no key: start the app and pick a model that can use tools. When a feature runs, its email context is sent only to the provider you chose for it. Automatic classification runs for new Google mail; automatic calendar writes require enabling the calendar preference.

**API keys.** Open a provider in Settings → AI, paste its key and choose Save (or Paste, which saves the key on your clipboard without it passing through the window). Test makes one cheap request, usually listing models, and shows the provider's own error if the key is refused; Remove deletes it. Saved keys are encrypted with the same keychain-protected key as account passwords (`ai-keys.enc.json` in the data folder) and take effect immediately, no restart. The window only ever learns that a key is set and its last four characters. Ollama, LM Studio and a custom server take an optional key the same way.

A key saved in Settings wins. Without one, the backend falls back to the provider's environment variable (`GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `OLLAMA_API_KEY`, `LM_STUDIO_API_KEY`, `CUSTOM_AI_API_KEY`), and Settings shows it as "From GROQ_API_KEY". Development loads an ignored project `.env` into that environment; packaged launches optionally load `~/.config/aplos-mail/.env` (restrict it with `chmod 600`); the package never contains `.env`. The browser preview has no keychain, so it can't save keys and says so; there, use the environment. See `.env.example`; never put real keys in source or a renderer build. `npm run eval:ask -- --model=openrouter:anthropic/claude-haiku-5.5` checks one provider live on demo data; the scripts read the environment only.

**First run.** A fresh data folder opens a short welcome: add an account (or look around with demo mail), connect an AI provider (Groq first, with a link to get a key; skippable), allow the microphone for hold-to-talk now or later, and the four keys that matter. Every step is keyboard-driven and Escape skips it. It runs once; Settings → Help & about → Show welcome opens it again.

Microphone recording requires macOS permission; the app explains permission failures. Voice recordings are capped at two minutes and transcribed by the Voice model chosen in Settings → AI (Groq by default); cancel discards the recording.

## Connect Gmail and Google Calendar

**If you downloaded Aplos Mail**, there is nothing to set up: release builds include Aplos's own Google Desktop OAuth client. Choose Continue with Google and sign in in your browser.

**Developers** running `npm run dev`, `npm run desktop` or `npm run package` use their own client: create a Google Cloud project, enable Gmail API and Google Calendar API, configure the OAuth consent screen/test users, and create a **Desktop app** OAuth client. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env` at the repo root (a packaged app reads `~/.config/aplos-mail/.env`) and restart. A value there overrides the built-in client in development and `npm run package` builds, but a release build ignores it. Without one the dialog says "Google sign-in isn't available in this build." with a hint for developers (release builds show only the first sentence). How the release client gets into the build is in RELEASING.md. The flow uses a loopback redirect with state validation and PKCE. Refresh tokens are encrypted using Electron safeStorage. The browser preview intentionally cannot persist Google credentials.

The implemented adapter supports mailbox sync/search, label mutations, attachments, verified sending aliases and their Gmail signatures, MIME sending with reply headers and Bcc, calendar listing and event create/update/delete. Alias/signature access uses the Gmail settings scope; a missing grant falls back visibly to the primary address. Live Google verification is **not complete** without Aplos-owned OAuth configuration and an authorized test mailbox. Mocked adapter tests are not a substitute for that verification. Aplos never reuses the reference app’s credentials.

## Other accounts

This build connects Gmail and Google Calendar. The earlier Outlook, iCloud/IMAP, Fastmail/JMAP and CalDAV adapters were removed; `plans/next/legacy-providers.md` lists where their code is at the tag `legacy-final` and what was ever tested.

## Use Aplos on more than one device

Settings → Accounts → **Your other devices** keeps Done, Later, todos, due dates and reminders the same everywhere. Turn it on on the first device and copy its sync code; on each other device choose **Enter code**. Aplos stores this data in a hidden folder named "Aplos Mail Data" in each account (a hidden label in Gmail), encrypted with a key derived from the sync code, so the mail host sees only ciphertext. The code stays in the encrypted credential store on each device. In Gmail the hidden message still appears under All Mail, and replaced copies go to Trash, where Gmail deletes them after 30 days. Outlook, IMAP and JMAP delete replaced copies. Repeating events and meetings with guests are read-only in Aplos; change them in your calendar app. If a send was interrupted and the message is not in Sent mail, Aplos will not send it again on its own; Compose offers **Send anyway** after a warning. Verified with fake servers only.

## Everyday controls

Use Home’s one-at-a-time stack, Done/Later, and `Z` to undo triage. Later separates Todos from Bookmarks, with due dates and reminders. Replies can target the sender or everyone; drafts autosave and support separate windows. Send waits for the configured undo delay. Provider errors preserve a recoverable draft.

Search supports `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:bookmarked`, `in:`, `after:`, and `before:`. Ask cites messages and offers drafts for review; it never sends them. Press `?` for the shortcut guide. Appearance includes light/dark/system, zen counts, and three original Dock icons.

## Data and verification

Desktop state is stored under `~/Library/Application Support/Aplos Mail`; browser development uses a separate `Aplos Mail Preview` directory so simultaneous development cannot overwrite desktop mail (override with `APLOS_DATA_DIR`). It is a local SQLite database (`aplos.db`, written in small transactions); a `state.json` from an older build is imported on first launch and kept as `state.json.imported`. Builds from before this change cannot read the database, so run only the current build against the same data folder. OAuth credentials are a separate encrypted file. Mail/drafts are not encrypted at rest by this personal build. Export includes cached mail; keep exports private. Reset Demo preserves connected accounts.

`npm test` covers persistence, triage/undo, reminders, draft concurrency/recovery, delayed sends, validation, scoped AI proposals/citations/cancellation, OAuth PKCE/state, MIME, label mapping, encrypted credentials, calendar mutations, and desktop request/ownership policies. Live Groq was verified with synthetic text and audio. Browser and packaged-app acceptance results, exact remaining blockers, and REA limitations are recorded in `PROGRESS.md` and `TODO.md`.

After packaging, `npm run verify:release:real` launches the packaged app in hidden test mode (`APLOS_TEST=1`) on a throwaway folder, loads the demo mail (no account, nothing sent outside the folder) and checks that the new engine starts and `mail.db` (never `aplos.db`) is created, then triage and Undo, message reads, a draft and a queued send with Undo, settings, refusal of invalid and unknown calls, recovery after the engine process is killed, and a desktop restart. Package first: `npm run package`.

This is a local personal build. It has no automatic distribution/update server or Developer ID notarization. Rebuild to update.

## Resume work

Read `SPEC.md`, `TODO.md`, `DECISIONS.md`, and `PROGRESS.md` first. Pick the next unchecked item, investigate one feature/module at a time, implement independently, verify, record evidence, check off only completed acceptance, and commit. Do not claim full reference parity while live integration or reference behavior remains unverified.
