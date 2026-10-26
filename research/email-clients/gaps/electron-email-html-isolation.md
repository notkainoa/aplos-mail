# Email HTML isolation in Electron 44: resolving the origin vs height-measurement conflict

*2026-10-25. Scope: Aplos's reader (`apps/desktop/src/renderer/mailBody.ts`, `Reader.tsx`, `index.html`, `src/main/electron.ts`). Electron 44.7.2 ships Chromium 152.0.7977.149 (read from `process.versions` in the prototype).*

**Evidence key.**
- **[V]** I verified it in my own throwaway prototype (`/Users/knewton/.t3/aplos-research/proto/html-isolation/`, raw results in `out/result-*.json`).
- **[S]** I read it in Electron or Chromium source or docs, or in a precedent repo.
- **[I]** Inference.
- **[U]** Unverified.

The prototype ran hidden (`show:false`, Dock hidden). It cancelled every http(s) request at the session and used only `.invalid` hostnames, so nothing left the machine. I read the precedent clones only and never ran or built them.

---

## 0. Bottom line

The conflict is real, and the prototype shows exactly where it sits. In Electron 44 there is **no script-free way to measure the height of an iframe whose origin differs from the parent's**:
- `contentDocument` is null.
- The main process's `WebFrameMain.executeJavaScript` returns "Script not run" in any frame whose sandbox disables scripts, whatever its origin [V].
- An isolated-world preload in such a frame starts, but its DOMContentLoaded and ResizeObserver callbacks never fire [V].
- CSS `frame-sizing` is not supported [V].

The only script-free measurement is a separate `WebContentsView` with `enablePreferredSizeMode` [V]. That option costs one renderer per message and can't sit inside the reader's DOM.

**Recommendation.** Serve each email from one custom origin, `aplos-mail://m/<token>`, through `protocol.handle`. Render it in an iframe that is **opaque and sandboxed but allows exactly one hash-pinned script of ours**. That script reports height and paper colour by `postMessage`.

The frame then runs out of process, away from the window that can send mail (verified). The CSP is an HTTP header, not a meta tag. Email scripts stay blocked by the hash (verified). All mail frames share one extra renderer, about +22–35 MB footprint for a 20-message thread (verified). Height arrives in 15–70 ms (verified). Keyboard shortcuts are intercepted in the main process with `before-input-event`, which is trusted OS input, never forwarded from the frame.

A same-origin `srcdoc` frame (Redakt, Inbox Zero, Superlocal) is an acceptable **one-day stopgap**. It is far better than today's direct injection, but it leaves email parsing and image decoding inside the process whose main frame passes `assertCaller`.

---

## 1. Threat model per option (Chromium 152)

Today, `prepareMessageBody` runs DOMPurify in the renderer and injects the result with `dangerouslySetInnerHTML` (`Reader.tsx:169`). It forbids `style` and `link` tags and `style` attributes (`mailBody.ts:44`), so designed mail loses its layout. The page CSP allows `img-src https:` and `script-src 'unsafe-inline'` (`index.html`). Any isolation option lets styles back in, so the CSP becomes the network fence.

Each cell is what hostile mail could still do. The prototype ran with no sanitizer, so the cells show what the browser layer alone stops.

