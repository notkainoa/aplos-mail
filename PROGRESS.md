# Progress

## 2026-10-14 — M0

Located Avec and identified Electron, packaged renderer/preload/main modules and original version. Used REA inventory, safe temporary extraction, retained module paging and focused preload module inspection; recovered from broad-analysis timeout without repeating it. Read-only runtime confirms Home/Later/all-mail/drafts/sent/reply-status/trash/spam, stack/split, appearance/system/voice and mail preferences. Mapped features and remaining external verification in SPEC.md and TODO.md. Local dotenv key presence checked without disclosing it. No implementation copied.

Next: M1 domain/service scaffolding, then feature loops. REA extracted reference root is temporary; use Evidence IDs in SPEC.md rather than assuming it survives a new session.

## 2026-10-14 — M1

Implemented typed shared model, 18 original synthetic threads/two demo accounts, atomic local storage, explicit service API, loopback preview bridge, isolated Electron preload and shell. REA preload module evidence supports window/draft ownership, persistent Ask, sync and attachment boundaries; implementations are independent. Service/provider/desktop policy tests: 18 pass. Typecheck and renderer/main/preload production builds pass. Browser preview opens onboarding and Home; reference content/assets never enter product files. Subsequent feature modules are implemented behind the same bridge and are undergoing UI acceptance before checklist completion.

## 2026-10-14 — M2/M3

Built original warm light/dark inbox UI, account sidebar, low-priority bundle, stack/split reader, mailbox views, search filters, safe HTML/remote-image gating, quoted content and attachment preview/save. Later supports Todos/Bookmarks and overdue/undated/upcoming groups with due/reminder controls. Triage includes bulk and keyboard actions, bookmarks, reply status, Spam/Trash/restore, sender block and link-based unsubscribe.

Verified in collaborative browser: Home → message → Done advances stack; Undo restores original status after automatic read marking (regression fixed); split reader preserves list; text attachment preview displays original synthetic contents; Later date edit persists `2026-10-20` and appears in Upcoming. Service tests cover search, dates/reminders, state validation and undo across restart. Fixed date-label rounding and automatic-read undo interference. No external mailbox modified.

Focused REA recovery: copied only the extracted preload into a temporary analysis scope, 579KB; analysis parent `ev_637193decf7ce35507c32f402ba43c965b80534f4c72540934b04cd8dd245139` retains 199 literal IPC channels, semantic heap coverage partial. Tiny incoming traces confirm literal Ask history (`ev_573d1c9816ec25678805ce6076b39616bd1a34c1e3541edbe6b4090027f50ab9`), draft saving (`ev_4e5d2a56268a15c557c1febc1bdc46e972a5258df4bb2de534943b254e9532af`), ownership (`ev_5a6a2cd1ac0ae3cd83c781dfe84c741af50cafbd7c24e7f19e2a1e857d9367f0`) and attachment download (`ev_6d374c6a904cec63c7c2a0cbbb2b518fe82216b2b89663de855e035ac23c4bc3`) boundaries. These are syntax evidence, not runtime enforcement proof. Reference code remains outside project.

## 2026-10-14 — M4

Rich composer supports recipients/Cc/Bcc, per-message signature, formatted body/links/images, attachments/forwards, local autosaved revisions, replies/reply-all and native popout ownership. Send uses a durable cancellable delay; failed providers preserve drafts. Serialized autosave and native close/quit handshake save the latest text before releasing a window; save errors cancel close. Production app launched and native Quit acknowledged correctly.

Browser acceptance: typed To/subject/body then immediately closed; reopened persisted exact latest body at revision 2. Send → Undo Send removed pending delivery and preserved draft; actual subsequent demo Send moved the message into Sent after the delay, included reviewed signature and removed draft. No external delivery. Service tests cover failure/restart/revision conflicts; desktop policy tests cover transfer/foreign release.

## 2026-10-14 — M5/M6

Groq backend implements summary/importance/todo/reply classification, proofreading/polish, email proposals, Ask/history/citations, definite calendar extraction and Whisper transcription. Ask proposals are explicit user actions; changed drafts require confirmation. Current-draft context is validated and bounded, never stored as altered user text. UI preserves recipients, attachments and inline images, uses scoped cancellation, and blocks accidental composer send from Ask keyboard input. Voice handles permission/release/unmount races and auto-polishes dictated text before review; the raw transcript survives cancellation.

