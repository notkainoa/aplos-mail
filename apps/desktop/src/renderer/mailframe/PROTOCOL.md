# Mail frame reporter protocol

**Status: host matched to the engine's reporter (html-5 host wiring).** The reporter is `eng-html`'s
`packages/mail-html/assets/reporter.js` (ARCHITECTURE 10, plan 10 E4); its message is the contract and the host
(`MailFrame`, lane `ui-reader`) accepts exactly it. This file records what the host sends, accepts and assumes, where
the host is stricter than the reporter needs, and what is still owed by the engine and main. Sources: plan 30 section
4.4, ARCHITECTURE 10, research `email-clients/gaps/electron-email-html-isolation.md` sections 3, 7 and 9.

## Two sources behind one component

|                                | `srcdoc` (stand-in engine, development only)                                                                | `aplos-mail://m/<token>/` (final)                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Sanitiser                      | `sanitise.ts` in the renderer, run on the stand-in's `MailFrame.srcdoc`                                     | the engine's, served by main                                    |
| Mounted                        | Vite dev builds only (`import.meta.env.DEV`); elsewhere a `srcdoc` answer shows "Couldn't load this email." | always                                                          |
| `sandbox`                      | `allow-same-origin` only, never `allow-scripts`                                                             | `allow-scripts allow-popups`, never `allow-same-origin`         |
| CSP                            | inner `<meta>`, first in `<head>` after `x-dns-prefetch-control: off`, plus the host page's inherited CSP   | response header (host CSP is not inherited)                     |
| Scripts in the frame           | none                                                                                                        | one hash-pinned reporter                                        |
| Height and paper tint          | read by the host from `contentDocument`                                                                     | the reporter's `{token,h,w,bg,ready,marks,plain}`, validated below    |
| Keys with focus inside         | host listener on the frame document, short key list only                                                    | main's `before-input-event` relay, heard by `useSealedMailKeys` |
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

The reporter learns its token from its own URL (`location.pathname.split('/')[1]`, 32 lowercase hex, else it stays
silent for good). There is no handshake and the host never posts to the frame. The reporter posts one message shape to
`parent` with target `'*'`, on its own load (it is the last element of the body), `DOMContentLoaded`, `load`, `resize`,
`<details>` `toggle`, `fonts.ready` and a `ResizeObserver` on the root element, and only when `innerWidth > 0`:

```ts
{ token: string, h: number, w: number, bg: string, ready: boolean, marks: number, plain: boolean }
// h = max(root.scrollHeight, body.scrollHeight) clamped to 0-1,000,000; w = innerWidth clamped to 0-100,000;
// bg = getComputedStyle(body).backgroundColor cut to 64 chars; ready = readyState === 'complete';
// marks = count of mark.aplos-find clamped to 0-100,000. All numbers rounded.
// plain = documentElement has `data-aplos-plain`, which only the sanitiser sets (mail-html/src/plain.ts; a mail cannot, data-* is
// dropped). It is the ONLY signal that lets the host draw a letter flush on the reader card; `bg` is a colour the mail chooses and
// is never one. A report with the older six fields is accepted and means not plain.
```

The host listens on `window` for `message` events and accepts one only when all of these hold (`protocol.ts`
`acceptReport`, unit-tested with spoofs, and end to end against the real reporter in `browser/sealed.browser.spec.ts`):

1. `event.source === iframe.contentWindow` of this instance (null before mount: nothing is accepted);
2. `event.origin === 'null'` (an opaque sandboxed frame);
3. the payload is a plain object (prototype `Object.prototype` or null) whose own keys are exactly the six above, each
   a data property (no getter, no symbol key, no `__proto__`, `constructor`, `t` or anything extra; a missing field
   rejects it, and a polluted `Object.prototype` cannot fill one in);
4. `token` is a string equal to this render's token (`tokenOf` reads it from the `Mail/frame` URL, which must be
   `aplos-mail://m/<32 lowercase hex>/`; any other URL fails the letter at once instead of waiting for the deadline);
5. `h` is a number in 0-1,000,000 (the reporter's range; NaN, negative, larger or non-numbers are rejected) and is
   shown clamped into 1-200,000, so a very long letter still shows, cut at 200,000 px;
6. `w` is a finite number above 0 within 1 px of the slot's content width (rejects the out-of-process first-report
   pitfall of 0 or ~43,000 px);
