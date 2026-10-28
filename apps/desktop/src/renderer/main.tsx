/**
 * The renderer entry (F9; plan 30 4.1 build order step 1).
 *
 * In a development build it boots the new app on the stand-in engine (F6) in-process, on the `demo` scenario, and
 * mounts `<App/>` with the one stylesheet. Today's renderer stays reachable: `VITE_APLOS_LEGACY=1` or `?legacy=1`
 * loads `./legacy/main` instead, and so does every production build, because no release ships stand-in data (plan 30
 * 4.1 release rule). The real transports (a MessagePort in Electron, tokenised HTTP and SSE in the browser preview)
 * replace the in-process stand-in in U2, and the switch to the real engine is WP5.6.
 *
 * Everything the new app needs is imported on its own path, so the legacy path loads none of it (no new stylesheet,
 * no fixture, no zod).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const legacy =
  import.meta.env.VITE_APLOS_LEGACY === '1' ||
  new URLSearchParams(window.location.search).get('legacy') === '1' ||
  !import.meta.env.DEV;

async function boot(): Promise<void> {
  const [{ App }, { connectStandIn }] = await Promise.all([
    import('./App'),
    import('./data/standin'),
    import('./ui/styles.css'),
  ]);
  const { client } = connectStandIn({ scenario: 'demo' });
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
}

// The entry is the one place allowed to reach the legacy renderer (its production path until WP5.6).
// eslint-disable-next-line aplos/boundaries
if (legacy) void import('./legacy/main');
else void boot();
