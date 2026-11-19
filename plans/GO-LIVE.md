# Go-live audit: shipping revamp in a release build

Written 2026-11-18 on `revamp` at `8f1eb4cd0`, together with the engine switch in the same PR. Each item says whether it is done, missing or partial, where the evidence is, and roughly how much work is left: S is under a day, M is one to three days, L is more.

## In plain English

The owner's final test ran a development build started with `APLOS_ENGINE=real`. Until this PR, a release build always ran the old engine and the old screens, so the redesign would have shipped turned off.

This PR makes the new engine run in every build. The first draft of this PR kept a Mac with 0.2.3 mail (`aplos.db`) and no `mail.db` on the old engine until an importer existed. The owner dropped that on 2026-11-18: Aplos has no users yet (every 0.2.x release stayed a draft), so there is no importer and no hold. On a Mac with old data the new engine starts its own `mail.db` beside the untouched `aplos.db`, and the user signs in again.

## Summary

| # | Item | Status | Size left |
|---|---|---|---|
| 1 | Engine switch in release builds | Done in this PR | — |
| 2 | What the new UI needs from the legacy engine | Done (nothing reachable) | — |
| 3 | Import of a 0.2.3 user's `aplos.db` | Not needed: no 0.2.x users (owner, 2026-11-18) | — |
| 4 | Update path from 0.2.3 | Not needed for the same reason; an updated Mac starts fresh on the new engine | — |
| 5 | Legacy code deletion | Missing; nothing blocks it now (the legacy verify scripts go with it) | L |
| 6 | OAuth and keychain in release builds | Done: a release build ignores `.env` OAuth overrides (no token migration needed: no users) | — |
| 7 | Auto-updater | Partial: main works; the new UI shows an "Update ready" notice (no Settings row yet) | S |
| 8 | `!release` / `releaseBuild` gates | Done: none hides a new feature | — |
| 9 | Account removal | Missing (another agent is on it) | S–M |
| 10 | Settings → Mail retention | Partial: the control exists, nothing enforces it | M |
| 11 | Gmail live smoke → `apps/web/provider-status.json` | Missing | S–M |
| 12 | Damaged-database path | Missing | M |
| 13 | Soak and fault injection | Missing soak, partial faults | M–L |
| 14 | Release checks still drive the legacy engine | Partial: `verify:release:real` covers the new engine; `verify-release` stays legacy | S |
| 15 | "Allow tools on this Mac" (local listener) | Hidden until the listener is built: no listener behind it | M, only if it must ship |
| 16 | AI consent re-ask on upgrade | Not needed: no importer (item 3) | — |
| 17 | Version number | Missing: still `0.2.3` | S |

## 1. Engine switch: done in this PR

`realEngineRequested` (`apps/desktop/src/host/transports/port.ts`) now answers "real engine" in every build. The data folder is not checked: a folder with old `aplos.db` gets a new `mail.db` beside it, and the old file is never opened.

**Escape hatch kept, outside release builds only.** `APLOS_ENGINE=legacy` brings the old engine back in development and local `npm run package` builds. A release build ignores it, as it already ignores `APLOS_TEST` and `APLOS_DATA_DIR`.

- *Why keep it:* several checks still drive the old engine through `state.get`: `verify-release.mjs`, `verify-resident.mjs` and `verify-large-mailbox.mjs`. These are now pinned to `APLOS_ENGINE=legacy`. The hatch goes away with the legacy code (item 5).

Everything else keys off `realPath`: preload's bridge argument (`windows.ts:146`), the welcome window (`windows.ts:370`), the mail scheme, power, quit and the tray. Test mode runs the new engine by default. "Try demo mail" is `Demo/load` on whichever engine runs, and needs no change.

In a production build the legacy renderer appears only as the fallback when the new engine's bridge fails to connect. Its banner no longer tells users to set `APLOS_ENGINE=real` (`renderer/legacyBanner.ts`); it says the new version could not start and to reopen the app.

## 2. What the new UI needs from the legacy engine: done

The new renderer calls no legacy method; `window.aplos` is used only for close, navigate and menu events (`renderer/main.tsx:91,117`).

Pop-out windows (`?draft=` / `?thread=`) still boot the legacy renderer (`renderer/entry.ts:66-67`), and on the new engine that renderer is refused every call (`engine-real.ts:253-263`). Nothing in the new UI opens one: its "pop out" goes to the in-window compose page (`screens/compose/InlineReplyHost.tsx:196`). So this is harmless today. Delete it with the legacy code.

## 3. Import of 0.2.3 data: not needed

Plan 10 E2 specified an importer from a read-only `aplos.db`; none exists. The owner decided on 2026-11-18 that none is needed: Aplos has no users yet, and every 0.2.x GitHub release stayed a draft. A Mac with 0.2.x data starts fresh on the new engine; the old `aplos.db` and `google-tokens.enc.json` stay untouched, and the user signs in to Google again.

