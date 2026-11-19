# End-to-end tests

One Playwright base for every headless UI check (plans/40-platform-quality.md Q3). Run everything
from the repo root.

```
npm run test:e2e            # both projects
npm run test:e2e:browser    # browser preview only
npx playwright install chromium   # once; downloads to the user cache
```

| Project | Matches | What it drives |
|---|---|---|
| `browser` | `**/*.browser.spec.ts` | The renderer's browser preview (`npm run dev -w @aplos/desktop`), started by the config on its own ports with demo data |
| `electron` | `**/*.electron.spec.ts` | The built app (`apps/desktop`, `npm run build` first) through `support/electron.ts`; no browser |

Specs are matched both here and under a lane's own folder, `apps/desktop/tests/<lane>/`; keep the
file-name suffix (`*.browser.spec.ts` or `*.electron.spec.ts`) so the right project picks it up.

`smoke.electron.spec.ts` is skipped unless `APLOS_E2E_ELECTRON=1`. It turns on once F8 lands: main
honouring `APLOS_TEST=1` and `APLOS_DATA_DIR` (isolated data, no single-instance lock, no Dock or
menu-bar item, windows created hidden). Until then launching Electron would open a visible window.
The gate lives in `launchAplos()` itself, which throws unless `APLOS_E2E_ELECTRON=1` and the built
main contains `APLOS_TEST`, so a new Electron spec cannot launch the app by accident.

## Isolation rules

- **Headless, Chromium only.** Never a visible window. `--headed`, `--debug`, `--ui` and
  `PWDEBUG` are refused by `base.config.ts` (use `npx playwright show-trace` on a failure).
  Electron specs call `assertNoVisibleWindows()`; `launchAplos()` already checks once after launch.
- **Temp data directory.** The preview runs with `APLOS_DATA_DIR` set to a fresh `mkdtemp`
  directory that is removed when the run ends. `launchAplos()` does the same per launch and
  `cleanup()` closes the app and deletes it. `launchAplos()` also passes a temp `--user-data-dir`
  and checks `app.getPath('userData')` is inside it, so the single-instance lock, caches and local
  storage are not the real app's. The real data directory is never used.
- **Own ports.** The preview listens on `APLOS_E2E_PORT` (default 4417) and its loopback API on
  `APLOS_E2E_API_PORT` (default the preview port + 1). The config never reuses a server that is
  already running, so a developer's preview with real data cannot be picked up by mistake.
- **No AI keys.** The AI key variables are blanked for the preview server (dotenv does not override
  an existing variable, so a local `.env` stays unread) and for Electron. A scenario that
  needs AI injects a mock provider.
- **Loopback only.** Use `support/network.ts`: `await trackRequests(page)` before `goto`, then
  `external()` (requests and WebSockets that were sent) and `blocked()` (attempts the page's CSP
  stopped; Chromium emits no request event for those, so they are read from
  `securitypolicyviolation`) must both be empty. `attempts()` is both lists together.
- **Fixed environment.** `en-US`, UTC, reduced motion, 1280x800. Retries are 1 in CI and 0 locally.
  When a test depends on time, freeze it with `page.clock.install({ time })` before `goto`.
- **Output** goes to `artifacts/e2e/` (git-ignored): `results.json` and `test-results/`.

## Extending the base (UI-core's `tests/visual`)

`base.config.ts` exports the shared settings: `baseConfig` (reporters, retries, output directory),
`baseUse` (locale, time zone, viewport, reduced motion, headless), `browserPreviewServer()`,
`previewUrl` and `wantsBrowserPreview()`. A harness config spreads them and adds its own projects:

```ts
import { defineConfig } from '@playwright/test';
import { baseConfig, baseUse, browserPreviewServer, previewUrl } from '../e2e/base.config';

export default defineConfig({
  ...baseConfig,
  testDir: '.',
  projects: [{ name: 'visual', use: { ...baseUse, browserName: 'chromium', baseURL: previewUrl } }],
  webServer: browserPreviewServer(),
});
```

Type-check the specs with `node_modules/.bin/tsc -p tests/e2e/tsconfig.json`.
