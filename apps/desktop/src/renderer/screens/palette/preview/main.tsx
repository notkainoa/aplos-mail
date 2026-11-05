/**
 * The palette + search preview gallery (development only; DESIGN §12.5). Vite serves it at
 * `/apps/desktop/src/renderer/screens/palette/preview/index.html?state=<name>&theme=light|dark`; with no `state` it
 * lists every state. It loads the app's stylesheet and this lane's CSS, sets the theme the way the tokens expect
 * (`data-theme` on the root), and draws one state in a plain window: the palette over the page, or Search filling
 * it. The states are pure component renders over the real registry, so no data layer or engine is needed.
 */
import { StrictMode, useEffect, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../ui/styles.css';
import '../../search/search.css';
import './preview.css';
import { CommandKeysProvider, KeyHintsProvider } from '../../../ui/buttons-keys';
import { states, registry, type StateEntry } from './states';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = theme;
const stateName = params.get('state');

declare global {
  interface Window {
    __previewReady?: boolean;
    __paletteStates?: string[];
  }
}

function Ready({ children }: { children: JSX.Element }) {
  useEffect(() => {
    // Fonts first, so a capture never measures a fallback face.
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() => {
        window.__previewReady = true;
      }),
    );
  }, []);
  return children;
}

function Window({ entry, name }: { entry: StateEntry; name: string }) {
  return (
    <div className="prev-window" data-state={name}>
      <div className="prev-sidebar" />
      <main className="prev-pane">
        {entry.kind === 'overlay' ? <div className="prev-page" /> : null}
        {entry.render()}
      </main>
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
  if (!entry) return <Index />;
  return (
    <Ready>
      <KeyHintsProvider value={{ showKeys: 'all' }}>
        <CommandKeysProvider describe={(id, stack) => registry.describeKeys(id, stack)}>
          <Window entry={entry} name={stateName!} />
        </CommandKeysProvider>
      </KeyHintsProvider>
    </Ready>
  );
}

window.__paletteStates = Object.keys(states);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
