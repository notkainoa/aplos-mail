# Path ownership

Every path in the repo belongs to exactly one lane, and each lane belongs to one thread. A PR may touch only its own lane's paths. Need a change elsewhere? Post a REQUEST in [STATUS.md](STATUS.md) to the owning lane, or ask that lane to approve a cross-lane PR in writing on the PR. This file is built from roadmap section 2 ([00-roadmap.md](00-roadmap.md)); where they disagree, the roadmap wins and the integrator fixes this file. Only the integrator edits this file. `scripts/audit/owners-check.mjs` (lane `plat-ci`, built with the integrator) enforces it.

## How to read the table

- Globs are relative to the repo root. `**` matches any depth; `{a,b}` means either.
- **The most specific match wins.** A file matched by two globs belongs to the lane with the longer literal prefix. For example `apps/desktop/build/dmg-background.html` belongs to `web`, not to `plat-release`'s `apps/desktop/build/**`.
- **Root or app.** The plans write some tooling paths without a base folder (`scripts/audit/`, `tests/e2e/`, `tools/lint/`). Each such path is owned by the same lane whether it sits at the repo root or under `apps/desktop/`; both forms are listed.
- **Tests sit with their code.** A lane's tests go inside its own paths (for example `packages/engine/tests/store/**` for `eng-store`) or under `apps/desktop/tests/<lane>/**`, which that lane owns. Shared suites are listed below.
- **Unlisted means unowned.** A new path that matches nothing here fails the owners check. Ask the integrator to add it before the PR; the integrator records the choice as a DECIDED entry.
- **Phase 0 is the exception.** The restructure chain (roadmap 1.1, steps 1 to 4) moves and reformats files across every lane. Those commits are exempt from the owners check, they land in their slot only, and nobody else edits existing files until step 4 lands.

## Engine thread

| Lane | Paths |
|---|---|
| `eng-contract` | `packages/contract/**`, `packages/contract-fixture/**`, `packages/engine/package.json`, `packages/engine/tsconfig*.json`, `packages/engine/src/runtime/**`, `packages/engine/src/ports.ts`, `packages/engine/src/ports/**`, `packages/engine/src/{ports.walk,ports.review-answers}.md`, `packages/engine/src/methods/types.ts`, `packages/engine/src/methods/index.ts`, `packages/engine/src/methods/{session,settings,blob}.ts`, `packages/engine/src/diag/**` (except `diag/bundle/**`), `packages/engine/src/index.ts`, `apps/desktop/src/host/transports/port.ts`, `apps/desktop/src/host/logsink.ts`, `apps/desktop/src/main/{engine-host,engine-process,server,preload}.ts`, `apps/desktop/src/main/{engine-real,engine-utility}.ts` (the real engine path, contract-4), `apps/desktop/src/shared/event-hub.ts`, `apps/desktop/src/renderer/legacy/{Ask.tsx,summaries.ts}` (the legacy subscribers of the preload bridge: they must name their event types, Integrator DECIDED 2026-11-04), `apps/desktop/tests/eng-contract/**`, `apps/desktop/scripts/codemod-imports.mjs`, `packages/engine/tests/portability.test.ts`, `packages/engine/tests/*.ts` and `packages/engine/tests/{diag,methods,ports}/**` (engine tests not listed under another lane), `apps/desktop/tests/{logsink,test-mode}.test.ts` (Phase 0 F7/F8 tests; move under `apps/desktop/tests/<lane>/` when touched), `apps/desktop/src/shared/**` (the re-export stubs, removed in Phase 2) |
| `eng-store` | `packages/engine/src/store/**` (including `store/migrations/**` and `store/import/**`), `packages/engine/src/methods/data.ts`, `packages/engine/tests/store/**`, `packages/engine/bench/**`, `apps/desktop/src/host/{sqlite,codec,files}.ts`, `apps/desktop/scripts/{mailbox-benchmark.ts,verify-large-mailbox.mjs}` |
| `eng-views` | `packages/engine/src/views/**`, `packages/engine/tests/views/**`, `packages/engine/src/methods/{view,thread,operation,sender}.ts` |
| `eng-time` | `packages/engine/src/{outbox,clock}/**`, `packages/engine/tests/clock/**`, `packages/engine/tests/outbox/**`, `packages/engine/src/methods/{submission,draft,outbox,later,reminder,notification}.ts` |
| `eng-ai` | `packages/engine/src/ai/**`, `packages/engine/tests/ai/**`, `packages/engine/src/methods/{ai,ask,setup,demo,consent,queue}.ts`, `apps/desktop/src/host/ai/**`, `apps/desktop/tests/eng-ai/**`, today's `apps/desktop/src/main/{groq,llm,ollama,anthropic,ai-keys}.ts` until they move into `host/ai/`, `apps/desktop/scripts/{evaluate-groq.ts,ask-live.ts}`, `apps/desktop/scripts/quality/**` |
| `eng-html` | `packages/mail-html/**`, `apps/desktop/src/host/{protocol,proxy}/**`, `apps/desktop/src/main/protocol.ts`, `apps/desktop/src/main/mail-protocol.ts`, `packages/engine/src/methods/mail.ts`, `packages/engine/src/mail/**`, `packages/engine/tests/mail/**`, `apps/desktop/tests/eng-html/**` |
| `eng-host` | `apps/desktop/tests/eng-host/**`, `apps/desktop/src/host/reminders.ts`, `apps/desktop/src/host/compose.ts`, `apps/desktop/src/host/blobs.ts` (the host blob store, Integrator DECIDED 2026-11-04 03:45), `apps/desktop/src/main/{lifecycle,menu-bar,windows,native-methods,electron}.ts`, `apps/desktop/src/host/{lifecycle,menu-bar,power,lock,crash,notifications}.ts`, `apps/desktop/src/host/transports/{socket,http,auth}.ts`, `apps/desktop/src/main/test-mode.ts`, `apps/desktop/scripts/verify-resident.mjs`, `apps/desktop/src/host/{mcp,cli}/**`, `packages/engine/src/selftest.ts`, `packages/engine/tests/selftest.test.ts`, `packages/engine/src/diag/bundle/**`, `packages/engine/src/methods/{diagnostics,listener,clients}.ts`, `packages/engine/src/host/**`, `packages/engine/tests/host/**`, `apps/desktop/native/**`, `API.md` |

