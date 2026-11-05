/**
 * The renderer entry (F9; plan 30 4.1 build order step 1).
 *
 * In a development build it boots the new app on the stand-in engine (F6) in-process, on the `demo` scenario
 * (`?scenario=<name>` picks another, dev only), installs the data layer on it and mounts `<App/>` with the one
 * stylesheet and the shell's layout. With `?window=onboarding` — the query main gives the welcome window, and
 * the browser-preview route "Try demo mail" and "Show welcome" navigate to — it mounts `onboarding/OnboardingApp`
 * on the same stand-in switch and the same data layer, never a separate engine.
 * Today's renderer stays reachable: `VITE_APLOS_LEGACY=1` or `?legacy=1`
 * loads `./legacy/main` instead, and so does every production build, because no release ships stand-in data (plan 30
 * 4.1 release rule). When preload exposes `window.aplosEngine` (main's real-engine path) the new roots connect over
 * `bridge.ts` instead of the stand-in, still in a development build only; the browser preview's tokenised HTTP and
 * SSE transport is still to come.
 *
 * `entry.ts` holds the rule. In a development build the onboarding window (`?window=onboarding&mode=first|review`, as
 * main loads it) boots `OnboardingApp` on a fresh install (the `empty` scenario) with `onboarding.css` after the one
 * stylesheet; every other window boots `App`. Production builds and the legacy switch still load the legacy renderer.
 *
 * Everything the new app needs is imported on its own path, so the legacy path loads none of it (no new stylesheet,
 * no fixture, no zod) and the mail window loads none of the onboarding window's.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { chooseEntry, onboardingMode, transportOf, type EntryInput } from './entry';
import { scenarioParam } from './onboarding/route';
import type { Client, EngineSession } from '@aplos/contract/client';
import type { DataConnection } from './data/connect';
import type { StandInOptions } from './data/standin';

const hook = (globalThis as { __aplosWindowKind?: string }).__aplosWindowKind;
const input: EntryInput = {
  search: window.location.search,
  dev: import.meta.env.DEV,
  legacyEnv: import.meta.env.VITE_APLOS_LEGACY === '1',
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

async function boot(): Promise<void> {
  const [{ App }, { connectStandInDataLayer }, { createClient }] = await Promise.all([
    import('./App'),
    import('./data/standin-layer'),
    import('@aplos/contract/client'),
    import('./ui/styles.css'),
    import('./shell/shell.css'),
    import('./screens/screens.css'),
  ]);
  // The mail window hosts lane pieces now (the zero-accounts pane): the lane's own wrappers come after
  // the one stylesheet, the same order the onboarding window and the preview gallery keep.
  await import('./onboarding/onboarding.css');
  const engine = await connectEngine();
  if (engine) {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App client={engine.client} />
      </StrictMode>,
    );
    return;
  }
  // The data layer (hooks and `api`) and a second client on the same engine for the Home boot proof.
  const layer = connectStandInDataLayer({ scenario });
  const client = createClient(layer.engine.connect());
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
  // Main may ask this window to open a screen (first sync's "Open Settings"); typed, so it never takes held app events.
  const [{ listenMainNavigate }, { openRoute }] = await Promise.all([
    import('./shell/mainNavigate'),
    import('./shell'),
  ]);
  listenMainNavigate(window.aplos, openRoute);
}

async function bootOnboarding(): Promise<void> {
  // One stylesheet first, then the onboarding window's layout file: the later one wins, so the order is the rule.
  await import('./ui/styles.css');
  await import('./onboarding/onboarding.css');
  const [{ OnboardingApp }, { connectStandInDataLayer }, ports] = await Promise.all([
    import('./onboarding/OnboardingApp'),
    import('./data/standin-layer'),
    import('./onboardingPorts'),
  ]);
  // The onboarding window needs only the data layer; the second client `connectEngine` hands back is unused here.
  const engine = await connectEngine();
  if (!engine) connectStandInDataLayer({ scenario: scenario ?? 'empty' });
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

// The entry is the one place allowed to reach the legacy renderer (its production path until WP5.6).
// eslint-disable-next-line aplos/boundaries
if (entry === 'legacy') void import('./legacy/main').catch(() => undefined);
else if (entry === 'onboarding') void bootOnboarding().catch(() => undefined);
else void boot().catch(() => undefined);
