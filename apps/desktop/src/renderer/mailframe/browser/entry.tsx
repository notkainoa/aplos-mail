// The browser spec's page: one MailFrameView on one corpus item (`#<id>/<policy>`), with every callback recorded on
// `window.__mailframe` for the spec to read. `window.aplos` stands in for the preload bridge the frame must not reach.
import { createRoot } from 'react-dom/client';
import { CORPUS } from '../corpus';
import { MailFrameView } from '../MailFrameView';
import { MAX_BODY_CHARS } from '../sanitise';
import type { ImagePolicy, MailFrameKey, MailFrameReady } from '../types';

interface Recorder {
  ready: MailFrameReady[];
  keys: MailFrameKey[];
  hostKeys: string[];
  opened: string[];
}

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
const special = SPECIAL[id];
const item = special ? { id, html: special() } : CORPUS.find(c => c.id === id);
const recorder: Recorder = { ready: [], keys: [], hostKeys: [], opened: [] };
window.__mailframe = recorder;
// Stands in for the preload bridge (typed elsewhere as Bridge); the spec checks it is never touched.
(window as unknown as { aplos: unknown }).aplos = { secret: 'host-only' };
window.open = (url?: string | URL) => {
  recorder.opened.push(String(url));
  return null;
};
window.addEventListener('keydown', e => recorder.hostKeys.push(e.key));

const root = createRoot(document.getElementById('root')!);
root.render(
  <MailFrameView
    source={
      item
        ? { kind: 'srcdoc', key: item.id, html: item.html, imagePolicy: policy as ImagePolicy }
        : null
    }
    onReady={ready => recorder.ready.push(ready)}
    onKey={key => {
      recorder.keys.push(key);
      return true;
    }}
  />,
);
