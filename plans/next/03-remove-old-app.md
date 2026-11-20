# Job 3: remove the old screens and the old engine

## In plain English

Since 0.0.1 every build runs the new engine and the new screens. The old ones are still in the repository: about 35,000 lines that nothing a user can reach depends on. This job deletes them. The old Outlook, iCloud and Fastmail code goes too, but it is not lost: the commit before the deletion is tagged `legacy-final`, and a short note lists where each provider's code was, so it can be read when those providers are ported.

`plans/GO-LIVE.md` items 2, 5 and 14 describe what is left and why nothing blocks it.

## What to remove, as three pull requests

**A. Old screens and pop-out windows**
- `apps/desktop/src/renderer/legacy/` and everything that only it uses.
- The pop-out path: `?draft=` and `?thread=` in `apps/desktop/src/renderer/entry.ts` (`wantsLegacy`) and `popout()` in `apps/desktop/src/main/windows.ts`. The new screens never open one.
- The legacy fallback and its banner (`renderer/legacyBanner.ts`). When the engine bridge cannot connect, the app shows the existing fatal screen instead.

**B. Old engine and its host**
- `packages/engine/src/legacy/`, and the legacy files in `apps/desktop/src/main/` (`service.ts`, `store.ts`, `google.ts`, `imap*.ts`, `jmap.ts`, `microsoft.ts`, `caldav.ts`, `groq.ts`, `ollama.ts`, `llm.ts`, `workflow-sync.ts` and any other file that imports `@aplos/engine/legacy/*`).
- The `APLOS_ENGINE=legacy` escape hatch (`realEngineRequested` in `apps/desktop/src/host/transports/port.ts`, `serveLegacy` in `main/engine-process.ts`) and the legacy bridge in `preload.ts`.
- The three scripts that drive the old engine: `scripts/verify-release.mjs`, `verify-resident.mjs`, `verify-large-mailbox.mjs`, with their npm scripts. `verify-release-real.mjs` stays.
- The tests that only test the old engine, including the five named in the root `test:engine` script.

**C. Old contract types and the documents**
- `packages/contract/src/legacy/` and `legacy-methods.ts`.
- Bring `README.md`, `API.md`, `SPEC.md` (the implementation boundaries section) and the root `AGENTS.md` layout paragraph in line with what now exists. Delete `MOBILE.md` if nothing it describes is left.
- Write `plans/next/legacy-providers.md`: for Outlook, iCloud/IMAP, Fastmail/JMAP and CalDAV, the file paths at tag `legacy-final`, and one paragraph each on what worked and what was only ever tested against fake servers.

## Rules for this job

- Before deleting a file, show that nothing reachable from the new app imports it (the dependency-cruiser rule `no-legacy-imports` and `knip` help).
- If the new app does depend on a legacy file, stop and report it. Do not move code across to make the deletion work.
- Remove matching entries from `eslint-suppressions.json`, `stylelint-suppressions.json`, `knip.json`, `.dependency-cruiser.cjs`, `budgets.json` and `plans/OWNERS.md` as paths disappear.
- You cannot run the packaged Mac app. Say in each pull request that a Mac check is still owed: `npm run package -w @aplos/desktop && npm run verify:release:real`.

## Done when

- No folder named `legacy` is left under `apps/` or `packages/`, and `grep -r "legacy/" --include='*.ts*' apps packages` finds no import.
- `npm run check` passes, and CI is green including the macOS job.
- The pull requests state the number of lines removed.