## Providers thread

| Lane | Paths |
|---|---|
| `prov-emu` | `packages/emulators/**`, `apps/desktop/scripts/live/**`, `scripts/smoke/probes/**`, `apps/desktop/scripts/smoke/probes/**`, `apps/desktop/scripts/{dev-emulated.ts,emulation/**}` |
| `prov-gov` | `packages/engine/src/sync/**`, `apps/desktop/src/main/vault.ts`, `apps/desktop/src/main/{keyring,durable-file}.ts`, `apps/desktop/tests/keyring.test.ts`, `apps/desktop/tests/vault-rollback.test.ts`, `apps/desktop/tests/prov-gov/**`, `packages/engine/tests/sync-*.ts`, `packages/engine/tests/sync/**`, `apps/desktop/src/host/providers/{shared,oauth}/**`, `packages/engine/src/methods/{account,sync}.ts`, today's `apps/desktop/src/main/{oauth-config,microsoft}.ts` until they move, `apps/desktop/scripts/oauth-defines.*` |
| `prov-gmail` | `apps/desktop/src/host/providers/google/**` (the `prov-gmail-write` and `prov-cal` files in that folder are more specific rows and win), `apps/desktop/tests/prov-gmail/**`, `packages/engine/src/methods/workflow.ts`, today's `apps/desktop/src/main/google.ts` until it moves |
| `prov-gmail-write` | `apps/desktop/src/host/providers/google/{send,drafts,filters,unsubscribe}.ts`, `packages/engine/src/methods/unsubscribe.ts` |
| `prov-cal` | `packages/engine/src/calendar/**`, `packages/engine/tests/calendar-*.ts`, `packages/engine/tests/calendar/**`, `packages/engine/tests/fixtures/calendar/**`, `packages/engine/scripts/recurrence-oracle/**` (corpus generator, never bundled), `apps/desktop/src/host/providers/google/calendar*.ts`, `apps/desktop/tests/prov-cal/**`, `packages/engine/src/methods/event.ts` |
| Round 2 (reserved, nobody edits this round) | `prov-imap`: `apps/desktop/src/host/providers/imap/**`; `prov-jmap`: `apps/desktop/src/host/providers/jmap/**`; `prov-graph`: `apps/desktop/src/host/providers/microsoft/**`; the CalDAV half of PV8: `apps/desktop/src/host/providers/caldav/**`. Today's `apps/desktop/src/main/{imap,imap-index,imap-session,jmap,caldav,ical}.ts` stay untouched as reference (`microsoft.ts` moved to prov-gov's "until it moves" row when integrator approved a one-word copy fix in #504). |

## UI-core thread