| Vector | (a) `srcdoc` + `allow-same-origin`, no scripts, in privileged page | (b) opaque `srcdoc`, no scripts | (c) custom origin `aplos-mail:` + CSP header with `sandbox` | (d) `WebContentsView`, `javascript:false` |
|---|---|---|---|---|
| Origin / process | Parent's origin (`file://`), **same process** as `window.aplos` [V] | `null`, **out of process** (OOPIF) [V] | `null`, OOPIF [V] | Own WebContents, own process, own session possible [V] |
| CSP in force | Parent CSP **inherited** plus inner meta CSP (both enforced) [V] | Same inheritance [V] | Only the response header. The host CSP is *not* inherited: with no header, 14 loads leaked [V] | Header from the protocol handler [V] |
| Scripts, inline handlers | Blocked by sandbox [V] | Blocked [V] | Blocked [V] | Off [V] |
| `url()` in inline style, `cursor`, `list-style-image`, `background=`, `poster`, SVG `<image>` | Image loads, governed by `img-src`. They leak if the inherited `https:` applies [V] | Same | Blocked by header `img-src` [V] | Blocked by header, plus own session |
| `@import`, `<link rel=stylesheet>` | `style-src` [V] | `style-src` [V] | `style-src` [V] | Header |
| `@font-face` | `font-src` [V] | `font-src` [V] | `font-src` [V] | Header |
| `<link rel=prefetch/preload>` | CSP-blocked (`default-src`/`img-src`) [V] | Same | Same | Same |
| `<link rel=dns-prefetch>` | **A real DNS lookup happened despite CSP and webRequest** (netlog `is_speculative:true`) [V] | Same [V] | Same [V] | Same [V] |
| Form submit | No `allow-forms` plus `form-action 'none'` [S] | Same | Same | Same |
| Meta refresh | **Refused by the sandbox when `allow-scripts` is absent** ("The document is sandboxed, and the 'allow-scripts' keyword is not set") [V] | Same [V] | Same [V] | Same [I] |
| …if `allow-scripts` is added | — | Refresh **runs** [V] | Refresh runs, but `will-frame-navigate` catches it [V] | — |
| Link click, `_self` | Navigates the frame. `will-frame-navigate` can cancel it, *unless the host CSP `frame-src` blocks it first*, which leaves an error page in place of the email [V] | Same [I] | Same [I] | `will-navigate` on the view [S, Delta Chat] |
| `target=_blank` | Goes to `setWindowOpenHandler` when `allow-popups` is set [V] | Same [I] | Same [I] | Same [S] |
| `<base href>` | `base-uri 'none'` blocks it [V]. Without it, relative URLs resolve to the attacker host [V] | Same | Same | Same |
| Nested `<iframe>` | `frame-src` [V]; `will-frame-navigate` fires [V] | Same | Same | Same |
| Preload / `contextBridge` | Preload runs only in the main frame unless `nodeIntegrationInSubFrames` is set [S, `electron.d.ts` §webPreferences]. Same-origin means script *could* reach `parent.aplos`, but scripts can't run | Cross-origin, unreachable | Unreachable | Separate WebContents |
| Renderer memory bug triggered by HTML, CSS, image or font (no JS needed) | **Lands in the process that holds Aplos's IPC.** `assertCaller` only checks that the sender is the main frame, which it would be [I] | Lands in a mail-only process. Its IPC fails `assertCaller` (`electron.ts:48-51` requires `senderFrame === mainFrame`) [S] | Same as (b) | Isolated |

The last row decides it. In-the-wild exploits through image codecs alone exist, CVE-2023-4863 (libwebp) being the canonical example. Chromium decodes images and fonts in the renderer. Option (a) is therefore only as safe as Chromium's no-JS parsing surface, and any cid image in an email reaches it.

---

## 2. Process and memory cost

**What isolates out of process [V].**
- Opaque sandboxed `srcdoc` frames moved out of process. All 20 shared **one** extra process. This matches Chromium's process-model doc: since M127, desktop Chromium isolates sandboxed opaque-origin documents in their own process ([Chromium process model](https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md)) [S].
- Custom-scheme frames are site-isolated. One host for all mail means one process. A host per message means one process per message.

**Footprint for a 20-message thread [V].** Synthetic messages of about 26 KB of HTML each, measured with macOS `footprint`, 3 s after load:

| Mode | Renderer processes | Renderer footprint | Whole app footprint |
|---|---|---|---|
| Today's approach (inline divs) | 1 | 32 MB | 108 MB |
| (a) same-origin `srcdoc` | 1 | 45 MB | 134 MB |
| (b) opaque `srcdoc` | 2 | 24 + 43 MB | 156 MB |
| (c) one mail origin | 2 | 22 + 44 MB | 158 MB |
| (c′) one origin per message | 21 | 373 MB (17–18 MB each) | 481 MB |
| (d) 20 `WebContentsView`s | 21 | 355 MB | 454 MB |

RSS overstates these numbers because of shared pages; (d) shows 2.0 GB of RSS. Real mail with images costs more, but the ranking holds [I]. **Estimate for (c):** about +25–35 MB over today, roughly flat with thread length [I].

---

## 3. Measuring height with no script in the frame

