# Aplos Mail specification

An original macOS desktop email application that follows Avec's observed information architecture and interaction model, with independent code, icons, sample mail, typography and visual identity. Project root: `/Users/knewton/.t3/projects/aplos-mail`.

## Reference and evidence

Target: `/Applications/Avec.app`, version `1.0.1-release.20261014170150`, Electron application. ASAR SHA-256 `1ac8066c43397292942487da4acb0af997a03cce99ac174ec39b38da4f5ef325`.

- REA inventory/partial application analysis: `ev_1f0d97929327731eff0dad27e966b0e8347d39da5d82abe508b29ebb8cae0b67`.
- REA module inventory: `ev_a4d8f7a47b120e6e24e25acc36b3b1fc26a7c12df18f970483e8cbe23f040365`.
- REA safe extraction outside repository: `ev_098ad6773408f34dfccf9a6d8ad17f5ad164675d911de858a7f20de9ea50d8e6`.
- REA desktop bridge module: `ev_93022cc4a07ec72ecd1c974031cb706351905d0058deb83dafac69cf8fa7587c` (literal IPC inventory).
- Read-only runtime inspection of Home, General/Mail settings and Later using macOS accessibility and screenshot on 2026-10-14 corroborates navigation and settings. Reference mailbox content is never used as fixture data.

Limits: broad REA pass timed out after retaining inventory and some syntax facts. Integrity metadata contradicts the signed unpacked SQLite binary; recorded as untrusted. Static labels/IPC are candidate features, not proof of execution. Investigate individual features/modules before implementing them. Internal galleries, debug crash/storage probes, vendor telemetry, proprietary service infrastructure and branded assets are not product behavior to reproduce. Do not claim unobserved feature-flag experiments are shipping features.

## Feature map and acceptance

1. **Desktop shell** — native macOS window, sidebar show/hide, back/forward, refresh, native menus, keyboard shortcuts/help, application icon, dock and launch behavior. Electron + React + TypeScript selected for shared desktop/browser verification.
2. **Accounts/onboarding** — original welcome/demo, Gmail OAuth connection, account switcher and all-account view, disconnect, sync/error/offline status. Never reuse Avec tokens or OAuth identity. A first-class local demo is useful without Google credentials; live Gmail requires this app's own OAuth client credentials.
3. **Home** — New stack, human-readable summaries, low-importance bundle, dated and undated todos, reply sections. Fresh original deterministic example mail; AI generation uses Groq only.
4. **Thread reader and triage** — stack and split modes, message expansion, sanitized HTML, remote-image control, quoted text, attachments, navigation; Done/Later/Trash/Spam/restore, importance and bookmark, read/unread, multi-select/bulk actions, undo. Configurable Done/Later mapping to Gmail archive/read state.
5. **Later** — Todos/Bookmarks tabs; undated/overdue/upcoming groups, editable due dates and reminders, return-to-Home on reminder, completion.
6. **Mailbox views** — All mail, Drafts, Sent, Needs reply, Awaiting reply, Trash, Spam, low-importance; local and Gmail search with filters; find within message.
7. **Compose** — new, reply, reply all, forward; To/Cc/Bcc, subject, sending account, rich text, links, inline images and file attachments, signatures; autosave, reopen/delete draft, popout with ownership, send with cancellable undo delay, failures preserve draft, keyboard send.
8. **Groq AI** — thread summaries/importance/todo/reply classification; Ask with mailbox citations and persistent conversations; draft/reply/forward proposals applied only by user action, proofreading/polish, voice transcription and voice-driven drafting/search. All network AI calls run in main/server process, use `GROQ_API_KEY`, and never expose the key to renderer or logs. Errors and cancellation are visible.
9. **Calendar** — detect commitments from email with Groq; event cards/details, duplicate-aware preview, calendar selection, add/update/remove, schedule view, Google Calendar connection/health and auto-add preference. Calendar operations are explicit user actions except when auto-add is enabled.
10. **Settings** — General (light/dark/system, original app icon variants, zen counts, login launch, mailto default, microphone selection); Mail (triage direction/swipes, Done/Later mappings, default reply/reply all, signatures, original optional footer, auto-polish, undo delay and send sound); Calendar; per-account notifications; Help/about/shortcuts, data export/reset, app version/update status. Unsubscribe/block controls protect against accidental external side effects.
11. **Desktop integrations** — mailto/custom deep links, OS notifications opening a thread, attachment save/open, secure persisted account credentials, multiple windows, reconnect/retry and storage errors.
12. **Quality and delivery** — focused behavior tests for persistence/triage/drafts/send/AI/Google adapters, typecheck and production build, browser interaction verification, packaged `.app` build and actual launch, README and resume instructions. Do not check off live integration verification without valid external configuration and actual evidence.

## Implementation boundaries

- Shared typed domain contracts in `src/shared/types.ts`; renderer uses `window.aplos.invoke(method, payload)` and `window.aplos.subscribe(listener)`. Browser development uses a loopback-only local API exposing the same bridge.
- Service orchestration lives in `src/engine/service.ts` and receives platform dependencies through `src/engine/ports.ts`; `src/main/service.ts` constructs the desktop implementations. The same engine is bundled into the Electron utility process; windows follow paged snapshots and commit changes.
- Storage is a local SQLite database (`aplos.db`) in the app data directory, accessed through the engine's SQL port; mail hosts remain the source of truth for mail and flags, and no Aplos server stores user data. Providers implement the contract in `src/engine/provider.ts`; see DECISIONS.md (multi-provider architecture) for the planned adapters and mobile path.
- Main/server service method names and JSON contract are documented in `API.md`. Persist local application state under macOS Application Support, not the source tree; tests use isolated temporary directories.
- Secrets are environment-only configuration or OS-encrypted OAuth tokens. Local `.env` is ignored and can populate process environment; it is never bundled. Production launch instructions must explain environment loading.
- No sending external mail or modifying the reference mailbox as part of autonomous testing. Use original local/demo data and mock Google adapters; only synthetic content is used for live Groq verification.

## Completion definition

Every TODO acceptance item checked with evidence, focused tests pass, production desktop builds and launches. Missing Google OAuth credentials or OS access can block live verification, but do not block completing independent implementation and demo verification. Record the exact remaining blocker honestly.

## Inbox Zero research follow-up (2026-10-16)

User approved the report's immediate hardening recommendations: independently implement local Google/Microsoft emulation, focused Groq quality evaluations and large-mailbox verification. These are Aplos design choices inspired by public architecture research, not observed Avec requirements. Keep the current local desktop architecture. Reusable automation rules, hosted services and distribution infrastructure remain future options, not part of this increment. Emulation is development-only, uses original synthetic mail and real adapter/OAuth paths, and cannot satisfy M11 live-provider acceptance.
