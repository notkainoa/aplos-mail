/**
 * The onboarding preview gallery (development only; plan 30 U8 acceptance 6, DESIGN 12.5). Vite serves it at
 * `/src/renderer/onboarding/preview/index.html?state=<name>&theme=light|dark`; with no `state` it lists every state.
 * It loads the app's one stylesheet and this lane's layout file, sets the theme the way the tokens expect
 * (`data-theme` on the root), and draws one state inside a 640 × 600 window frame (640 × 520 for the minimum-size
 * check). The capture script `shoot.mjs` drives it headlessly.
 *
 * First-sync states come from `../firstSync/states.tsx`, the weekly reconnect and zero-accounts states from
 * `../reconnect/states.tsx`, and the demo states from `../demo.states.tsx`, when those files exist on the branch; the
 * globs keep the gallery compiling without them.
 */
import { StrictMode, useEffect, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import '../../ui/styles.css';
import '../onboarding.css';
import { stepStates } from '../steps/states';

type StateEntry = { title: string; render: () => JSX.Element; height?: number };
type StateTable = Record<string, StateEntry>;

const firstSyncModules = import.meta.glob<{ firstSyncStates?: StateTable }>(
  '../firstSync/states.tsx',
  {
    eager: true,
  },
);
const firstSyncStates: StateTable = Object.values(firstSyncModules)[0]?.firstSyncStates ?? {};

const reconnectModules = import.meta.glob<{ reconnectStates?: StateTable }>(
  '../reconnect/states.tsx',
  {
    eager: true,
  },
);
const reconnectStates: StateTable = Object.values(reconnectModules)[0]?.reconnectStates ?? {};

const demoModules = import.meta.glob<{ demoStates?: StateTable }>('../demo.states.tsx', {
  eager: true,
});
const demoStates: StateTable = Object.values(demoModules)[0]?.demoStates ?? {};

/** Every state, steps first; a first-sync or reconnect state with an earlier state's name is kept under a prefix. */
export const allStates: StateTable = { ...stepStates };
for (const [name, entry] of Object.entries(firstSyncStates)) {
  allStates[name in allStates ? `firstSync-${name}` : name] = entry;
}
for (const [name, entry] of Object.entries(reconnectStates)) {
  allStates[name in allStates ? `reconnect-${name}` : name] = entry;
}
for (const [name, entry] of Object.entries(demoStates)) {
  allStates[name in allStates ? `demo-${name}` : name] = entry;
}

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = theme;
const stateName = params.get('state');

function Ready({ children }: { children: JSX.Element }) {
  useEffect(() => {
    // Fonts first, so a capture never measures a fallback face.
    void document.fonts.ready.then(() => {
      // As the window does on a new step: the step shows from its top even though its main action took focus
      // (OnboardingApp's focusTarget with keepTop; F13).
      requestAnimationFrame(() => {
        const body = document.querySelector('main');
        if (body) body.scrollTop = 0;
        document.documentElement.dataset.previewReady = 'true';
      });
    });
  }, []);
  return children;
}

function Index() {
  const names = Object.keys(allStates);
  return (
    <div className="onb-index">
      <ul>
        {names.map(name => (
          <li key={name}>
            <a href={`?state=${encodeURIComponent(name)}&theme=light`}>{name}</a>
            {' · '}
            <a href={`?state=${encodeURIComponent(name)}&theme=dark`}>dark</a>
            {' · '}
            {allStates[name].title}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Gallery() {
  if (!stateName)
    return (
      <Ready>
        <Index />
      </Ready>
    );
  const entry = allStates[stateName];
  if (!entry)
    return (
      <Ready>
        <Index />
      </Ready>
    );
  return (
    <Ready>
      <div className="onb-frame" data-height={String(entry.height ?? 600)} data-state={stateName}>
        <div className="onb-window">{entry.render()}</div>
      </div>
    </Ready>
  );
}

// The capture script reads the state list from here.
(window as unknown as { __onbStates?: Record<string, { height: number }> }).__onbStates =
  Object.fromEntries(
    Object.entries(allStates).map(([name, entry]) => [name, { height: entry.height ?? 600 }]),
  );

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