**What doesn't work.**
1. **Parent `contentDocument`** only works when the frame is same-origin with the parent, i.e. option (a). Then it is synchronous: **2–3 ms** after `load`, and it works even while the frame is hidden, transparent or offscreen [V].
2. **Main-process `WebFrameMain.executeJavaScript`** (main world) fails with "Script not run" in every script-disabled frame I tried: same-origin `srcdoc`, opaque `srcdoc`, opaque custom scheme, and non-opaque custom scheme (`C_so`) [V]. `WebFrameMain` has no isolated-world variant in Electron 44; only `WebContents` and the renderer-side `WebFrame` have one [S, `electron.d.ts` L18313, L19115].
3. **An isolated-world preload in the subframe** (`nodeIntegrationInSubFrames`) logs at preload start, but its DOMContentLoaded and ResizeObserver listeners never fire in a frame without `allow-scripts` [V]. My inference: Blink suppresses listener invocation for an execution context that can't run scripts.
4. **CSS-only.** `CSS.supports('frame-sizing','content-height')` is false in Chromium 152 [V]. No other CSS lets the parent size to a cross-origin child.

**What does work.**
- **A `WebContentsView` with `javascript:false`.**
  - `preferred-size-changed` reported `{width:147, height:850}` with no script at all. 850 was the true content height [V].
  - `executeJavaScriptInIsolatedWorld` **ran despite `javascript:false`** and returned the height and background [V].
  - The main-world `executeJavaScript` failed [V].
- **A hash-pinned script in an opaque frame (`allow-scripts`, header CSP `script-src 'sha256-…'`).**
  - It reported height and background [V], while the email's own inline `<script>` and `onerror` were blocked [V].
  - **Pitfall [V]:** the first synchronous report can arrive before the out-of-process child knows its width, giving 0 or about 43,000 px. Gate reports on `innerWidth > 0`, and check the width matches the slot. With that gate, every report was correct.
  - **Latency [V]:** about 65 ms for the first frame (process start) and 14–43 ms afterwards on the custom origin. Opaque `srcdoc` stayed around 65–105 ms each.
  - **Hidden pending frames [V]:** `visibility:hidden`, `opacity:0` and offscreen pending frames all reported, because the sync and `resize` paths force layout.

**Background colour for the paper tint.** In-frame sampling with `getComputedStyle` returned the correct `rgb(244,239,230)` in (a), the hash-script mode and (d) [V]. The best known algorithm walks a single full-canvas wrapper chain and gives up on images, transforms or opacity (Superlocal `apps/web/src/MessageBody.tsx` L17-60) [S].

Do this in the frame's script, with an engine-side fallback: the engine's sanitizer reads `bgcolor` and `background-color` on `body`, `html` and the outermost full-width table. Static CSS analysis alone misses class-based backgrounds [I].

---

## 4. Keyboard and focus

**`before-input-event` [S].** Electron emits it from `WebContents::PreHandleKeyboardEvent` ([electron_api_web_contents.cc](https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_web_contents.cc)). Chromium calls that hook through the WebContents delegate in `RenderWidgetHostImpl::ForwardKeyboardEventWithCommands`, before the event reaches the renderer. A comment there notes the point is that a malicious renderer can't interfere ([render_widget_host_impl.cc](https://github.com/chromium/chromium/blob/main/content/browser/renderer_host/render_widget_host_impl.cc)).

**Same-process subframe [V].**
- A click focused the frame.
- `before-input-event` fired with `webContents.focusedFrame` equal to the `about:srcdoc` frame.
- `preventDefault` stopped the key from reaching the frame's document.
- A parent-realm listener attached to the frame's document still fired, which is what Mailspring, Superlocal and Inbox Zero rely on.

**Out-of-process subframe [U].** `webContents.sendInputEvent` feeds the root widget directly and skips Chromium's OOPIF input router. Clicks and keys never reached OOPIFs in the harness, even with offscreen rendering and `webContents.focus()`. The source path above applies to any widget in the WebContents, so I expect it to work [I], but this must be checked by hand in the real app before relying on it.

**`WebContentsView` [S, U].**
- Keys fire on *that view's* WebContents, not the window's.
- Delta Chat notes that Tab can't move focus between the two and works around it by focusing the view (`packages/target-electron/src/windows/html_email.ts` L145-153, L224-227).
- My harness couldn't deliver input to the view either.

**Focusable or not.** Selection and copy need focus in the frame: Chromium copies from the focused frame. So keep the frame focusable, add `tabindex="-1"` to keep it out of the Tab order, and intercept keys instead of preventing focus. `inert` or `pointer-events:none` would kill selection and links [I].

**Don't forward keys from the frame by `postMessage`.** If a hostile email ever got script running, it could press E, Space or R on the user's behalf. `before-input-event` is trusted OS input [I].