| Lane | Paths |
|---|---|
| `ui-foundation` | `apps/desktop/src/renderer/{ui,commands}/**`, `scripts/design/**`, `apps/desktop/scripts/design/**`, `tools/lint/design/**`, `apps/desktop/tools/lint/design/**`, `.claude/skills/aplos-design/**`, `tests/{visual,perf}/**`, `apps/desktop/tests/{visual,perf}/**`, `apps/desktop/assets/fonts/**`, `scripts/check-contrast.mjs` and `apps/desktop/scripts/check-contrast.mjs` (with its reference colour list), `stylelint.config.*`, `.stylelintrc*`, `stylelint-suppressions.json`, `apps/desktop/stylelint.config.*`, `apps/desktop/.stylelintrc*`, `apps/desktop/src/renderer/spelling.test.ts` (the renderer-wide copy spelling check, copy quality like the design lint tools) |
| `ui-shell` | `apps/desktop/src/renderer/{data,shell,motion}/**`, `apps/desktop/src/renderer/{App,main}.tsx`, `apps/desktop/src/renderer/{entry,entry.test,onboardingPorts}.ts`, `apps/desktop/src/renderer/bridge{,.test}.ts`, `apps/desktop/src/renderer/legacyBanner{,.test}.ts`, `apps/desktop/index.html`. In Phase 0 `ui-foundation` writes the data-hook signatures in `renderer/data/**` as part of F9; from the freeze on the folder is `ui-shell`'s. |
| `ui-home` | `apps/desktop/src/renderer/screens/{home,later,lists,done}/**`, `apps/desktop/tests/ui-home/**`, `apps/desktop/src/renderer/screens/screens.css`, `apps/desktop/src/renderer/screens/undoOperation.ts`, `apps/desktop/src/renderer/screens/CommitTemplates.tsx` |
| `ui-reader` | `apps/desktop/src/renderer/screens/{reader,compose}/**`, `apps/desktop/src/renderer/mailframe/**`, `apps/desktop/src/renderer/screens/cardStyle.ts`, `apps/desktop/tests/compose-undo-engine.test.ts`, `apps/desktop/src/renderer/legacy/mailBody.ts`, `apps/desktop/src/renderer/legacy/browser/**` (the shipped reader's body gate and its browser spec, for approved fixes like improve-001) |

## UI-screens thread

| Lane | Paths |
|---|---|
| `ui-onboard` | `apps/desktop/src/renderer/onboarding/**`, `apps/desktop/tests/ui-onboard/**`, `apps/desktop/src/main/windows/onboarding.ts` |
| `ui-calendar` | `apps/desktop/src/renderer/screens/calendar/**` |
| `ui-settings` | `apps/desktop/src/renderer/screens/settings/**` |
| `ui-ask` | `apps/desktop/src/renderer/screens/{ask,today,palette,search}/**`, `apps/desktop/scripts/ui-ask-capture.mjs` |

## Platform and website thread

| Lane | Paths |
|---|---|
| `plat-ci` | `.github/workflows/ci.yml`, `knip.json`, `.dependency-cruiser.cjs`, `stryker.config.mjs`, `tools/lint/**` and `apps/desktop/tools/lint/**` (except `design/`), `tests/e2e/**`, `apps/desktop/tests/e2e/**`, `budgets.json`, `scripts/audit/**`, `apps/desktop/scripts/audit/**`, `scripts/smoke/**` and `apps/desktop/scripts/smoke/**` (except `probes/`), `eslint.config.*`, `.prettierrc*`, `.prettierignore`, `.editorconfig`, the pre-commit hook files, `.git-blame-ignore-revs`, `.gitignore`, `.gitattributes` (which marks `plans/STATUS.md` `merge=union`), the root `package.json` (scripts and devDependencies), `apps/desktop/package.json`, `tsconfig*.json`, `apps/desktop/tsconfig*.json`, `apps/desktop/vite.config.ts`, `apps/desktop/scripts/{build-main.mjs,launch.mjs}`, `scripts/launch.mjs`, `scripts/local-ci.sh`, `tests/{policy,evals}/**` and `apps/desktop/tests/{policy,evals}/**` (plan 40 Q4), `.github/dependabot.yml`, `.node-version`, `eslint-suppressions.json`, `scripts/hooks/**`. In Phase 0 the Engine thread edits the build wiring in step 1 (workspaces, tsconfig paths, the Vite alias, esbuild bundling `@aplos/*`) and F8 writes the first `tests/e2e/playwright.config.ts`. |
| `plat-release` | `apps/desktop/build/**` (except `dmg-background.html`), `apps/desktop/assets/**` (except `fonts/`), `apps/desktop/src/main/{security,updater}.ts`, today's `apps/desktop/src/main/updates.ts` until it moves, `.github/workflows/release.yml`, `scripts/release.mjs`, `apps/desktop/scripts/{verify-release,release-build,build-options,fake-update-feed,build-icon}.mjs`, `apps/desktop/scripts/build-options.d.mts`, `apps/desktop/scripts/build-dmg-background.cjs`, `apps/desktop/scripts/verify-hardening*.mjs`, `apps/desktop/scripts/{verify-draft,notices}.mjs`, `apps/desktop/build/entitlements.adhoc.plist` (already inside `apps/desktop/build/**`), `apps/desktop/tests/plat-release/**`, `docs/release-notes-template.md`, `apps/desktop/dev-app-update.yml`, `RELEASING.md`, `THIRD_PARTY_NOTICES*`, `LICENSE`, `docs/release-checklist.md` |
| `web` | `apps/web/**`, `apps/desktop/build/dmg-background.html` |

## Integrator

| Owner | Paths |
|---|---|
| `integrator` | `plans/**` (except `plans/STATUS.md`, below, and each thread's own planning folder: `plans/engine/**` to `eng-contract`, `plans/providers/**` to `prov-gov`, `plans/ui-core/**` to `ui-foundation`, `plans/ui-screens/**` to `ui-onboard`, `plans/platform/**` to `plat-ci`), `AGENTS.md`, `README.md`, `SPEC.md`, `VISION.md`, `MOBILE.md`, `.env.example` (lanes request new key names; the file never holds a value), `.github/**` not listed above, any new top-level folder or new workspace under `packages/`, `packages/.gitkeep`, the root `vercel.json` (the `aplos-mockups` Vercel project's deploy settings; `apps/web/vercel.json` is `web`'s), `mockups/**` (read-only visual target: only the integrator edits it, and only to record an owner decision that changes the target, each edit called out in DECISIONS; first used for the 2026-11-13 no-dots decision in #518) |

## Shared files

| File | Rule |
|---|---|
| `plans/STATUS.md` | Append-only for every thread, pushed straight to `revamp` (header of that file). The root `.gitattributes` marks it `merge=union`, so two branches that both append merge with both sides kept and no conflict; lines are never edited in place (a correction is a new line). |
| `PROGRESS.md`, `DECISIONS.md`, `TODO.md` | Append-only for every lane. Add your section at the end in your PR; never rewrite or reorder others' text. On a merge conflict keep both sides. `ui-foundation`'s retirement of the old "match the reference" decisions is done by appending a superseding entry, not by deleting the old one. |
| `package-lock.json` | Changes only together with a manifest change in the same PR. On conflict, take `revamp`'s lockfile and re-run `npm install`; never hand-merge it. |
| `apps/desktop/package.json`, root `package.json` | `plat-ci` owns them. A lane that needs a dependency or a script adds it in its own PR with `plat-ci`'s written approval on the PR, or asks `plat-ci` with a REQUEST. A package's own `package.json` under `packages/<name>/` belongs to that package's lane. |
| `AGENTS.md` | `ui-foundation` adds the design rule from plan 30 U0 by PR; the integrator approves. |
| Legacy folders: `packages/engine/src/legacy/**`, `packages/contract/src/legacy/**`, `apps/desktop/src/renderer/legacy/**`, and today's files left in `apps/desktop/src/main/` | Read-only reference after the restructure. A lane edits a legacy file only when it moves that file's code into its own paths. The integrator deletes them in Phase 2 with each owning lane (roadmap 2.6). |
| Today's tests, `apps/desktop/tests/*.test.ts` and `apps/desktop/tests/fixtures/**` | Kept green as long as their legacy code exists. Edited only by the restructure and by the lane that replaces the code under test; deleted in Phase 2 with that code. |
| `research/**` | Read-only reference. Nobody edits it in this round. (`mockups/**` is the integrator's row above: an owner-decision edit only.) |
| `packages/engine/src/methods/<area>.ts` not listed above | F5 creates one stub per contract area. If F5 adds an area this file does not name, `eng-contract` names the owning lane in its PR and the integrator adds it here. |

## Owner pings

OWNER PINGS. The owner gets a phone ping ONLY when something needs them. Any thread that posts READY-FOR-OWNER or WAITING ON OWNER (STATUS line or chat) ALSO runs, if on the owner's Mac: `~/.config/aplos-owner-ping.sh ready|waiting "<thread title>" "<one-line summary>"` (it POSTs `{kind,thread,summary}` to the owner webhook, reads the URL and key from `~/.config/aplos-owner-webhook.env`, dedupes within 1h). Threads on other machines (Linux) cannot reach the secret: they post the STATUS line and the orchestrator pings. NEVER ping for progress, merges, PRs, bugs found, reviews or status. NEVER print, log, copy or commit the URL or key; do not put them in any file in the repo, STATUS, PR or chat.

