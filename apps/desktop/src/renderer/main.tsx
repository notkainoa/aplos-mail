/**
 * The renderer entry (F9; plan 30 4.1 build order step 1).
 *
 * In a development build it boots the new app on the stand-in engine (F6) in-process, on the `demo` scenario
 * (`?scenario=<name>` picks another, dev only), installs the data layer on it and mounts `<App/>` with the one
 * stylesheet and the shell's layout. With `?window=onboarding` — the query main gives the welcome window, and
 * the browser-preview route "Try demo mail" and "Show welcome" navigate to — it mounts `onboarding/OnboardingApp`
 * on the same stand-in switch and the same data layer, never a separate engine.
 * Today's renderer stays reachable: `VITE_APLOS_LEGACY=1` or `?legacy=1` loads `./legacy/main` instead, and so does a
 * production build without the real engine's bridge, because no release ships stand-in data (plan 30 4.1 release
 * rule). When preload exposes `window.aplosEngine` (main's real-engine path, the default in every build; see
 * `realEngineRequested`) the new roots connect over `bridge.ts` in any build; only a development build without it uses the in-process
 * stand-in. A production build whose bridge fails to connect falls back to the legacy renderer, never to stand-in
 * data. The browser preview's tokenised HTTP and SSE transport is still to come.
 *
 * `entry.ts` holds the rule: the onboarding window (`?window=onboarding&mode=first|review`, as main loads it) boots
 * `OnboardingApp` (on a fresh install, the `empty` scenario, when it runs on the stand-in) with `onboarding.css` after
 * the one stylesheet; every other window boots `App`.
 *
 * Everything the new app needs is imported on its own path, so the legacy path loads none of it (no new stylesheet,
 * no fixture, no zod) and the mail window loads none of the onboarding window's.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { chooseEntry, hasBridgeShape, onboardingMode, transportOf, type EntryInput } from './entry';
import { legacyBannerText, mountLegacyBanner } from './legacyBanner';
import { answerPrepareClose } from './shell/closeHandshake';
import { startSystemTheme } from './shell/theme';
import { scenarioParam } from './onboarding/route';
import type { Client, EngineSession } from '@aplos/contract/client';
import type { DataConnection } from './data/connect';
import type { StandInOptions } from './data/standin';

const hook = (globalThis as { __aplosWindowKind?: string }).__aplosWindowKind;
const input: EntryInput = {
  search: window.location.search,
  dev: import.meta.env.DEV,
  legacyEnv: import.meta.env.VITE_APLOS_LEGACY === '1',
  bridge: hasBridgeShape(),
  ...(hook ? { hook } : {}),
};
const entry = chooseEntry(input);

const scenario = scenarioParam(window.location.search) as StandInOptions['scenario'];

/**
 * The data layer on the real engine, when `entry.ts`'s rule allows it and the preload exposed
 * `window.aplosEngine`: one bridge session for the layer and a second for `App`'s client, as the stand-in path's
 * second `engine.connect()` gives it. `bridge.ts` loads only on this path, so the legacy renderer never sees it.
 * Any failure — a missing chunk, a refused bridge, a throwing `connectDataLayer` — answers null after closing
 * every session it opened, so the caller still falls back to the stand-in.
 */
async function connectEngine(): Promise<{ layer: DataConnection; client: Client } | null> {
  const opened: EngineSession[] = [];
  try {
    const [{ createEngineBridge, hasEngineBridge }, { connectDataLayer }, { createClient }] =
      await Promise.all([
        import('./bridge'),
        import('./data/connect'),
        import('@aplos/contract/client'),
      ]);
    if (transportOf({ ...input, bridge: hasEngineBridge() }) !== 'engine') return null;
    const session = createEngineBridge();
    if (!session) return null;
    opened.push(session);
    const second = createEngineBridge();
    if (!second) return null;
    opened.push(second);
    const engine = { layer: connectDataLayer({ session }), client: createClient(second) };
    opened.length = 0; // The caller owns the sessions now; the finally must not close them.
    return engine;
  } catch {
    return null;
  } finally {
    for (const session of opened) session.close();
  }
}

/** Stops the close answer; a fallback to the legacy renderer, which answers `prepare-close` itself, calls it. */
let stopCloseAnswer: () => void = () => undefined;

/**
 * Answers main's `prepare-close` (main keeps the window disabled until it hears `Window/closeReady`). Installed the
 * moment the engine connects, before any chunk loads, so a window that is still loading or shows the fatal screen
 * can be closed. The listener is typed (`only: ['prepare-close']`), so it never takes the deep-link and command events
 * held for the app's own first plain subscribe, and it comes from a static import: the chunks it needs load when a
 * close comes, and a chunk that fails there is an unsaved answer, not a window left disabled.
 */
