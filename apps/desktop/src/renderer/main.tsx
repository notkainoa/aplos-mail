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
 * `entry.ts` holds the rule. In a development build the onboarding window (`?window=onboarding&mode=first|review`, as
 * main loads it) boots `OnboardingApp` on a fresh install (the `empty` scenario) with `onboarding.css` after the one
 * stylesheet; every other window boots `App`. Production builds and the legacy switch still load the legacy renderer.
 *
 * Everything the new app needs is imported on its own path, so the legacy path loads none of it (no new stylesheet,
 * no fixture, no zod) and the mail window loads none of the onboarding window's.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { chooseEntry, onboardingMode } from './entry';
import { scenarioParam } from './onboarding/route';
import type { StandInOptions } from './data/standin';

const hook = (globalThis as { __aplosWindowKind?: string }).__aplosWindowKind;
const entry = chooseEntry({
  search: window.location.search,
  dev: import.meta.env.DEV,
  legacyEnv: import.meta.env.VITE_APLOS_LEGACY === '1',
  ...(hook ? { hook } : {}),
});

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
  // One stylesheet first, then the onboarding window's layout file: the later one wins, so the order is the rule.
  await import('./ui/styles.css');
  await import('./onboarding/onboarding.css');
  const [{ OnboardingApp }, { connectStandInDataLayer }, ports] = await Promise.all([
    import('./onboarding/OnboardingApp'),
    import('./data/standin-layer'),
    import('./onboardingPorts'),
  ]);
  connectStandInDataLayer({ scenario: scenario ?? 'empty' });
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
if (entry === 'legacy') void import('./legacy/main');
else if (entry === 'onboarding') void bootOnboarding();
else void boot();