**Links [V, S].**
- `target=_blank` with `allow-popups` reaches `setWindowOpenHandler`.
- `will-frame-navigate` fires only for **renderer-initiated** navigations (Electron's `electron_navigation_throttle.cc`). It cancelled a `_self` link, a meta refresh and a nested iframe [V].
- If the host CSP `frame-src` rejects the URL first, the event never fires and an error page replaces the email [V].
- So make every link `_blank` in the sanitizer and keep `will-frame-navigate` as a backstop.
- `update-target-url` gives the hovered link's URL for a status line, as parula-mustang does (`WebView.svelte` L166) [S].

**Find, print and context menu [U].**
- **Find.** `findInPage` is WebContents-wide; Chromium's find manager covers OOPIFs [I]. It would also match the app chrome. Keep Aplos's own find by having the engine inject `<mark>`s and the frame script report their offsets.
- **Print.** `window.print()` in a sandboxed frame needs `allow-modals`. Print from a hidden offline window with `javascript:false` that loads the same document [I].
- **Context menu.** WebContents `context-menu` params carry `linkURL`, `selectionText` and `mediaType` from any frame, as Delta Chat does at L560-630 [S].

---

## 5. Remote content

**Session level.**
- **Who sent the request.** Custom-origin mail frames reach `webRequest` with `initiatorOrigin: 'null'` and a `details.frame.url` starting with `aplos-mail:` [V]. Same-origin `srcdoc` requests show the app's own initiator, `file://` [V]. A backstop filter therefore only works cleanly with (b), (c) or (d).
- **One listener.** Electron keeps a single `webRequest` listener per event per session [U, from the docs]. Put this filter in one place.
- **DNS prefetch.** Neither CSP nor `webRequest` stops it [V]. The sanitizer must strip every `<link>`.
- **Delta Chat's extra layer.** A throwaway partition per view, a fixed bogus proxy, and `http`/`https` overridden to 404 when remote content is off (`html_email.ts` L426-447) [S].

**cid images.** A frame-relative URL like `aplos-mail://m/<token>/cid/<n>` loaded and rendered inside an opaque frame under `img-src aplos-mail:` [V]. That avoids `data:` bloat. It also avoids `blob:` URLs created by the host, which may not load in an opaque frame [U].

**Image proxy (engine).**
- **URLs.** The frame never names a URL. The sanitizer swaps each remote image for an index into a server-side list bound to the token (`/img/<n>`), so a compromised frame can't turn the proxy into an SSRF gadget [I].
- **Pinned DNS.** Resolve once, reject the request if *any* address is loopback, private (RFC 1918), link-local, CGNAT, ULA, multicast, IPv4-mapped or NAT64. Connect to the vetted IP, keeping SNI and certificate checks on the hostname. Superlocal does exactly this with a custom `lookup` (`packages/inbox-sdk/src/media.ts` L81-105) [S].
- **Redirects.** Follow them manually, at most 3, re-validating each hop. Inbox Zero and Superlocal both cap at 3 [S].
- **Caps.** Allow only ports 80 and 443. Set a size cap of a few MB and a pixel cap. Accept only an allowlist of raster image types. Serve SVG only after sanitising it, or not at all.
- **Headers.** Send no cookies and no Referer, with a generic User-Agent. Add `nosniff` to responses. Keep an LRU cache.
- **Inbox Zero's proxy blocks hostnames lexically only** (`packages/network/src/host-policy.ts`) [S]. That is fine for a cloud worker but not on a laptop, because of DNS rebinding.

**Tracking pixels.**
- Drop `<img>` elements no larger than 2 px, or hidden by inline style, plus known tracker hosts. Show "N trackers removed". The precedents are Inbox Zero's `isAtMostOnePixel` (`packages/mail-ui/src/sanitize-html.ts` L11-25) and Superlocal's `isTrackingImage` (`email-images.ts`) [S].
- Remove `url()` from styles unless it is a rewritten cid or proxy URL.

---

## 6. Precedents (read, not run)

| Project (commit, licence) | Container and flags | CSP | Height | Keyboard and links |
|---|---|---|---|---|
| **Mailspring** (`fed072c`, GPL-3.0) | `document.write` into an iframe with `sandbox="allow-forms allow-same-origin"` (`message-list/lib/email-frame.tsx` L237) | None on the frame | Parent ResizeObserver on the frame's `<html>`, then scrollHeight, plus 20 px for horizontal scroll (L154, L200-224) | Parent listeners on the child document re-dispatch unmodified keys on the iframe element (`components/evented-iframe.tsx` L282-307). Parent click handler for links. The renderer has `nodeIntegration` (prior research). |
| **parula-mustang** (`d38ccc4`, EUPL-1.2) | Desktop: `<webview>` loading a `blob:` URL. `will-attach-webview` strips the preload and forces isolation (`desktop/src/main/index.ts` L313-329). Web and mobile: opaque `sandbox="allow-popups allow-popups-to-escape-sandbox"` (`WebView.svelte` L76) | Meta `default-src 'none'`, with images and styles from allowed servers (L104) | `webview.executeJavaScript` after load. JS is **not** disabled in the guest; it relies on the CSP (L196-218) | Guest `input-event` rawKeyDown forwarded through a remote call (L150). Links detected via `update-target-url` plus mouseDown (L166-175), which is fragile. |
| **Superlocal** (`d3725bc`, **no licence file: all rights reserved**) | `srcdoc`, `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"`, `referrerPolicy=no-referrer` (`apps/web/src/MessageBody.tsx` L317-320) | Meta `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; font-src 'none'`… (L127) | Sets the frame to 1 px, measures, zooms wide mail down to fit, observes body and frame width, waits for `fonts.ready` (L230-262). Canvas colour comes from a wrapper-chain walk (L17-60) | Parent capture listener on the child document (L279). |
| **Redakt** (`92d310c`, MIT) | `srcdoc`, same flags as Superlocal (`apps/web/components/mail/message-body.tsx` L158) | Meta `default-src 'none'`, with img, media, style and font restricted (`packages/core/src/render/sanitize.ts` L238) | ResizeObserver on the body, an outer width observer, `fonts.ready`, a 50 ms timer (L95-136) | No in-frame key handling. Remote images load by default. |
| **Inbox Zero** (`9946df5`, AGPL-3.0) | `srcdoc`, same flags (`packages/mail-ui/src/MailBody.tsx` L435). `<base target=_blank>` (L705-708) | Meta covering about 15 directives, all `'none'` except `img-src` (data/blob plus the proxy or `https:`) and inline styles (L346-362) | ResizeObserver on root and body. A per-document key in a meta tag (L536-590). The pending frame stays hidden and absolute until measured (L414-433). 2 s deadline (`BufferedThreadReader.tsx` L46) | Parent listener handles arrows, Enter and `f`, and re-dispatches the rest on the iframe (L462-528). Desktop: `setWindowOpenHandler` and `will-navigate` (`apps/desktop/src/main.ts` L673-690). |
| **Delta Chat Desktop** (`3fdeff5`, GPL-3.0) | A **separate window** per HTML email. The content is a `WebContentsView` with `javascript:false, sandbox:true, disableDialogs, webgl:false`, its own partition and a bogus proxy (`html_email.ts` L426-490) | Header CSP *including `sandbox`*, served from the `email:` scheme (L405-447) | None. It is a fixed-size scrolling view | Separate WebContents. `will-navigate` and `setWindowOpenHandler` (L510-550). Remote content goes through the Rust core. |

**Takeaways.** The inline readers all chose same-origin so they could measure. All but Mailspring are web apps, whose parent page holds no native bridge. Delta Chat avoided measuring with a separate window. None does the inline, isolated and measured combination Aplos needs.

---

## 7. Recommended design

**Origin.**
- Register `aplos-mail` with `registerSchemesAsPrivileged`, privileges `{standard:true, secure:true}` only: no `bypassCSP`, fetch, CORS, service workers or streaming.
- Handle it with `protocol.handle` on the default session.
- Use one host for all mail, `aplos-mail://m/<token>`. The token is 128-bit random and maps in main to `{account, messageId, imagePolicy, findQuery}`. It is single-render and dies with the reader.
- Subresources: `…/<token>/cid/<n>` and `…/<token>/img/<n>`.
- Move the sanitizer into the engine, where bodies are stored raw and sanitised on read (Superlocal's idea, so sanitizer fixes reach old mail). The renderer never parses untrusted HTML again.
- The same URL can later be served by a local daemon over HTTP to the browser preview or a phone, with identical headers [I].

**Response headers.**
```
Content-Security-Policy: default-src 'none'; script-src 'sha256-<reporter>'; style-src 'unsafe-inline';
  img-src aplos-mail: data:; font-src aplos-mail: data:; media-src 'none'; connect-src 'none';
  frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none';
  base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-popups
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-store
```

**iframe.**
```
sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer" allow="" tabindex="-1"
style="color-scheme: light"
```
- Never add `allow-same-origin`, `allow-forms`, `allow-modals`, `allow-top-navigation*` or `allow-popups-to-escape-sandbox`; Aplos always denies popups anyway.
- The header `sandbox` and the attribute are each sufficient alone. Keep both.

**Host page CSP (`index.html`).**
- Add `frame-src aplos-mail:`.
- Drop `https:` from `img-src` once nothing else needs it.
- Keep `frame-src` strict so that it fails closed. Links never navigate the frame because the sanitizer rewrites them.

**Sanitizer (engine). Allowlist:**
- Keep `<style>` and `style` attributes. Remove `url()` except rewritten cid and proxy URLs, and remove `@import` and `@font-face` with remote sources.
- Strip `script`, `meta`, `link`, `base`, `form`, inputs, `iframe`, `object`, `embed` and SVG `foreignObject`.
- Rewrite every `<a href>` that uses http, https or mailto to `target=_blank rel="noopener noreferrer"`. Drop other schemes.
- Drop tracking pixels.
- Wrap quoted history in `<details>`, which toggles natively.
- Inject the base reading CSS: margins, `max-width:100%` on images and tables, `html{overflow:hidden}`.

**Measurement.** One small reporter script whose hash goes in the CSP.
- It posts `{token, h, w, bg, ready, marks:[y…]}` on: end of body, `resize`, `load`, ResizeObserver, `fonts.ready` and `<details>` toggle.
- It reports only when `innerWidth > 0`.
- The parent accepts a message only if `event.source === frame.contentWindow`, `origin === 'null'`, the token matches, and `h` is a finite number within a clamp (for example 1–200,000). The colour must parse strictly.
- `ready` fires at `load`, which waits for local cid images and fonts, or 300 ms after the first report, whichever is first.

**Keyboard.** In main:
```
wc.on('before-input-event', (e, i) => { const f = wc.focusedFrame; if (f && f !== wc.mainFrame
  && f.url.startsWith('aplos-mail:') && i.type === 'keyDown' && !i.meta && !i.control && !i.isComposing)
  { e.preventDefault(); wc.send('aplos:event', {type:'mail-key', key:i.key, shift:i.shift, alt:i.alt}); } });
```
- The renderer feeds this into its single shortcut registry. Arrows, Space and Page keys scroll the reader, because frames are auto-height.
- Esc returns focus to the reader.
- ⌘C and ⌘A go to the frame through the Edit menu roles.
- **Before building on it, test by hand that this fires with focus inside an OOPIF.** If it doesn't, the fallback is a *non-destructive-only* key relay from the frame script: J/K, scrolling and Esc only, never E, Space or R.

**Navigation.**
- `setWindowOpenHandler`: validate the URL (http, https or mailto, no credentials), open it externally or route mailto to Compose, and return `deny`.
- `will-frame-navigate`: cancel anything outside `aplos-mail:`.
- Show the `update-target-url` status line on hover.
- `assertCaller` stays as is. It already rejects subframe IPC.

**Image policy.**
- **Default:** no network. cid images served. Remote images replaced by a placeholder that keeps the `width` and `height` attributes, so layout doesn't jump, plus a "Load images" line *outside* the frame.
- **Per-sender opt-in:** rewrite images to proxy indexes and re-render with a new token.
- **Backstop:** a session `webRequest` filter cancels any http, https, ws or wss request whose initiator is `'null'` or whose frame URL starts with `aplos-mail:`.

**Plain-text mail** renders as escaped host DOM, with no frame.

**Two alternatives.**
- **Interim (1–2 days).** Option (a) with an inner meta CSP equal to the header above minus `sandbox` and with `script-src 'none'`, the same sanitizer moved to the engine, and the same keyboard and link handling. It gives synchronous measurement but no process isolation.
- **Pop-out and print.** Use Delta Chat's model: a `WebContentsView` with `javascript:false` and its own offline session, sized by `preferred-size-changed`.

---

## 8. Verified vs unverified

| Claim | Status | Evidence |
|---|---|---|
| Electron 44.7.2 ships Chromium 152.0.7977.149 | V | `out/result-*.json` |
| `srcdoc` inherits the host CSP; the inner meta CSP is also enforced | V | `result-A_raw.json` / `result-A.json` console |
| A custom-scheme frame does not inherit the host CSP; the header is load-bearing | V | `result-C_raw.json`: 14 requests |
| The sandbox without `allow-scripts` refuses meta refresh; with `allow-scripts` the refresh runs | V | A/B/C vs B2/C2 |
| A hash-pinned script runs while the email's inline script and handler are blocked | V | B2, C2 |
| `WebFrameMain.executeJavaScript` gets "Script not run" in script-disabled frames | V | A, B, C, C_so |
| Isolated-world preload listeners don't fire in a script-disabled frame | V | `result-C_pre.json`, `result-B_pre.json` |
| A view with `javascript:false` gives height via `preferred-size-changed`, and `executeJavaScriptInIsolatedWorld` works there | V | `result-D.json` |
| `frame-sizing` is unsupported | V | `frameSizing:false` |
| Opaque sandboxed frames run out of process, 20 in one process; custom origin: one process per host | V | `*-mem.json` |
| Memory table | V (synthetic mail) | `*-mem.json` |
| Measurement latency, and pending frames report while hidden | V | `result-timing-*.json` |
| Early out-of-process reports are wrong until width > 0 | V | First timing run |
| `before-input-event` plus `focusedFrame` plus `preventDefault` for a same-process subframe | V | `result-A*.json` |
| `before-input-event` for OOPIF focus | S/I, **U in harness** | Electron and Chromium source |
| `setWindowOpenHandler` for `_blank` from a same-process frame | V | A popups |
| …from an OOPIF or a view | U | Input not routable in the harness |
| `will-frame-navigate` cancels link, refresh and nested-frame navigations; CSP-blocked navigations skip it and leave an error page | V | A-open, C2-open, A |
| DNS prefetch bypasses CSP and `webRequest` | V | `netlog-*.json` |
| Mail-frame request initiator is `'null'` (custom origin) vs `file://` (`srcdoc`) | V | net logs |
| cid images via the custom scheme in an opaque frame | V | `single-C_cid.png` |
| Find, print and context menu across OOPIFs | U | — |
| A warm hidden mail frame keeps the process hot | U/I | — |
| `webRequest` allows one listener per event | U | Memory of the docs |

---

## 9. What the UI plans (SYNTH-ui §4 Reader) must change

1. **The double-buffer completes on a message, not a layout read.**
   - Expect 15–70 ms; keep 1.5 s as the hard ceiling only.
   - Mount the pending frame at the *final width*. Any hiding method works.
   - Ignore reports whose width doesn't match.
   - Keep one hidden mail frame mounted, so J/K never pays process start-up (about 65 ms cold).
2. **The paper tint arrives in the same message as the height,** so the card colour is known at swap time. HTML paper is always light (`color-scheme: light` on the iframe *and* the document). Plain text follows the theme and needs no frame.
3. **Selection is per message.** Each body is its own document, so ⌘A selects one message and nothing selects across messages. If thread-wide copy is wanted, add an explicit "Copy thread" action served by the engine.
4. **Clicking into a body moves focus into the frame.**
   - Show a focus state on the card.
   - J/K, E, L, Space, R and / keep working through the main-process relay.
   - Esc returns focus. Because the reader scrolls, not the frame, Space and the arrow keys must scroll the reader.
5. **Quoted-text toggles and find highlights move into the document,** rendered by the engine. The "…" button becomes an in-document `<details>`. Changing the find query or loading images re-renders with a new token and swaps through the same double-buffer.
6. **Never animate frame height.** Late growth from images or fonts is applied instantly. Motion stays on the card container (transform and opacity), which composites fine around an OOPIF [I].
7. **The "Load images from this sender" line lives outside the frame,** in host chrome, because the frame can't host trusted UI.

## 10. Open questions for the owner

1. Is a single hash-pinned script inside mail frames acceptable? It is the cost of measuring with process isolation. If not, the choice is (a) (no isolation) or views (no inline layout).
2. One mail origin (one process, best for memory), or one origin per thread (isolates threads, +18 MB per open thread)?
3. Should the proxy fetch allowed images when mail arrives, to hide open time from senders, or only on view?
4. Remote web fonts: never, or proxied when images are allowed?
