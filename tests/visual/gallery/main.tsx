// The gallery entry: renders one state from ?state=<id>&theme=light|dark&contrast=more on the app's own
// stylesheet, with the registry's key text behind every keycap, and flags the page when it has settled.

import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../apps/desktop/src/renderer/ui/styles.css';
import './stage.css';
import {
  CommandKeysProvider,
  KeyHintsProvider,
} from '../../../apps/desktop/src/renderer/ui/buttons-keys';
import { STATES } from '../states';
import { registry, scenes } from './scenes';

declare global {
  interface Window {
    /** Set once the state is drawn and the fonts are in. The specs wait for it. */
    __galleryReady?: boolean;
    __galleryError?: string;
  }
}

const params = new URLSearchParams(location.search);
const root = document.documentElement;
root.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
if (params.get('contrast') === 'more') root.dataset.contrast = 'more';

const state = STATES.find(candidate => candidate.id === params.get('state'));
const scene = state ? scenes[state.id] : undefined;

function Gallery(): ReactElement {
  if (!state || !scene) {
    window.__galleryError = `Unknown state: ${params.get('state') ?? '(none)'}`;
    return <p>{window.__galleryError}</p>;
  }
  const Scene = scene;
  const frame = state.frame ?? 'pane';
  return (
    <KeyHintsProvider value={{ showKeys: 'tooltips' }}>
      <CommandKeysProvider describe={(id, stack) => registry.describeKeys(id, stack)}>
        <div className="stage" data-frame={frame} data-state={state.id}>
          {frame === 'shell' ? (
            <Scene />
          ) : (
            <div className={frame === 'pane' ? 'stage__pane' : 'stage__box'}>
              <Scene />
            </div>
          )}
        </div>
      </CommandKeysProvider>
    </KeyHintsProvider>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
}

async function settle(): Promise<void> {
  // The serif is only fetched once something uses it, so ask for it before waiting.
  await Promise.all([
    document.fonts.load('430 21px Newsreader'),
    document.fonts.load('400 16px Newsreader'),
  ]).catch(() => undefined);
  await document.fonts.ready;
  // A scene that boots an engine marks itself `data-gallery-pending` until its screen has painted (scenes.home.tsx).
  for (let waits = 0; document.querySelector('[data-gallery-pending]') && waits < 300; waits += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // Two frames: React commits, floating surfaces measure their anchors, then layout is final.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.__galleryReady = true;
}
void settle();