## 4. Update path from 0.2.3: not needed

For the same reason there is no 0.2.3 → new-engine migration to test. The first public release is the redesign.

## 5. Legacy deletion: missing

The legacy code is still there:

- `packages/engine/src/legacy`: 16 files, about 7,100 lines;
- `packages/contract/src/legacy`: 6 files, about 1,000 lines;
- `apps/desktop/src/renderer/legacy`: 57 files, about 28,400 lines;
- most of `apps/desktop/src/main`'s provider files (`google.ts`, `imap*.ts`, `jmap.ts`, `microsoft.ts`, `service.ts`, `store.ts` and others), which still import legacy modules.

Nothing blocks it now that there is no importer (item 3). It removes the `APLOS_ENGINE=legacy` hatch and the three legacy verify scripts with it. Size: L.

## 6. OAuth and keychain in release builds: partial

- **Client ID.** The order is `APLOS_GOOGLE_*` env, then `GOOGLE_*` env, then Settings, then the bundled client (`host/providers/oauth/client.ts:41-48`). A packaged non-test app loads `~/.config/aplos-mail/.env` (`main/lifecycle.ts:344-345`), so a release build does honour an env override. That matches `RELEASING.md`. Decide whether release should ignore it (S).
- **Keychain.** Both engines unwrap the same `engine-key.bin` through `loadDataKey`: `engine-real.ts:138` for the new one, `engine-host.ts:94` for the old. There is one keychain item, and no new keychain prompt on switching.
- **Sign-in return.** A loopback page hands off to `aplos://oauth-return?n=<nonce>`, which is checked against `<dataDir>/oauth-returns/` (`main/windows.ts:157`).
- **Tokens.** The new vault doesn't read the old token file, so a Mac with 0.2.x data signs in to Google again (accepted: no users, item 3).
- **Testing mode.** While the Google project stays in Testing mode, refresh tokens last 7 days, and the UI warns through `reconnectBy`.

## 7. Auto-updater: partial

The main side works on either engine. `startUpdates()` runs after the engine boots (`main/lifecycle.ts:359`). Updates are off for unsigned, unpackaged, DMG-run or translocated apps (`main/updates.ts:22-32`). The Update methods exist (`Update/status|check|restart|later`).

The new renderer never calls them or listens for the `update` event. The only way in is the menu's "Check for Updates…" (`main/menu-bar.ts:25`), which shows a native dialog.

*To do:* a calm "Update ready, Restart / Later" notice in the new UI and a Settings row (S). Plan 40's remaining release-pipeline items are unconfirmed from the repo: checksums or SBOM in `release.yml`, `release:local`, and a notarized build on record (M, needs the owner's secrets).

## 8. `!release` / `releaseBuild` gates: done

Each existing gate hides development tooling only, never a new feature:

- devtools (`windows.ts:141`, `menu-bar.ts:77`);
- the renderer URL override (`security.ts:93`);
- the engine override (item 1);
- developer hint text in the old Google and Microsoft adapters.

`registry.ts:855`'s `if (!release)` is a local variable, not a build gate. `import.meta.env.DEV` keeps the stand-in engine out of production (`renderer/main.tsx:137,167`). The outbox kill-points are compiled out by `__APLOS_TEST_MODE__`.

## 9. Account removal: missing (another agent is building it)

`Account/disconnect` always throws "Removing an account is not available yet." (`packages/engine/src/methods/account.ts:160-168`). The store side (`store/commit-account-remove.ts`) exists; the method doesn't call it yet.

## 10. Settings → Mail retention: partial

The setting exists: `RetentionSettings` (`packages/contract/src/schemas/settings.ts:107-113`), defaulting to 90 days and 2 GB (`packages/engine/src/runtime/settings.ts:51`), with a control in Settings → Mail (`renderer/screens/settings/sections/mail.tsx:127`).

Nothing enforces it:

- no code reads `bodyDays` or `maxBodyBytes`;
- `last_read_at` is never written (`migrations/0001_initial.ts:48`);
- there is no `incremental_vacuum`.

Either build the eviction job (M) or hide the control until it exists (S). Shipping a setting that does nothing is misleading.

## 11. Gmail live smoke → `provider-status.json`: missing

`apps/web/provider-status.json` doesn't exist and nothing writes it. Its reader exists (`apps/web/scripts/check-claims.mjs:73`), and the claim stays "pending". The live harness is in `apps/desktop/scripts/live/`, but no npm script or scheduled workflow runs it; `.github/workflows` has only `ci.yml` and `release.yml`.

*To do:* a small writer from the live probe's result, a script, and a schedule or an owner step (S–M).

## 12. Damaged-database path: missing

