/**
 * The Calendar preview gallery (development only; DESIGN 12.5, plan 30 U7). Vite serves it at
 * `/src/renderer/screens/calendar/preview/index.html?state=<name>&theme=light|dark`; with no `state` it lists every
 * state. It loads the app's one stylesheet and this lane's layout file, sets the theme the way the tokens expect
 * (`data-theme` on the root) and draws one state as the main window: the shell, a sidebar column with this lane's
 * MiniMonth and CalendarList data, and the pane. `shoot.mjs` drives it headlessly at each state's window size.
 */
import { StrictMode, useEffect, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../ui/styles.css';
import '../calendar.css';
import { calendarStates } from './states';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const stateName = params.get('state');
// `raw=1` drops the gallery's stopgap reset (index.html) so the calendar family's missing button reset shows.
if (params.get('raw') === '1') document.documentElement.dataset.raw = 'true';

function Ready({ children }: { children: JSX.Element }) {
  useEffect(() => {
    // Fonts first, then two frames: the pane measures its width and anchors resolve before a capture.
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          document.documentElement.dataset.previewReady = 'true';
        }),
      ),
    );
  }, []);
  return children;
}

function Index() {
  return (
    <div className="calp-index">
      <ul>
        {Object.entries(calendarStates).map(([name, entry]) => (
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
  const entry = stateName ? calendarStates[stateName] : undefined;
  return <Ready>{entry ? entry.render() : <Index />}</Ready>;
}

// The capture script reads the state list and window sizes from here.
(window as unknown as { __calStates?: Record<string, { width: number; height: number }> }).__calStates =
  Object.fromEntries(
    Object.entries(calendarStates).map(([name, entry]) => [name, { width: entry.width, height: entry.height }]),
  );

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