7. `ready` is a boolean and `marks` an integer in 0-100,000;
8. `bg` is a string, parsed strictly (`rgb()`/`rgba()` with integer channels at full alpha, `#rgb`, `#rrggbb`); the
   reporter's transparent `rgba(0, 0, 0, 0)` (an email with no background) or anything else falls back to the light
   paper token without rejecting the report.

The first accepted message swaps the letter in and fires `onReady({height, bg, blocked})` (it does not wait for
`ready: true`; later messages only resize). Heights are applied instantly and never animated. `marks` is validated and
kept on the report; the reader does not show a count from it yet.

The Playwright specs forge every case: against a scripted stand-in frame (`mailframe.browser.spec.ts`: a sibling frame
and a child frame of the email with the right shape and token, the frame itself with a wrong or empty token, an
oversized, NaN, infinite, negative or string height, a wrong width, bad `ready`/`marks`, `__proto__` and `constructor`
shapes, the draft `t`-typed shapes, a string or array payload, and host-realm events with the frame's window as source
but the wrong origin; none of them moves the height, the paper or the keys) and against the real reporter
(`sealed.browser.spec.ts`, below).

## Runaway growth

The host sizes the frame to the letter's height, and the letter lays out in that frame, so content sized in viewport
units grows with the frame: with the real reporter, `height:100vh` grew by the 32 px body padding at every frame
without end (370 messages in 3 s) and `height:150vh` reached the 200,000 px clamp in under a second; under load such a
letter took a renderer to 7.6 GB and stalled the host page. The srcdoc path loops the same way (its root measurement
follows the frame too). Neither sanitiser rewrites viewport units, so the host fences it (`growth.ts`): a letter may
grow 100 times, then keeps its height for good (both slots). A count, not a rate: a first rate-based fence (40 growths a
second) let a loop on a busy machine run slower than that and never stop. Unit-tested; the browser specs check that a
`100vh` letter settles on both paths and fail (poll timeout) with the fence removed. A letter that genuinely grows more
than 100 times (images arriving one by one) is frozen early and scrolls inside its frame. The real fix is the engine's
(REQUEST below).

LOW (Integrator, 2026-11-04 03:26): the fence counts growth only, so a letter whose endless animation keeps its height
was free to report on every frame (CPU, not memory). The bound is the reporter's (#263: at most 2,000 posts per width,
colour no longer a reason to post). The host adds no freeze after N reports of any kind: it would freeze a letter
during a legitimate resize drag (Integrator NOTICE 10:40); if the host fence is ever touched, exempt reports whose
width changed.

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

- It never sends the frame messages: the reporter has no listener, and the O key re-renders through
  `Mail/toggleQuotes` with a new token.
- It releases each token with `Mail/release` once its letter has been replaced or unmounted.
- It shows "Load images from this sender" and "N trackers removed" outside the frame (the `blocked` count from
  `onReady`; for `aplos-mail` it is `MailFrame.trackersRemoved`).

## Keys

`onKey` receives `{key, shift, alt}` only for the short key list (`keys.ts` `FALLBACK_KEYS`: J, K, arrows, Page
Up/Down, Home, End, Escape), unmodified (no Ctrl or Cmd, not composing). R, E, Space and every other letter stay in the
frame, so nothing typed or tapped in a letter reaches an app command, and a tap of R there can never start or leave the
hold-R dictation (the srcdoc relay sends keydowns only and never a keyup; no listed key is a hold key). Keydown events
do not cross frame boundaries, so the frame's relay is the only delivery: the Playwright spec presses J inside the
srcdoc frame and sees exactly one relayed key and no host keydown, and presses R, E, Space and letters (and holds R past
the hold threshold) and sees nothing relayed. When `onKey` returns true the host cancels the key in the frame.

