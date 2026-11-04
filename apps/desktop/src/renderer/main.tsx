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
 * 4.1 release rule). The real transports (a MessagePort in Electron, tokenised HTTP and SSE in the browser preview)
 * replace the in-process stand-in in U2, and the switch to the real engine is WP5.6.
 *
 * Everything the new app needs is imported on its own path, so the legacy path loads none of it (no new stylesheet,
 * no fixture, no zod).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { chooseRoute, onboardingMode, scenarioParam } from './onboarding/route';
import type { StandInOptions } from './data/standin';

const legacy = import.meta.env.VITE_APLOS_LEGACY === '1' || !import.meta.env.DEV;

const route = legacy ? 'legacy' : chooseRoute(window.location.search);

const scenario = scenarioParam(window.location.search) as StandInOptions['scenario'];

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
  // The data layer (hooks and `api`) and a second client on the same engine for the Home boot proof.
  const layer = connectStandInDataLayer({ scenario });
  const client = createClient(layer.engine.connect());
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
}

async function bootOnboarding(): Promise<void> {
  const [{ OnboardingApp }, { connectStandInDataLayer }] = await Promise.all([
    import('./onboarding/OnboardingApp'),
    import('./data/standin-layer'),
  ]);
  // The lane's own wrappers come after the one stylesheet (the preview gallery's order), then the layer
  // installs hooks and `api` on the stand-in — the same engine the mail app would get.
  await import('./ui/styles.css');
  await import('./onboarding/onboarding.css');
  connectStandInDataLayer({ scenario });
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <OnboardingApp mode={onboardingMode(window.location.search)} />
    </StrictMode>,
  );
}

// The entry is the one place allowed to reach the legacy renderer (its production path until WP5.6).
// eslint-disable-next-line aplos/boundaries
if (route === 'legacy') void import('./legacy/main');
else if (route === 'onboarding') void bootOnboarding();
else void boot();