function serveClose(kind: 'mail' | 'onboarding'): void {
  const data = () => import('./data');
  stopCloseAnswer = answerPrepareClose(window.aplos, {
    save:
      kind === 'mail'
        ? async () =>
            (await import('./screens/compose/runtime/useComposeSession')).flushComposeSessions()
        : async () => 'saved',
    ready: async () => (await data()).api.window.closeReady(),
    cancel: async () => (await data()).api.window.closeCancel(),
    notify: message => {
      void import('./shell')
        .then(({ pushToast }) =>
          pushToast({ id: 'close-held', kind: 'info', message, undoable: false }),
        )
        .catch(() => undefined);
    },
  });
}

/** Main may ask the mail window to open a screen (first sync's "Open Settings"); typed, so it never takes held app events. */
async function serveNavigate(): Promise<void> {
  const [
    { listenMainNavigate },
    { listenMenuCommands },
    { listenUpdates },
    { openRoute, runShellCommand, pushToast, dismissToast },
    { api },
  ] = await Promise.all([
    import('./shell/mainNavigate'),
    import('./shell/menuCommands'),
    import('./shell/updateNotice'),
    import('./shell'),
    import('./data'),
  ]);
  listenMainNavigate(window.aplos, openRoute);
  listenMenuCommands(window.aplos, runShellCommand);
  // "Update ready · Restart": main downloads quietly and tells every window; nothing installs until Restart.
  listenUpdates(window.aplos, api.update, { push: pushToast, dismiss: dismissToast });
}

/** The mail window's stylesheets: the one sheet, the shell, the screens, then the zero-accounts pane's wrappers. */
async function loadMailStyles(): Promise<void> {
  await Promise.all([
    import('./ui/styles.css'),
    import('./shell/shell.css'),
    import('./screens/screens.css'),
  ]);
  // The mail window hosts lane pieces now (the zero-accounts pane): the lane's own wrappers come after
  // the one stylesheet, the same order the onboarding window and the preview gallery keep.
  await import('./onboarding/onboarding.css');
}

async function boot(): Promise<void> {
  // Connect first: a production build that falls back to the legacy renderer must not have loaded the new stylesheets.
  const engine = await connectEngine();
  // Stand-in data is a development build's alone: a release never fetches the fixture.
  if (!engine && !import.meta.env.DEV) return bootLegacy(true);
  startSystemTheme();
  if (engine) serveClose('mail');
  const [{ App }] = await Promise.all([import('./App'), loadMailStyles()]);
  if (engine) {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App client={engine.client} />
      </StrictMode>,
    );
    return serveNavigate().catch(() => undefined);
  }
  const [{ connectStandInDataLayer }, { createClient }] = await Promise.all([
    import('./data/standin-layer'),
    import('@aplos/contract/client'),
  ]);
  // The data layer (hooks and `api`) and a second client on the same engine for the Home boot proof.
  const layer = connectStandInDataLayer({ scenario });
  const client = createClient(layer.engine.connect());
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
  return serveNavigate();
}

async function bootOnboarding(): Promise<void> {
  // The onboarding window needs only the data layer; the second client `connectEngine` hands back is unused here.
  const engine = await connectEngine();
  if (!engine && !import.meta.env.DEV) return bootLegacy(true);
  startSystemTheme();
  if (engine) serveClose('onboarding');
  // One stylesheet first, then the onboarding window's layout file: the later one wins, so the order is the rule.
  await import('./ui/styles.css');
  await import('./onboarding/onboarding.css');
  const [{ OnboardingApp }, ports] = await Promise.all([
    import('./onboarding/OnboardingApp'),
    import('./onboardingPorts'),
  ]);
  if (!engine) {
    const { connectStandInDataLayer } = await import('./data/standin-layer');
    connectStandInDataLayer({ scenario: scenario ?? 'empty' });
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <OnboardingApp
        mode={onboardingMode(window.location.search)}
        ports={ports.dataWindowPorts}
        connectPorts={ports.dataConnectPorts}
      />
    </StrictMode>,
  );
}

/**
 * The legacy renderer: the entry is the one place allowed to reach it (its path until the legacy folders go). Reached
 * as a fallback (the real engine's bridge failed, or the new root could not start) it says so in the window title, so
 * the owner can tell which renderer is running.
 */
async function bootLegacy(fallback = false): Promise<void> {
  stopCloseAnswer();
  if (fallback) document.title = 'Aplos Mail (legacy view)';
  // The one place the legacy banner is mounted: the old version says so at the top of its window.
  mountLegacyBanner(undefined, legacyBannerText(import.meta.env.DEV));
  // eslint-disable-next-line aplos/boundaries
  await import('./legacy/main');
}

/**
 * A new root that fails to start (a missing chunk, a throw while booting) leaves a blank window. In a build that is
 * not a development build that window goes to the legacy renderer instead, as a bridge that fails to connect does.
 */
function bootFailed(): Promise<void> {
  return import.meta.env.DEV ? Promise.resolve() : bootLegacy(true);
}

if (entry === 'legacy') void bootLegacy().catch(() => undefined);
else if (entry === 'onboarding')
  void bootOnboarding()
    .catch(bootFailed)
    .catch(() => undefined);
else
  void boot()
    .catch(bootFailed)
    .catch(() => undefined);
