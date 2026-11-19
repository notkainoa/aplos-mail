import { started } from './lifecycle';
import { main, focusMain } from './windows';

const pendingLinks: string[] = [];
function handleLink(raw: string) {
  try {
    const url = new URL(raw);
    if (!['mailto:', 'aplos:'].includes(url.protocol) || raw.length > 10000) return;
    if (started) void focusMain();
    if (!main || main.webContents.isLoading()) pendingLinks.push(raw);
    else {
      void focusMain();
      main.webContents.send('aplos:event', { type: 'deep-link', payload: raw });
    }
  } catch {
    /* Ignore invalid OS links. */
  }
}

export { pendingLinks, handleLink };
