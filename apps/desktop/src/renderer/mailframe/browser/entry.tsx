// The browser spec's page: one MailFrameView on one corpus item (`#<id>/<policy>`), or on a stand-in sealed frame
// (`#sealed/<timeoutMs>`, a scripted `allow-scripts` frame the spec drives), with every callback and every message
// event recorded on `window.__mailframe` for the spec to read. `window.aplos` stands in for the preload bridge the
// frame must not reach.
import { createRoot } from 'react-dom/client';
import { CORPUS } from '../corpus';
import { MailFrameView } from '../MailFrameView';
import { MAX_BODY_CHARS } from '../sanitise';
import type { FrameSource, ImagePolicy, MailFrameKey, MailFrameReady } from '../types';

interface Recorder {
  ready: MailFrameReady[];
  keys: MailFrameKey[];
  hostKeys: string[];
  opened: string[];
  /** Every `message` event the window saw (forged or not), so the spec can wait until the host has handled them. */
  messages: number;
  /** Try again after a timeout asked the data layer again. */
  reloads: number;
}

/** The sealed stand-in's token, served by the spec at `/sealed/<token>` (the spec repeats it). */
const SEALED_TOKEN = 'Sealed_Tok3n_0123456789';

declare global {
  interface Window {
    __mailframe: Recorder;
  }
}

/** Bodies too large for the corpus: `long-css` is cut at the size cap and carries CSS aimed at the host's notices. */
const SPECIAL: Record<string, () => string> = {
  'long-css': () =>
    '<style>p,.aplos-notice,.aplos-mailframe__notice{display:none!important}</style>' +
    `<div>${'long text '.repeat(MAX_BODY_CHARS / 10 + 10)}</div>`,
};

const [id = '', policy = 'block'] = location.hash.slice(1).split('/');

function sourceFor(): FrameSource | null {
  if (id === 'sealed') {
    const url = `${location.origin}/sealed/${SEALED_TOKEN}`;
    return { kind: 'url', key: 'sealed', url, token: SEALED_TOKEN, blocked: 2 };
  }
  const special = SPECIAL[id];
  const item = special ? { id, html: special() } : CORPUS.find(c => c.id === id);
  if (!item) return null;
  return { kind: 'srcdoc', key: item.id, html: item.html, imagePolicy: policy as ImagePolicy };
}

const sealedTimeout = id === 'sealed' ? Number(policy) : undefined;
const recorder: Recorder = {
  ready: [],
  keys: [],
  hostKeys: [],
  opened: [],
  messages: 0,
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
window.addEventListener('message', () => void recorder.messages++);

const root = createRoot(document.getElementById('root')!);
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