Live synthetic Groq checks passed: summary, draft, polish, Ask with exact citation, known calendar timestamp, and synthesized WAV transcription. Browser live Ask also returned the expected garden thread citation with no UI error. Fixed a Chromium scroll-effect cleanup incompatibility discovered by this acceptance. Real microphone/OS permission acceptance is explicitly deferred to M11, not claimed by synthetic audio proof.

## 2026-10-14 — M7/M8

Calendar editor/schedule and Groq event proposals work through the same service; duplicate-aware save and configurable automatic extraction are implemented. Browser created a synthetic event and verified persisted fields; all-day dates remain local date-only to prevent timezone drift. Google OAuth/Gmail/Calendar implementations are original and use Aplos credentials, loopback PKCE/state, encrypted refresh tokens, paginated mail, attachments and generated MIME. Mocked integration tests exercise real local OAuth callback behavior, token refresh, mail normalization/mutations/send and Calendar operations. Live Google is not verified: own client credentials are absent. M11 remains unchecked.

## 2026-10-14 — desktop acceptance in progress

Production `.app` builds and launches. Native Cmd+N opens compose; native immediate Cmd+W after editing persists the latest text; reopened draft moves to a real separate native window; edited popout survives whole-app Cmd+Q at revision 3. The close test reads persisted state only after asynchronous handshake settles. Browser verified live Ask → explicit draft proposal → open draft → revised proposal applied to the same draft with recipient retained. Appearance light/dark, zen counts, search attachment filter and calendar event persistence verified. Production dependency audit: zero vulnerabilities; all 18 tests pass. ASAR scan reports zero bundled .env files and no Groq key bytes in app code.

Final reference-gap audit found the observed Gmail per-sending-address signature behavior was not yet represented by custom global signature. Added M12 rather than silently narrowing parity; implementation and focused verification underway. Google live remains blocked by missing Aplos-owned OAuth client configuration.

## 2026-10-14 — M9/M12

Settings, native menus/shortcuts, three original dynamic Dock icons, light/dark/system and zen preferences, login/default-mail actions, mailto/aplos deep links, per-account notifications, data export and truthful local-build update status implemented. Browser verified theme changes, zen hiding all but Home counts, undo-delay setting and accounts screen. Native shortcuts launched composer and Home; closing windows/quit saves first. Actual OS microphone/notification permission proof remains in M11.

Closed signature parity gap with original Google settings/sendAs integration. Only authorized verified aliases appear; selected alias/name drives MIME sender, and per-address Gmail signature preview is sanitized. Existing drafts retain custom-signature behavior; new Google drafts choose the relevant default/reply alias. Server rejects unauthorized and cross-account senders. Missing settings scope leaves primary-address mail usable with a visible warning. REA focused signature boundary trace: `ev_16966762d62997c2b3c9e3f99d6761090820e176ac1761a897cbe461d0df2325`; static candidate evidence, live Google not inferred. Extended existing MIME/OAuth tests plus one meaningful service identity regression: all 19 tests and typecheck pass.

## 2026-10-14 — M10 delivery and remaining prerequisite

Final `npm run package`, typecheck (part of build), all 19 focused tests, and `npm audit --omit=dev` pass (zero production dependency vulnerabilities). Built `release/mac-arm64/Aplos Mail.app`, installed a new independent copy at `/Users/knewton/Applications/Aplos Mail.app`, and verified the installed renderer launches from that bundle via Finder. Local personal build is unsigned/unnotarized; no distribution identity or update host was invented.

Finder environment setup: populated private `~/.config/aplos-mail/.env` from the existing runtime Groq configuration only, mode 0600; no value printed or put in source. Packaged backend loads it into process environment. Existing configuration would have been preserved. Tracked-file and ASAR scans report no key bytes and zero bundled `.env` files. Added README, .env.example, launch helper and repository resume instructions.

**Not complete / blocker audit 1:** M11 remains unchecked. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are absent; live Gmail/Google Calendar acceptance requires a Google Cloud Desktop OAuth client owned by this app, enabled APIs, and an authorized test mailbox. It cannot be honestly replaced by mocked tests or by borrowing Avec's credentials. OS-dependent microphone/notification delivery also requires actual permission acceptance; synthetic Groq speech and implemented UI paths are verified, real hardware/delivery are not claimed. No user questions or requests were made. All independent implementation, local/demo and Groq verification is complete; do not mark the overall goal complete. On continuation, recheck these prerequisites, preserve all commits and resume M11 when available.
