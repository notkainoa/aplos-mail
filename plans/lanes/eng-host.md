# Lane card: eng-host (parked until PR #43 merges and a slot frees)

**Goal.** Resident mode (window closes, Aplos stays in the menu bar; lock, wake, self-test) and window hooks for onboarding; later the tool doorway (socket, loopback HTTP, clients, scopes, diagnostics, MCP, CLI). Owner reviews feature 11.

**Owned paths:** `apps/desktop/src/main/{lifecycle,menu-bar,windows,native-methods,electron,test-mode}.ts`, `apps/desktop/src/host/{lifecycle,menu-bar,power,lock,crash}.ts`, `apps/desktop/src/host/transports/{socket,http,auth}.ts`, `apps/desktop/src/host/{mcp,cli}/**`, `apps/desktop/scripts/verify-resident.mjs`, `packages/engine/src/selftest.ts`. Keep `lifecycle.ts` importing `./security` first (platform request).

**Read:** `plans/engine/HANDOFF.md`; `plans/engine/phase1-lanes.md` lines 527-608.

**State.** PR #43 `rv/eng-host/quit-race` @ 40735c4. WIP branches: `onboarding-hooks` @ 0b2fd28 (smoke spec never ran green), `resident-mode` @ 2a26bef, `selftest` @ 1cef858, `doorway-transports` @ bca4026. Open platform REQUEST: test mode must quit on SIGTERM within seconds.

**Tests.** `npx tsx --test 'apps/desktop/tests/eng-host/**/*.test.ts'`; `npx tsx --test packages/engine/tests/selftest.test.ts`; `APLOS_TEST=1 APLOS_DATA_DIR=<abs tmp> node apps/desktop/scripts/verify-resident.mjs` on a packaged build; `npm run check`.
