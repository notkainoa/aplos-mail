# Mail frame reporter protocol

**Status: draft, host side only (proposed).** Shared with `eng-html`, which is parked. This file records what the host
(`MailFrame`, lane `ui-reader`) sends, accepts and assumes. `eng-html` owns the in-frame reporter and must agree to
this before either side relies on it. Sources: plan 30 section 4.4, research
`email-clients/gaps/electron-email-html-isolation.md` sections 3, 7 and 9.

## Two sources behind one component

| | `srcdoc` (stand-in engine, development only) | `aplos-mail://m/<token>` (final) |
|---|---|---|
| Sanitiser | `sanitise.ts` in the renderer, run on the stand-in's `MailFrame.srcdoc` | the engine's, served by main |
| `sandbox` | `allow-same-origin` only | `allow-scripts allow-popups`, never `allow-same-origin` |
| CSP | inner `<meta>`, first in `<head>`, plus the host page's inherited CSP | response header (host CSP is not inherited) |
| Scripts in the frame | none | one hash-pinned reporter |
| Height and paper tint | read by the host from `contentDocument` | reporter `size` messages, validated below |
| Keys with focus inside | host listener on the frame document | main's `before-input-event` (fallback: reporter `key` messages) |
| Links | host click listener cancels, opens outside | `setWindowOpenHandler` in main, `will-frame-navigate` cancels |

Both are mounted at the slot's final width, kept hidden until they report, and swapped in place (double buffer).

## Why the srcdoc frame is same-origin

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
the root element for late growth (images when loading is allowed). A final `<style>` forces
`html, body { overflow:hidden; height:auto; min-height:0; max-height:none }` (all `!important`) so the root's box is the
content height. Paper tint: the computed `background-color` of `body`, else `html`, through `parseBg`; transparent or
unparsable means light paper.

## Messages from the reporter (`aplos-mail` source)

The host listens on `window` for `message` events. Every message is an object with a string `t` and a string `token`.

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

The first accepted `size` swaps the letter in and fires `onReady({height, bg, blocked})`; later ones only resize.
Heights are applied instantly and never animated. Changing the policy or the find query asks `Mail/frame` again and
goes through the same buffer with a new token.

## What the host promises the frame

- It never sends the frame messages (no `postMessage` to the frame today; a `{token, toggleQuotes}` message is a
  proposal for the O key and needs `eng-html`'s approval).
- It releases each token with `Mail/release` once its letter has been replaced or unmounted.
- It shows "Load images from this sender" and "N trackers removed" outside the frame (the `blocked` count from
  `onReady`; for `aplos-mail` it is `MailFrame.trackersRemoved`).

## Keys

`onKey` receives `{key, shift, alt}` for unmodified keys only (no Ctrl or Cmd, not composing, not a bare modifier).
Keydown events do not cross frame boundaries, so the frame's relay is the only delivery: the Playwright spec presses
J inside the frame and sees exactly one relayed key and no host keydown. When `onKey` returns true the host cancels
the key in the frame. In the `aplos-mail` source, main's `before-input-event` relay and the reporter's fallback must
never both be on in one build, or a key would arrive twice; whether `before-input-event` fires with focus inside an
out-of-process frame is still unknown (live check on a Mac).

## Observed

- Without the sanitiser, Chromium attempted 31 loads from the corpus behind the sandbox and inner CSP; every one was
  blocked in the renderer (`csp`, `origin`) and none reached the network layer. Chromium still reports them as request
  attempts, and research section 1 saw a real DNS lookup for `dns-prefetch` despite CSP, so the sanitiser is what
  makes the count zero. With it: zero attempts for every corpus item.

## Open for eng-html

1. Agree the message shapes and the fallback key set above.
2. Who owns the reporter's width gate (`innerWidth > 0`) and the `ready` rule (load, or 300 ms after the first report).
3. The O key: re-render with a new token, or a verified `{token, toggleQuotes}` message.
