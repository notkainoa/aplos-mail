# Mail frame reporter protocol

**Status: draft, host side only (proposed).** Shared with `eng-html`, which is parked. This file records what the host
(`MailFrame`, lane `ui-reader`) sends, accepts and assumes. `eng-html` owns the in-frame reporter and must agree to
this before either side relies on it. Sources: plan 30 section 4.4, research
`email-clients/gaps/electron-email-html-isolation.md` sections 3, 7 and 9.

## Two sources behind one component

|                                | `srcdoc` (stand-in engine, development only)                                                                | `aplos-mail://m/<token>` (final)                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Sanitiser                      | `sanitise.ts` in the renderer, run on the stand-in's `MailFrame.srcdoc`                                     | the engine's, served by main                                    |
| Mounted                        | Vite dev builds only (`import.meta.env.DEV`); elsewhere a `srcdoc` answer shows "Couldn't load this email." | always                                                          |
| `sandbox`                      | `allow-same-origin` only, never `allow-scripts`                                                             | `allow-scripts allow-popups`, never `allow-same-origin`         |
| CSP                            | inner `<meta>`, first in `<head>` after `x-dns-prefetch-control: off`, plus the host page's inherited CSP   | response header (host CSP is not inherited)                     |
| Scripts in the frame           | none                                                                                                        | one hash-pinned reporter                                        |
| Height and paper tint          | read by the host from `contentDocument`                                                                     | reporter `size` messages, validated below                       |
| Keys with focus inside         | host listener on the frame document, short key list only                                                    | main's `before-input-event` (fallback: reporter `key` messages) |
| Links                          | host click listener cancels, opens outside                                                                  | `setWindowOpenHandler` in main, `will-frame-navigate` cancels   |
| No report within 10 s          | "Couldn't load this email." with Try again (`deadline.ts`)                                                  | the same                                                        |
| Notices (flattened, truncated) | host DOM above the frame                                                                                    | host DOM above the frame (needs the flags from the engine)      |

Both are mounted at the slot's final width, kept hidden until they report, and swapped in place (double buffer).

## Why the srcdoc frame is same-origin (development only)

`allow-same-origin` is allowed in development builds only. `useFrameSource` refuses a `srcdoc` answer unless
`import.meta.env.DEV` is true and shows the body-failed state instead, so a packaged build can never mount a
same-origin frame even if the stand-in engine answers with `srcdoc`. Tests pin that the `srcdoc` sandbox never contains
`allow-scripts` and that no sandbox constant holds both tokens.

