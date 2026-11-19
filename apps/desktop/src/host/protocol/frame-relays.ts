/**
 * Everything main does for a sealed mail frame beyond the navigation lock, attached to one window's `WebContents` in
 * one place (lane eng-html, html-5): the key relay, links clicked in the letter and `window.open`. `main/windows.ts`
 * calls it for every app window; the hidden-Electron test (tests/eng-host/sealed-frame.e2e.ts) calls the same function,
 * so the wiring measured in Chromium is the wiring that ships. Electron types only: no runtime Electron import.
 */
import type { WebContents } from 'electron';
import { relayMailKey } from './frame-keys';
import { isMailFrameLink, routeFrameLink, type FrameLinkSinks } from './frame-links';

/**
 * - `before-input-event`: a listed, unmodified keydown whose focused frame is the sealed frame goes to the window's
 *   renderer as one validated message (frame-keys.ts). The page's own keys are never touched.
 * - `will-frame-navigate`: a link that navigates the mail frame itself is cancelled and routed (mailto to Compose,
 *   http and https to the browser, nothing else). Navigations the app page starts are not the letter's links.
 * - `setWindowOpenHandler`: every `window.open` or `target=_blank` link is denied and routed the same way. This replaces
 *   any earlier handler, so call it after the window's other handlers are set.
 */
export function attachSealedFrameRelays(contents: WebContents, sinks: FrameLinkSinks): void {
  contents.on('before-input-event', (_event, input) => {
    relayMailKey(contents, input);
  });
  contents.on('will-frame-navigate', event => {
    if (!isMailFrameLink(event)) return;
    // A mailto or web target is never a navigation the app allows, so cancelling it here changes nothing else; every
    // other target is left to the navigation lock (security.ts and windows.ts), which denies it.
    if (routeFrameLink(event.url, sinks) !== 'deny') event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    routeFrameLink(url, sinks);
    return { action: 'deny' };
  });
}
