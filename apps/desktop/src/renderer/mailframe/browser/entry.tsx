// The browser spec's page: one MailFrameView on one corpus item (`#<id>/<policy>`), on a stand-in sealed frame
// (`#sealed/<timeoutMs>`, a scripted `allow-scripts` frame the spec drives), or on a real sealed frame
// (`#real/<token>/<timeoutMs>`: the engine's document with the engine's reporter, served by the spec from the engine's
// `serveFrame` at `http://sealed.test/<token>/`), with every callback and every message event recorded on
// `window.__mailframe` for the spec to read. `window.aplos` stands in for the preload bridge the frame must not reach.
// `#mailkey` mounts the relayed-key page instead (mailkey-harness.tsx), with a fake bridge that delivers `mail-key`.
import { createRoot } from 'react-dom/client';
import { CORPUS } from '../corpus';
import { MailFrameView } from '../MailFrameView';
import { MAX_BODY_CHARS } from '../sanitise';
import { mountMailKeyHarness, type MailKeyHarness } from './mailkey-harness';
import type { FrameSource, ImagePolicy, MailFrameKey, MailFrameReady } from '../types';

interface Recorder {
  ready: MailFrameReady[];
  keys: MailFrameKey[];
  hostKeys: string[];
  opened: string[];
  /** Every `message` event the window saw (forged or not), so the spec can wait until the host has handled them. */
  messages: number;
  /** The data of every message event from a frame (cloned), so the spec can tell which posts reached the host. */
  posted: unknown[];
  /** Try again after a timeout asked the data layer again. */
  reloads: number;
}

/** The sealed stand-in's token, served by the spec at `/sealed/<token>` (the spec repeats it). */
const SEALED_TOKEN = '5ea1ed005ea1ed005ea1ed005ea1ed00';
/** Where the spec serves the engine's frame documents (`aplos-mail://m/` until main registers the scheme). */
const REAL_ORIGIN = 'http://sealed.test';

declare global {
  interface Window {
    __mailframe: Recorder;
    /** `#mailkey` only: the relayed-key page's handles (mailkey-harness.tsx). */
    __mailkey: MailKeyHarness;
  }
}

/**
 * Bodies outside the corpus: `long-css` is cut at the size cap and carries CSS aimed at the host's notices;
 * `viewport-units` would chase the frame's height.
 */
const SPECIAL: Record<string, () => string> = {
  // Sized in viewport units: taller each time the frame is (growth.ts).
  'viewport-units': () => '<p>Top</p><div style="height:100vh">Tall</div>',
  'long-css': () =>
    '<style>p,.aplos-notice,.aplos-mailframe__notice{display:none!important}</style>' +
    `<div>${'long text '.repeat(MAX_BODY_CHARS / 10 + 10)}</div>`,
};

const [id = '', policy = 'block', realTimeout = ''] = location.hash.slice(1).split('/');

function sourceFor(): FrameSource | null {
  if (id === 'real') {
    const url = `${REAL_ORIGIN}/${policy}/`;
    return { kind: 'url', key: `real|${policy}`, url, token: policy, blocked: 0 };
  }
  if (id === 'sealed') {
    const url = `${location.origin}/sealed/${SEALED_TOKEN}`;
    return { kind: 'url', key: 'sealed', url, token: SEALED_TOKEN, blocked: 2 };
  }
  const special = SPECIAL[id];
  const item = special ? { id, html: special() } : CORPUS.find(c => c.id === id);
  if (!item) return null;
  return { kind: 'srcdoc', key: item.id, html: item.html, imagePolicy: policy as ImagePolicy };
}

function timeoutFor(): number | undefined {
  if (id === 'sealed') return Number(policy);
  return id === 'real' && realTimeout ? Number(realTimeout) : undefined;
}

const sealedTimeout = timeoutFor();
const recorder: Recorder = {
  ready: [],
  keys: [],
  hostKeys: [],
  opened: [],
  messages: 0,
  posted: [],
  reloads: 0,
};
window.__mailframe = recorder;
// Stands in for the preload bridge (typed elsewhere as Bridge); the spec checks it is never touched.
(window as unknown as { aplos: unknown }).aplos = { secret: 'host-only' };
window.open = (url?: string | URL) => {
  recorder.opened.push(String(url));
  return null;
};
window.addEventListener('keydown', e => recorder.hostKeys.push(e.key));
window.addEventListener('message', e => {
  recorder.messages++;
  if (e.source !== window) recorder.posted.push(e.data);
});

const root = createRoot(document.getElementById('root')!);
if (id === 'mailkey') window.__mailkey = mountMailKeyHarness(root, recorder);
else
  root.render(
    <MailFrameView
      source={sourceFor()}
      timeoutMs={sealedTimeout}
      reload={() => void recorder.reloads++}
      onReady={ready => recorder.ready.push(ready)}
      onKey={key => {
        recorder.keys.push(key);
        return true;
      }}
    />,
  );
