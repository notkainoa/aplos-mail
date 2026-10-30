// The browser spec's page: one MailFrameView on one corpus item (`#<id>/<policy>`), with every callback recorded on
// `window.__mailframe` for the spec to read. `window.aplos` stands in for the preload bridge the frame must not reach.
import { createRoot } from 'react-dom/client';
import { CORPUS } from '../corpus';
import { MailFrameView } from '../MailFrameView';
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

const [id = '', policy = 'block'] = location.hash.slice(1).split('/');
const item = CORPUS.find(c => c.id === id);
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
