# Go-live audit: shipping revamp in a release build

Written 2026-11-18 on `revamp` at `8f1eb4cd0`, together with the engine switch in the same PR. Each item says whether it is done, missing or partial, where the evidence is, and roughly how much work is left: S is under a day, M is one to three days, L is more.

## In plain English

The owner's final test ran a development build started with `APLOS_ENGINE=real`. Until this PR, a release build always ran the old engine and the old screens, so the redesign would have shipped turned off.

This PR makes the new engine the default in every build. There is one exception. A Mac that still has 0.2.3 mail (`aplos.db`) and no new `mail.db` keeps the old engine. Nothing moves `aplos.db` into the new store yet. On such a Mac the new engine would open empty, and that Mac's accounts, local drafts, scheduled sends, Later, reminders and settings would seem to disappear. The old file would be untouched, but the user would not know that.

So a fresh install gets the redesign, and an existing 0.2.3 user stays on the old version, with a one-line banner, until the importer exists. **The importer is the one blocker for upgrading existing users.** The new engine also supports only Gmail, so 0.2.3 Outlook, IMAP and Fastmail accounts have nowhere to go yet.

## Summary

| # | Item | Status | Size left |
|---|---|---|---|
| 1 | Engine switch in release builds | Done in this PR (with the 0.2.3 hold) | — |
| 2 | What the new UI needs from the legacy engine | Done (nothing reachable) | — |
| 3 | Import of a 0.2.3 user's `aplos.db` | **Missing: blocks moving 0.2.3 users** | L |
| 4 | Update path from 0.2.3 | Partial: safe, but upgraders stay on the old version | L (same as 3), plus S for a second-Mac test |
| 5 | Legacy code deletion | Missing; can't start until 3 lands | L |
| 6 | OAuth and keychain in release builds | Partial | S, or M with token migration |
| 7 | Auto-updater | Partial: works in main, no notice in the new UI | S |
| 8 | `!release` / `releaseBuild` gates | Done: none hides a new feature | — |
| 9 | Account removal | Missing (another agent is on it) | S–M |
| 10 | Settings → Mail retention | Partial: the control exists, nothing enforces it | M |
| 11 | Gmail live smoke → `apps/web/provider-status.json` | Missing | S–M |
| 12 | Damaged-database path | Missing | M |
| 13 | Soak and fault injection | Missing soak, partial faults | M–L |
| 14 | Release checks still drive the legacy engine | Partial | S–M |
| 15 | "Allow tools on this Mac" (local listener) | Partial: toggle only, no listener | M if it must ship |
| 16 | AI consent re-ask on upgrade | Partial: nothing to re-ask without 3 | S after 3 |
| 17 | Version number | Missing: still `0.2.3` | S |

## 1. Engine switch: done in this PR

`realEngineRequested` (`apps/desktop/src/host/transports/port.ts:80-88`) now answers "real engine" by default in every build. It answers "legacy" only when the data folder has `aplos.db` or `state.json` and no `mail.db`. `engine-host.ts:31-41` checks those files; it only tests whether they exist and never opens them. Once `mail.db` exists, the folder stays on the new engine.

**Escape hatch kept, outside release builds only.** `APLOS_ENGINE=legacy` and `APLOS_ENGINE=real` still override the rule in development and local `npm run package` builds. A release build ignores both, as it already ignores `APLOS_TEST` and `APLOS_DATA_DIR`, so nothing outside the app can change which engine runs.

- *Why keep it:* several checks still drive the old engine through `state.get`: `verify-release.mjs`, `verify-resident.mjs` and `verify-large-mailbox.mjs`. Hand-checks also sometimes need to compare old and new behaviour. These checks are now pinned to `APLOS_ENGINE=legacy`. The hatch goes away with the legacy code (item 5).
- *Why not in release:* a release user can't set the variable usefully, and `=real` on a 0.2.3 folder would hide their data.

Everything else keys off `realPath`, which follows the new rule: preload's bridge argument (`windows.ts:146`), the welcome window (`windows.ts:370`), the mail scheme, power, quit and the tray. Test mode always starts on a fresh temp folder, so it now runs the new engine by default. "Try demo mail" is `Demo/load` on whichever engine runs, and needs no change.

In a production build the legacy banner no longer tells users to set `APLOS_ENGINE=real` (`renderer/legacyBanner.ts`). It says the old version stays until their mail can move.

## 2. What the new UI needs from the legacy engine: done

The new renderer calls no legacy method; `window.aplos` is used only for close, navigate and menu events (`renderer/main.tsx:91,117`).