Plan 10 decision 6 says a damaged database should park the engine, keep the damaged file and offer three ways out: Export report, Restore backup and Rebuild. None of this exists:

- the store has no `integrity_check` and no `SQLITE_CORRUPT` handling;
- migrations only throw `MigrationError` or `SchemaTooNewError` (`store/index.ts:24,47`);
- the fatal screen offers only Try again and Export diagnostics.

Size: M.

## 13. Soak and fault injection: missing or partial

There is no soak harness: no `scripts/soak.ts` or equivalent, and no seven-day run.

Fault injection is partial. An HTTP fault kit exists for the emulators (`packages/emulators/src/kit/faults.ts`). The disk-full, flipped-byte `mail.db` and clock-backwards scenarios from plan 10 E8 item 2 don't exist.

Size: M–L, plus a week of the owner's time running the soak.

## 14. Release checks drive the legacy engine: partial

`verify-release.mjs`, the pre-release smoke on a packaged build, exercises the old engine through `state.get`. It is now pinned to `APLOS_ENGINE=legacy`. The new engine's packaged check is `verify-hardening-real-engine.mjs`. It covers only the first window, not mail, drafts, send-later and settings the way `verify-release.mjs` does. A real-engine equivalent of `verify-release.mjs` is needed before release (S–M).

## 15. "Allow tools on this Mac": hidden until the listener is built

There is no socket or loopback listener behind the toggle; `host/transports/` holds only `auth.ts` and `port.ts`. So it is not shown. The engine reports `listener`, `clients` and `queueInspector` as `false` (`packages/engine/src/methods/session.ts`), the desktop host adds none of them (`main/engine-utility.ts`), and Settings draws those rows only when their capability is on (`SHOW_UNBUILT_ROWS = false` in `settings.model.ts`). The same check keeps them out of the ⌘K palette. A test pins the three capabilities to `false` (`packages/engine/tests/methods/session-settings.test.ts`). `Listener/get|set` and `Clients/*` stay in the engine for contract stability. When the listener is built: report the capability from the host, and the rows appear with no UI change.

## 16. AI consent re-ask: not needed

Consent drift re-asks correctly (`ai/impl/consent-methods.ts:45-51`). The upgrade case from plan 10 decision 7 can't happen: there is no importer bringing 0.2.3 settings across (item 3). Nothing to do.

## 17. Version number: missing

The root and desktop `package.json` still say `0.2.3`. The redesign needs its own version before `npm run release` (S).

## 18. Seen while writing `verify:release:real` (fixed)

Two things looked broken on a packaged new-engine build with the demo mail. Both were real engine bugs, not artifacts of how the script called the engine: the script makes the same calls the renderer does (`Thread/open` from `ReaderLetter.tsx`, `Submission/set` with `notBefore` from the composer's `session.ts`), and both reproduced on the real composed engine (`compose.ts`) with no Electron.

- **`Thread/open` on a demo thread answered `internal`.** The demo dataset stored its threads as partial (`complete = 0`, the default for a new thread), so `Thread/open` asked the account's provider for the whole thread, and a demo account has none (`account demo-work is not started`). The reader calls `Thread/open` with `.catch(() => undefined)`, so the mail still showed and hands-on testing looked fine; the error was silent on every open. Fix: the demo dataset marks each thread complete (`packages/engine/src/ai/demo/data.ts`), since every demo message and body is stored locally.
- **A demo send never reached `sent`.** The new engine had no demo delivery: the real send port answers `accountNotStarted` for an account with no provider, which the outbox treats as a transient pause and re-asks forever (the row sat `queued`, then would have gone `suspended`). The legacy engine and the contract fixture both settle a demo send `sent` and file it in Sent, and the owner approved the send states on that behaviour. Fix: `withDemoDelivery` (`packages/engine/src/ai/demo/send.ts`) wraps the send port in the host composition. For a demo account it files the message in the account's own Sent folder as a complete thread (or in the thread it replies to) and answers the receipt; `findSent` reads the store. Real accounts reach the real port unchanged. Nothing leaves the Mac. The module is not imported by the engine core, so the startup bundle is unchanged (468,555 of 470,000 bytes).

Tests: `apps/desktop/tests/eng-contract/demo-real-path.test.ts` (the real composed engine over real MessagePorts: every demo inbox thread opens complete; a send with Undo reaches `sent`, shows in Sent, opens, and its draft leaves Drafts; both fail without the fix) and `packages/engine/tests/ai/demo-send.test.ts` (filed once on a retry, a reply joins its thread, `findSent`, real accounts pass through). `verify:release:real` now asserts both: the demo thread opens complete, and a send after Undo reaches `sent` and is in Sent; a second draft held for an hour still checks that a queued send survives a restart.

Not changed: demo drafts and triage stay local only, as before (there is no provider to sync them to).