The sealed frame relays **no** keys: the real reporter has no key message (ARCHITECTURE 10: it posts its six fields
"and nothing else"), so the host no longer accepts the draft `{t:'key'}` fallback at all. `sealed.browser.spec.ts`
presses every listed key, R, a held R, E, Space and Enter inside the real frame and sees nothing relayed and no host
keydown. The sealed frame's keys come from main instead (eng-host, `host/protocol/frame-keys.ts`): `before-input-event`
fires for the out-of-process frame's keys (measured), and main sends the embedding window's renderer one message on
`aplos:mail-key`, `{ key }`, only when the focused frame is the sealed `aplos-mail://m/<token>/` document, only for a
listed key (`shared/mail-keys.ts` `MAIL_KEYS`, which `FALLBACK_KEYS` is built from), keydown only, **no** Ctrl, Cmd or Alt
and Shift only for J and K, **no** auto-repeat. Main validates the message before it sends and preload before it
delivers it, as the event `{ type: 'mail-key', payload: { key } }` to `window.aplos.subscribe` listeners (never queued). The key hook subscribes with `window.aplos.subscribe(listener, { only: ['mail-key'] })`: a listener that names its types hears only those and never takes the deep-link, command and prepare-close events that wait for the app's own first plain subscribe.
Main does not cancel the key, so an arrow or Page Down still scrolls the letter; the shell decides what it handles.
The sealed slot maps it to the same `onKey` path and never also listens to the frame (the srcdoc listener never runs
for a sealed frame, and main never relays a srcdoc frame's keys): "mail-key wiring" below.

## mail-key wiring

`UrlSlot` (the sealed slot, never the srcdoc one) calls `useSealedMailKeys`, which subscribes through
`window.aplos.subscribe` while the slot is mounted (no bridge, as in the browser preview or the stand-in: no
subscription) and unsubscribes on unmount. Each `{ type: 'mail-key', payload: { key } }` goes through
`sealedMailKey` (`sealedKeys.ts`) and, if accepted, to the slot's `onKey` as `{ key, shift: false, alt: false }`, the
same path the srcdoc relay uses, so the reader's `relayToShell` resolves it through the shell's one key listener and
registry exactly like a key typed on the page. Nothing is cancelled (there is no event to cancel) and nothing is
dispatched into the DOM tree. Anything that is not a listed key (`isMailKey`) is dropped silently. The guards, read
when the key arrives:

1. **Focus.** The slot's iframe element is `document.activeElement`, the slot is the double buffer's shown letter (not
   the pending one) and no ancestor is `inert` (the reader's off-paper letter). This ties the key to the letter being
   read, and since only one element can have focus, exactly one of all the mounted slots takes it: no dedupe by time.
2. **One path per letter.** The sealed slot installs no keydown listener anywhere; the subscription is its only key
   path (the browser spec records every key listener the mount adds: none).
3. **Top-most layer first.** When anything sits above the reader the key is dropped, Esc included, instead of being
   handed on: a modal context (menu, date picker, dialog, palette, sheet, low importance), the composer (`compose`)
   or Ask on the shell's key layers or open sheet, an open overlay in the host DOM (role `dialog`, `alertdialog` or `menu`,
   `aria-modal="true"`, `data-keyctx`, as the shell's `overlayContexts` reads them), or a host layer marked `data-keylayer`
   (the reader's find bar). A key relayed from inside an email can never close or cancel anything above the letter.
   Every new overlay MUST carry at least one of those markers (role `dialog`/`alertdialog`/`menu`, `aria-modal`, `data-keyctx`
   or `data-keylayer`): the check reads only the markers, so an overlay with none of them is invisible to it and the check fails open.

4. **Reader allowlist.** Main validates the full shared list (`isMailKey`), then the sealed path hands on only
   `SEALED_READER_KEYS`: j, k, J, K and Escape. Main relays without cancelling (it cannot cancel a key from an
   out-of-process frame), so a sealed letter's ArrowUp/ArrowDown would otherwise both scroll the letter and step the
   reader's message cursor (`reader.nextMessage`/`previousMessage`), unlike the srcdoc path, where a handled key is
   cancelled in the frame. ArrowUp, ArrowDown, Page Up/Down, Home and End are ignored, so the letter scrolls natively;
   with focus on the page (not in the letter) the arrows still step messages. This is the one deliberate divergence
   from the srcdoc relay, which keeps the full list.

**Letters, never shift.** Main cannot tell Caps Lock J from Shift+J: both arrive as `J`. The relayed key is the letter,
lower-cased, with no shift (`J`/`K` become `j`/`k`, whatever a payload says about shift), so j, Caps Lock J and Shift+J
all run Next email. A Shift+J typed on the page itself is bound to nothing in the reader catalog (pinned in
`screens/reader/mailKeys.test.ts`).

## Observed

- Without the sanitiser, Chromium attempted 31 loads from the corpus behind the sandbox and inner CSP; every one was
  blocked in the renderer (`csp`, `origin`) and none reached the network layer. Chromium still reports them as request
  attempts, and research section 1 saw a real DNS lookup for `dns-prefetch` despite CSP, so the sanitiser is what
  makes the count zero. With it: zero attempts for every corpus item.

## Verified against the real reporter (`browser/sealed.browser.spec.ts`)

Headless Chromium. Each document is built by the engine (`render` from `@aplos/mail-html`, then `withReporter`),
issued a token by the engine's `FrameTokens` and answered by the engine's `serveFrame` (status, body, every header),
into `<iframe sandbox="allow-scripts allow-popups">` mounted by the real `MailFrameView`. The one stand-in is the
scheme: `aplos-mail://m/<token>/<path>` is served as `http://sealed.test/<token>/<path>`, a different site from the
host page, and the CSP's `aplos-mail:` source is mapped to that origin. Checked, 5 repeats:

- the reporter's genuine messages size the host: `onReady` once with the right height and `bg`, the frame shown at
  that height; the frame's origin is `'null'`, storage and `parent.aplos` throw `SecurityError`, an inline script added
  to it is refused by `script-src-elem`; the document is served once (single render) and its `cid/0` is answered 404;
- it re-reports on a `<details>` toggle and on late growth (`ResizeObserver`);
- every engine corpus message with an HTML body (manifest entries; the 54 synthetic ones are not run here) and every
  host corpus item, through the engine sanitiser: the letter reports; no outbound request attempt, nothing at the
  network layer, no popup, only the frame's own document and `cid/<n>`/`img/<n>` URLs; every message that reached the
  host is the reporter's (its six keys, this token); `window.aplos`, the host URL and the frame URL unchanged; no key.
  The stress bodies (engine 089, 090, 133, 134 and the host span bomb) run only with `APLOS_MAILFRAME_STRESS=1`, one
  at a time, and may instead end in the failed state at the deadline; alone each reports in about a second, but 090
  (a 200,000 px frame spinning a 100,000 px blur every millisecond) intermittently starved every other worker in the
  5-repeat runs: under load (and before the growth fence) the span bomb missed the 10 s deadline and
  090 stalled the host page itself for over 90 s, because in this headless Chromium the frame shares the host page's
  renderer process (CDP lists no separate iframe target). That is item 5 below, and it matters for responsiveness as
  well as security;
- script in the email cannot post: an unsanitised document with an inline script, `onerror`, `onload`, a `data:`
  script, a nested `srcdoc` frame and a copy of the reporter with its post swapped, each posting a perfect forgery
  with the right token, under the engine's CSP: no forgery reaches the host and the canary image is refused before the
  network. Positive control: the same document without the CSP header makes the host take the forged height (same
  window, same token: only the hash tells them apart) and loads the canary, which also proves the harness sees what
  the out-of-process frame loads; the sandbox still keeps `window.aplos` and the host URL untouched;
- keys pressed in the frame (the short list, R, held R, E, Space, Enter) reach nothing;
- a frame with no reporter shows the failed state after the deadline; a document answered after the deadline is
  refused (the frame is gone); Try again on the same token is a 404 from the engine (a retry needs a new
  `Mail/frame` token, which `useFrameSource.reload` asks for).

## Before `aplos-mail://` ships

Requirements on the sealed path. Done means verified by a test; the rest is owed by the engine (slice 2) and main.

1. **Done (host).** The frame's sandbox is `allow-scripts allow-popups`, never `allow-same-origin` (unit test on
   `URL_SANDBOX`; the browser spec reads the mounted attribute).
2. **Done (engine builder + main, #241).** CSP as a response header: `frameHeaders` builds ARCHITECTURE 10's policy
   with the reporter's hash, and the browser spec runs every document under it; main's handler
   (`main/mail-protocol.ts`, `host/protocol/relay.ts`) passes the engine's headers through on every `aplos-mail://`
   response.
3. **Built, not verified live (open).** DNS prefetch off: `frameHeaders` sends `x-dns-prefetch-control: off`. The
   engine document has no `<meta>` for it (the srcdoc one does); a check through the real scheme handler is owed
   (eng-host).
4. **Done (main, #241).** The navigation allowance: `security.ts` allows the `aplos-mail:` subframe document only for
   the exact `aplos-mail://m/<32 hex>/`, only after `allowMailFrames()` and only when the app's own page started it;
   redirects, self-navigation and main-frame navigation are denied. **Still open:** mailto links go to
   `shell.openExternal` (`frame-links.ts`); routing them to Compose is a main change (eng-host).
5. **Scheme done (main, #241); isolation check open.** The scheme is registered `standard` and `secure` only, so the
   frame is its own site. **Still open:** a live check that the frame runs in a separate process from the renderer that
   holds the IPC bridge (e.g. an `iframe` target in CDP, in the packaged app). The browser spec's frame is cross-site
   yet shares the host's process there, so it proves nothing about isolation.
6. **Done (engine + main, #241).** `Mail/serve` answers GET only; main stamps the requesting window
   (`X-Aplos-Window`, every client spelling stripped) and is the backstop: another window's token is a 404.
7. **Done (host + main).** The reporter relays no keys, so the "never both relays" rule holds; main's
   `before-input-event` relay (#252) is consumed by the sealed slot ("mail-key wiring"). The packaged-app hand-check
   (a real key in a real sealed letter) stays with the owner.
8. **Engine sanitiser (eng-html).** The cost fences above (linear CSS, style caps, span clamp, weighted cell count),
   `!important` and `@layer` stripped, gesture-only `url()` and style-sized pixels dropped, and the flattened and
   truncated flags returned with the frame so the host shows the notices outside it. Not checked here.

## Open for eng-html (REQUESTs)

#249 addressed items 1, 2, 3 and 5 (content-height measuring, the root's colour as fallback, DOM members read from the
prototypes, viewport and container units rewritten to bounded px); they stay here for their history.

1. **The letter never shrinks.** The reporter's `h` is `max(root.scrollHeight, body.scrollHeight)`, and the root's
   `scrollHeight` is never less than the frame's own height, so once the host sizes the frame the reported height can
   only grow: closing a `<details>` leaves the old height (observed in the browser spec; the srcdoc path measures the
   root's box with `height:auto` rules and does shrink). Measure content, e.g. `documentElement.getBoundingClientRect()
   .height` with `html{height:auto;overflow:hidden}` in the reading CSS.
2. **Paper tint from `html`.** The reporter reads only `body`'s background; the srcdoc path falls back to the root's.
   An email that colours `<html>` only shows on light paper. Report the root's colour when the body's is transparent.
3. **DOM clobbering.** Document named properties override built-ins, so an unsanitised `<img name="body">`,
   `addEventListener`, `documentElement` or `querySelectorAll` silences the reporter for good (seen in Chromium; the
   letter then fails at the deadline) or feeds it another element. The sanitiser's `m-` namespacing for `name`/`id` is
   what prevents it (the corpus's dom-clobbering entries pass). Pin that with a test, or have the reporter read through
   `Document.prototype` getters it captures first.
4. **Quirks mode: done (#249); the image gap: done (`mail-html/7`).** Every served document starts with
   `READING_DOCTYPE` (`packages/mail-html/src/index.ts`): HTML 4.01 Transitional with its system identifier, which
   Chromium treats as almost-standards mode (`document.compatMode` still `CSS1Compat`). Heights follow the content (a
   `height="100%"` table or a `height:50%` band no longer fills a viewport; good in a frame sized to its letter),
   table text inherits the body's size, and a `<p>` in a cell keeps its margins (a few px of extra air); with the plain
   `<!DOCTYPE html>` the classic image gap also showed (an image alone in a table cell sat on the text baseline, a strip
   of the cell's background under every sliced-image row, 6 px at the reading CSS in Chromium, font-dependent). The
   almost-standards rule removes exactly that strip: cell 120 beside a 120 px image. Pinned in real Chromium by
   `reporter.e2e.ts` ("an image alone in a table cell leaves no baseline strip", with a control that shows the strip
   under `<!DOCTYPE html>`). The system identifier is a mode switch only; nothing fetches it. The development-only srcdoc frame (`document.ts`, scriptless, stand-in engine) still writes `<!doctype html>`, so a sliced-image letter shows the strip there and not in the sealed frame; ui-reader may adopt the same doctype when it next touches that file.
5. **Viewport units.** Rewrite `vh`, `vw`, `vmin`, `vmax` (and the `dvh`/`svh`/`lvh` family) to fixed lengths in
   the sanitiser, or lay the frame out at a fixed viewport height, so a letter's height cannot depend on its frame's
   ("Runaway growth"; the host's fence is the backstop, not the fix).
6. **The `ready` rule** stays the host's: the first accepted message swaps the letter in. The O key: re-render with a
   new token (`Mail/toggleQuotes`), no message to the frame.