Pop-out windows (`?draft=` / `?thread=`) still boot the legacy renderer (`renderer/entry.ts:66-67`), and on the new engine that renderer is refused every call (`engine-real.ts:253-263`). Nothing in the new UI opens one: its "pop out" goes to the in-window compose page (`screens/compose/InlineReplyHost.tsx:196`). So this is harmless today. Delete it with the legacy code.

## 3. Import of 0.2.3 data: missing (the blocker)

Plan 10 E2 "The import" specifies a resumable importer from a read-only `aplos.db`. No such code exists. The search terms `importer`, `import_state`, `imported_from` and `import_done` turn up only a comment (`host/sqlite.ts:12`), a reserved meta key (`store/port.ts:430`) and a log event name (`contract/src/log/events.ts:348`).

What a 0.2.3 user has and the new engine doesn't read:

- mail, accounts, drafts, scheduled sends, workflow state (Later, reminders, to-dos, statuses), settings and blocked senders, all in `aplos.db` (`main/store.ts:64-66`);
- Google tokens in `google-tokens.enc.json` (`main/google.ts:253`). The new vault is `google-tokens.v2.enc.json` (`engine-utility.ts:138`).

The new engine also has only a Gmail provider. Outlook, IMAP and Fastmail are marked "arrives in a later version" (`packages/engine/src/methods/session.ts:15-21`), so the importer needs a rule for those accounts too.

*Smallest next step:* import accounts, settings, sender rules, local drafts and scheduled sends, and workflow state. Let Gmail re-sync the mail itself. Ask non-Gmail users before moving them, or keep them on legacy. Size: L (plan 10 estimated two agents by table family, plus the kill-mid-import and rollback tests).

## 4. Update path from 0.2.3: partial

0.2.3 updates through `electron-updater` from GitHub releases (`apps/desktop/package.json:157-163`). After the update, the folder still has `aplos.db` and no `mail.db`, so the app keeps the old engine. Nothing is lost, and the user sees the old screens with the banner.

When the importer lands, the rule in item 1 changes to "import, then switch". Plan 10 E8 item 6 also needs doing then: the second-Mac update test, an update interrupted mid-import, and a rollback to 0.2.3. None of it has been run.

## 5. Legacy deletion: missing

The legacy code is still there:

- `packages/engine/src/legacy`: 16 files, about 7,100 lines;
- `packages/contract/src/legacy`: 6 files, about 1,000 lines;
- `apps/desktop/src/renderer/legacy`: 57 files, about 28,400 lines;
- most of `apps/desktop/src/main`'s provider files (`google.ts`, `imap*.ts`, `jmap.ts`, `microsoft.ts`, `service.ts`, `store.ts` and others), which still import legacy modules.

Deleting it before the importer would leave 0.2.3 users with no working app, so this waits for item 3. Size: L.

## 6. OAuth and keychain in release builds: partial

- **Client ID.** The order is `APLOS_GOOGLE_*` env, then `GOOGLE_*` env, then Settings, then the bundled client (`host/providers/oauth/client.ts:41-48`). A packaged non-test app loads `~/.config/aplos-mail/.env` (`main/lifecycle.ts:344-345`), so a release build does honour an env override. That matches `RELEASING.md`. Decide whether release should ignore it (S).
- **Keychain.** Both engines unwrap the same `engine-key.bin` through `loadDataKey`: `engine-real.ts:138` for the new one, `engine-host.ts:94` for the old. There is one keychain item, and no new keychain prompt on switching.
- **Sign-in return.** A loopback page hands off to `aplos://oauth-return?n=<nonce>`, which is checked against `<dataDir>/oauth-returns/` (`main/windows.ts:157`).
- **Tokens.** The new vault doesn't read the old token file (item 3), so a moved 0.2.3 user signs in to Google again unless the importer migrates tokens (M).
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

## 15. "Allow tools on this Mac": partial

The toggle exists and is off by default (`packages/engine/src/methods/listener.ts:11-17`), matching plan 10 decision 5. There is no socket or loopback listener behind it; `host/transports/` holds only `auth.ts` and `port.ts`. Hide the toggle or build the listener (M).

## 16. AI consent re-ask: partial

Consent drift re-asks correctly (`ai/impl/consent-methods.ts:45-51`). The upgrade case from plan 10 decision 7 can't happen until the importer brings 0.2.3 settings across, so this is an S item that comes after item 3.

## 17. Version number: missing

The root and desktop `package.json` still say `0.2.3`. The redesign needs its own version before `npm run release` (S).