The scriptless frame has to be measured, and with no script inside it the only way is for the parent to read the
document. Research section 3 tried everything else and all of it failed: main-process `executeJavaScript` ("Script not
run"), an isolated-world preload in the subframe (its listeners never fire without `allow-scripts`), and CSS-only
sizing (`frame-sizing` is unsupported). A second "measuring" frame would parse the same hostile HTML in the same
process with the same origin, so it adds nothing. Sanitising into the host's own DOM (or a shadow root) would remove
the sandbox fence entirely. So the least-risk option is option (a) of research section 1: `sandbox="allow-same-origin"`
with no `allow-scripts`.

What that costs, and why it is acceptable here:

- No script can run in the frame (sandbox), so nothing in it can use the shared origin to reach `parent`, `aplos`,
  storage or cookies. The Playwright spec runs every corpus item **without** the sanitiser and confirms no script,
  handler or refresh ran and nothing navigated.
- The frame shares the renderer process that holds Aplos's IPC, so a no-JS memory bug (image, font or CSS decoder)
  would land there (research section 1, last row). This is why the path is development only: builds the owner
  installs use `aplos-mail://` (contract `MailFrame.srcdoc`, FR-34). The contract comment says the stand-in frame sits
  "inside `sandbox=""`"; this host uses `allow-same-origin` for the reason above and asks the contract owner to update
  that comment (REQUEST in the lane report).

Measurement: `documentElement.getBoundingClientRect().height` once at `load`, then a parent-side `ResizeObserver` on
the root element for late growth (images when loading is allowed). The host's styles sit in `@layer aplos`, declared
first in `<head>`; its measuring rules force `html, body { display:block; position:static; float:none; overflow:hidden;
height:auto; min-height:0; max-height:none }`, all `!important`, so the root's box is the content height. The
sanitiser strips every `!important` (and `!`) and every `@layer` from the email's CSS, inline styles included, so no
email rule can beat them at any specificity. Find marks use a per-instance `data-find-<random>` attribute locked with
`all:unset !important`, so the email can neither select nor restyle them. The flattened and truncated notices are host
DOM above the frame, never inside it, so the email cannot hide or fake them. Paper tint: the computed
`background-color` of `body`, else `html`, through `parseBg`; transparent or unparsable means light paper.

Cost fences (the sanitiser runs synchronously on the renderer's main thread, also for a hidden prefetched slot): every
CSS step is linear (indexOf scans, no backtracking patterns), a `<style>` block is cut at 200,000 characters and a
`style` attribute at 8,000 (the remainder dropped), `colspan`/`rowspan`/`span` are clamped to 1-100 and each cell counts
`colspan x rowspan` toward the 5,000-cell cap. Plain-text link detection trims punctuation in one backward scan and
leaves candidates over 2,000 characters as text. With images loading, an https `url()` inside a `:hover`, `:active`,
`:focus` or `[open]` rule is dropped (it would report the gesture), and so is an image sized 0-1 px or em by its
`style` attribute.

## Messages from the reporter (`aplos-mail` source)

The host listens on `window` for `message` events. Every message is a plain object (prototype `Object.prototype` or
null) with a string `t`, a string `token` and only the fields its type lists below: any other own key (`__proto__`,
`constructor`, `prototype`, anything extra), a symbol key, a getter, more than six fields, a string, an array or a
class instance rejects it. Fields are read as own data properties only, so a polluted `Object.prototype` cannot fill
in a missing one.

```ts
{ t: 'size', token, h: number, w: number, bg: string, ready?: boolean } // after layout, resize, load, fonts, <details>
{ t: 'key',  token, key: string, shift?: boolean, alt?: boolean }        // fallback relay only
```

The host accepts a message only when all of these hold (`protocol.ts` `acceptReport`, unit-tested with spoofs):

1. `event.source === iframe.contentWindow` of this instance (null before mount: nothing is accepted);
2. `event.origin === 'null'` (an opaque sandboxed frame);
3. `data.token` is a string equal to this render's token (the URL path segment, 128-bit random, single render);
4. for `size`: `h` is a finite number in 0-200,000 (rounded up, at least 1; NaN, negative, above 200,000 or a
   non-number is rejected); `w` is a finite number within 1 px of the slot width (rejects the out-of-process
   first-report pitfall of 0 or ~43,000 px); `bg` is parsed strictly (`rgb()`/`rgba()` with integer channels at full
   alpha, `#rgb`, `#rrggbb`) and anything else falls back to the light paper token without rejecting the report;
5. for `key`: `key` is one of the non-destructive fallback keys (J, K, arrows, Page Up/Down, Home, End, Escape),
   never E, Space, R or L.

The Playwright spec forges every case against a scripted stand-in sealed frame: a sibling frame and a child frame of
the email with the right shape and token (wrong source), the frame itself with a wrong or empty token, an oversized,
NaN, infinite, negative or string height, a wrong width, `__proto__` and `constructor` shapes, a string or array
payload, unlisted keys (R, E, Space), and host-realm events with the frame's window as source but the wrong origin.
Before and after the genuine report, none of them changes the height, the reported paper or the keys.

The first accepted `size` swaps the letter in and fires `onReady({height, bg, blocked})`; later ones only resize.
Heights are applied instantly and never animated.

## Deadline

A frame that has not reported within `timeoutMs` (default `FRAME_TIMEOUT_MS`, 10 s; `deadline.ts`) shows the failed
state, "Couldn't load this email." with Try again, in place of the loading line and of the frame: the silent frame is
unmounted, and a report that still reaches the host after the deadline is refused. The clock starts when a frame
letter becomes pending (sealed or srcdoc, which can also stay silent if its document never loads), restarts for each
new letter, stops at the first accepted report and is cancelled on unmount. Try again asks `Mail/frame` again (a new
token) and starts a fresh wait. Plain text measures synchronously and has no deadline. The fetch before a source exists
(`MessageBody/get`, `Mail/frame`) is not covered: those fail through the data layer. Changing the policy or the find query asks `Mail/frame` again and
goes through the same buffer with a new token.

## What the host promises the frame

- It never sends the frame messages (no `postMessage` to the frame today; a `{token, toggleQuotes}` message is a
  proposal for the O key and needs `eng-html`'s approval).
- It releases each token with `Mail/release` once its letter has been replaced or unmounted.
- It shows "Load images from this sender" and "N trackers removed" outside the frame (the `blocked` count from
  `onReady`; for `aplos-mail` it is `MailFrame.trackersRemoved`).

## Keys

`onKey` receives `{key, shift, alt}` only for the short key list both frames share (`FALLBACK_KEYS`: J, K, arrows,
Page Up/Down, Home, End, Escape), unmodified (no Ctrl or Cmd, not composing). R, E, Space and every other letter stay in
the frame, so nothing typed or tapped in a letter reaches an app command, and a tap of R there can never start or leave
the hold-R dictation (the srcdoc relay sends keydowns only and never a keyup; no listed key is a hold key). Keydown
events do not cross frame boundaries, so the frame's relay is the only delivery: the Playwright spec presses J inside
the frame and sees exactly one relayed key and no host keydown, and presses R, E, Space and letters (and holds R past
the hold threshold) and sees nothing relayed. When `onKey` returns true the host cancels
the key in the frame. In the `aplos-mail` source, main's `before-input-event` relay and the reporter's fallback must
never both be on in one build, or a key would arrive twice; whether `before-input-event` fires with focus inside an
out-of-process frame is still unknown (live check on a Mac).

## Observed

- Without the sanitiser, Chromium attempted 31 loads from the corpus behind the sandbox and inner CSP; every one was
  blocked in the renderer (`csp`, `origin`) and none reached the network layer. Chromium still reports them as request
  attempts, and research section 1 saw a real DNS lookup for `dns-prefetch` despite CSP, so the sanitiser is what
  makes the count zero. With it: zero attempts for every corpus item.

## Before `aplos-mail://` ships

Requirements on the sealed path (main, the engine and the reporter), none of which the `srcdoc` stand-in meets:

1. The frame's sandbox never contains `allow-same-origin` (and the host never adds it).
2. CSP as a response header on every `aplos-mail://` response: `default-src 'none'`, `script-src` pinned to the
   reporter's hash only, `img-src aplos-mail: data:` (never `https:`: loaded images come through the engine's proxy
   as `img/<n>`, ARCH 10), `style-src 'unsafe-inline'`,
   `form-action 'none'`, `base-uri 'none'`.
3. DNS prefetch off (`X-DNS-Prefetch-Control: off` header, and the `<meta>` in the document).
4. Main denies every navigation of the frame away from `aplos-mail:` (`will-frame-navigate`, `will-navigate`,
   `setWindowOpenHandler` opening outside only), and allows the `aplos-mail:` document itself as a subframe
   (`SUBFRAME_DOCUMENTS` in `src/main/security.ts` lists only `about:blank` and `about:srcdoc` today; REQUEST to
   `eng-host`). mailto links go to `shell.openExternal` today (the system mail handler); routing them to Compose is a
   main change for html-4.
5. The frame runs in a separate process from the renderer that holds the IPC bridge.
6. Never both main's `before-input-event` relay and the reporter's `key` fallback in one build.
7. The engine sanitiser carries the cost fences above (linear CSS, style caps, span clamp and weighted cell count),
   strips `!important` and `@layer`, drops gesture-only `url()` and style-sized pixels, and reports the flattened and
   truncated flags with the frame so the host shows the notices outside it (REQUEST to `eng-html`).

## Open for eng-html

1. Agree the message shapes and the fallback key set above.
2. Who owns the reporter's width gate (`innerWidth > 0`) and the `ready` rule (load, or 300 ms after the first report).
3. The O key: re-render with a new token, or a verified `{token, toggleQuotes}` message.
