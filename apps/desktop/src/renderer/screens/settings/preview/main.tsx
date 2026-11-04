/**
 * The Settings preview gallery (development only; plan 30 U7). Vite serves it at
 * `/src/renderer/screens/settings/preview/index.html?state=<name>&theme=light|dark`; with no `state` it lists every
 * state. It loads the app's one stylesheet and this lane's layout file, sets the theme the way the tokens expect
 * (`data-theme` on the root) and draws one state inside the main window's pane. `shoot.mjs` drives it headlessly.
 * `?canary=1` plants a fake key in every place a key could leak, for the secret scan.
 */
import { StrictMode, useEffect, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../ui/styles.css';
import '../settings.css';
import { Pane } from '../../../ui/surfaces';
import { PreviewScreen, STATES, withCanary, type StateSpec } from './states';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const stateName = params.get('state');
const canary = params.get('canary') === '1';

function Ready({ children }: { children: JSX.Element }) {
  useEffect(() => {
    // Fonts first, so a capture never measures a fallback face.
    void document.fonts.ready.then(() => {
      requestAnimationFrame(() => {
        document.documentElement.dataset.previewReady = 'true';
      });
    });
  }, []);
  return children;
}

function Index() {
  return (
    <div className="set-index">
      <ul>
        {Object.entries(STATES).map(([name, s]) => (
          <li key={name}>
            <a href={`?state=${encodeURIComponent(name)}&theme=light`}>{name}</a>
            {' · '}
            <a href={`?state=${encodeURIComponent(name)}&theme=dark`}>dark</a>
            {' · '}
            {s.title}
          </li>
        ))}
      </ul>
    </div>
  );
}

const noop = () => {};

function Frame({ spec }: { spec: StateSpec }) {
  const shown = canary ? { ...spec, data: withCanary(spec.data) } : spec;
  return (
    <div className="set-frame" data-state={stateName ?? undefined}>
      <div className="set-frame__side" aria-hidden="true" />
      <Pane
        kind="main"
        label="Settings"
        header={{
          ask: { pressed: false, scope: 'mail', onPress: noop },
          today: { pressed: false, onPress: noop },
        }}
      >
        <PreviewScreen spec={shown} />
      </Pane>
    </div>
  );
}

function Gallery() {
  const spec = stateName ? STATES[stateName] : undefined;
  return <Ready>{spec ? <Frame spec={spec} /> : <Index />}</Ready>;
}

// The capture script reads the state list from here.
(
  window as unknown as { __setStates?: Record<string, { width: number; height: number }> }
).__setStates = Object.fromEntries(
  Object.entries(STATES).map(([name, s]) => [name, s.size ?? { width: 1440, height: 900 }]),
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
