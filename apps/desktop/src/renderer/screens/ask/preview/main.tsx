/**
 * The `ui-ask` preview gallery (development only; DESIGN §12.5). Vite serves it at
 * `/src/renderer/screens/ask/preview/index.html?state=<name>&theme=light|dark`; with no `state` it lists every state.
 * It loads the app's one stylesheet and this lane's layout files, sets the theme the way the tokens expect
 * (`data-theme` on the root), and draws one state in a 1440 × 900 window: the gray shell, the white main pane, and the
 * Ask dock as the 360 px second pane, the palette over the pane, or Search filling it. `shoot.mjs` captures it.
 */
import { StrictMode, useEffect, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../ui/styles.css';
import '../ask-screen.css';
import '../../today/today.css';
import '../../search/search.css';
import { states, type StateEntry } from './states';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = theme;
const stateName = params.get('state');

function Ready({ children }: { children: JSX.Element }) {
  useEffect(() => {
    // Fonts first, so a capture never measures a fallback face.
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() => {
        document.documentElement.dataset.previewReady = 'true';
      }),
    );
  }, []);
  return children;
}

function Window({ entry, name }: { entry: StateEntry; name: string }) {
  return (
    <div className="prev-window" data-state={name}>
      <div className="prev-sidebar" />
      <div className="prev-panes">
        <main className="prev-pane">{entry.layout === 'pane' ? entry.render() : null}</main>
        {entry.layout === 'dock' ? entry.render() : null}
      </div>
      {entry.layout === 'overlay' ? entry.render() : null}
    </div>
  );
}

function Index() {
  return (
    <div className="prev-index">
      <ul>
        {Object.entries(states).map(([name, entry]) => (
          <li key={name}>
            <a href={`?state=${encodeURIComponent(name)}&theme=light`}>{name}</a>
            {' · '}
            <a href={`?state=${encodeURIComponent(name)}&theme=dark`}>dark</a>
            {' · '}
            {entry.title}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Gallery() {
  const entry = stateName ? states[stateName] : undefined;
  return (
    <Ready>{entry && stateName ? <Window entry={entry} name={stateName} /> : <Index />}</Ready>
  );
}

// The capture script reads the state list from here.
(window as unknown as { __askStates?: string[] }).__askStates = Object.keys(states);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
