# Plan 001: The shipped reader keeps remote content off when "Load images" is off

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/improve/README.md` — unless a reviewer dispatched you and told you
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8a254600..HEAD -- apps/desktop/src/renderer/legacy/mailBody.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security (privacy)
- **Planned at**: commit `8a254600`, 2026-11-11
- **Suggested executor**: Claude Sonnet 5.5 (touches renderer code; security-sensitive but small)

## Why this matters

Release builds of Aplos still open mail in the **legacy reader**
(`apps/desktop/src/renderer/legacy/`). The new sealed mail frame only runs with
`APLOS_ENGINE=real`, which release builds never set
(`apps/desktop/src/host/transports/port.ts:63-65`). The legacy reader promises
"remote images hidden" until the owner clicks Load images, but its gate only
looks at `<img>` elements. DOMPurify's default allowlist keeps SVG `<image>`
(and `<feImage>`, `<use>`) with `href` / `xlink:href` pointing at `https:`, and
the production CSP allows `img-src https:`. So a sender can put a tracking
pixel inside an `<svg>` and learn when, and from which IP, the owner opened the
message, even with images off. The check also runs **before** sanitizing, so
anything DOMPurify reshapes is never re-checked. After this plan, the legacy
reader sanitizes first, removes SVG and MathML entirely (as the new sanitizer in
`packages/mail-html` already does), gates images on the sanitized result, and
computes "has remote images" from the same sanitized result.

## Current state

- `apps/desktop/src/renderer/legacy/mailBody.ts` — prepares a message body for
  the legacy reader (`prepareMessageBody`). It is the only sanitizer in the
  shipped app's mail path. Called only from
  `apps/desktop/src/renderer/legacy/Reader.tsx:53` and the dev fixture
  `apps/desktop/tests/fixtures/reader.html:14`.

Excerpt, `apps/desktop/src/renderer/legacy/mailBody.ts:62-80` (gate first, then
sanitize):

```ts
  const node = template(html);
  for (const image of node.content.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? '';
    if (options.spam) hideImage(image, 'Image hidden in Spam');
    else if (source.startsWith('cid:')) {
      const attachment = message.attachments.find(item => item.contentId === contentId(source));
      const ready = attachment && (attachment.data ? attachment : options.inline[attachment.id]);
      if (ready?.data && ready.type.startsWith('image/'))
        image.setAttribute('src', `data:${ready.type};base64,${ready.data}`);
      else hideImage(image, 'Inline image unavailable');
    } else if (!options.remote && !source.startsWith('data:'))
      hideImage(image, 'Remote image hidden');
  }
  // Strip background/srcset/style acquisition too, before any content is mounted.
  node.innerHTML = DOMPurify.sanitize(node.innerHTML, {
    FORBID_TAGS: ['style', 'link', 'iframe', 'form', 'input', 'video', 'audio', 'object', 'embed'],
    FORBID_ATTR: ['srcset', 'style', 'background', 'poster'],
  });
```

Excerpt, `apps/desktop/src/renderer/legacy/mailBody.ts:121-124` (counts only
`<img>` in the **unsanitized** input):

```ts
  const hasRemoteImages = [...template(html).content.querySelectorAll('img')].some(image =>
    /^https?:\/\//i.test(image.getAttribute('src') ?? ''),
  );
  return { body: node.innerHTML, quoted: quote.innerHTML, hasRemoteImages };
```

- The CSP the legacy page runs under: `apps/desktop/vite.config.ts:38`
  `"img-src 'self' data: blob: https:"`.
- DOMPurify version in the lockfile: 3.4.17 (`package-lock.json`, entry
  `node_modules/dompurify`). Its default SVG allowlist includes `image`, and
  its SVG filter list includes `feImage`.
- Reference for the right posture: the new sanitizer forbids `svg` and `math`
  outright (see `packages/mail-html/src/policy.ts`, and the tests in
  `packages/mail-html/tests/sanitize.test.ts`). Do **not** import it into the
  legacy reader; just match its decision for these two elements.

Conventions: the legacy renderer is frozen apart from fixes (AGENTS.md "Design
rule (revamp)" covers the new renderer; this file is legacy). Keep the change
inside `mailBody.ts`. Small named functions, no multi-statement one-liners
(AGENTS.md "Code hygiene").

## Commands you will need

| Purpose | Command (from the repo root) | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0, no errors |
| New browser test | `npx playwright test -c apps/desktop/src/renderer/legacy/browser/playwright.config.ts` | all pass |
| Lint | `npm run lint` | exit 0 |
| Full gate before commit | `npm run check` | exit 0 |

## Scope

**In scope** (the only files you should modify or create):
- `apps/desktop/src/renderer/legacy/mailBody.ts`
- `apps/desktop/src/renderer/legacy/browser/playwright.config.ts` (create)
- `apps/desktop/src/renderer/legacy/browser/entry.ts` (create)
- `apps/desktop/src/renderer/legacy/browser/mailBody.browser.spec.ts` (create)

**Out of scope** (do NOT touch):
- `apps/desktop/src/renderer/legacy/Reader.tsx` — the caller's contract
  (`{ body, quoted, hasRemoteImages }`) does not change.
- `packages/mail-html/**` and `apps/desktop/src/renderer/mailframe/**` — the new
  path is already correct.
- `apps/desktop/vite.config.ts` (the CSP) — tightening `img-src` would break
  the Load images button.
- Routing images through the host proxy (a separate, larger change; see
  Maintenance notes).

## Git workflow

- Branch from `origin/revamp`: `rv/improve/001-legacy-image-gate`.
- Commit message style (from `git log`): `Legacy reader: remote images stay off inside SVG too (improve 001)`.
- Run `npm run check` before every commit. Commits are authored as
  Kainoa Newton <k@kainoa.me>.
- Open a PR into `revamp` only if the operator told you to. Never touch `main`.

## Steps

### Step 1: Sanitize first, with SVG and MathML forbidden

In `prepareMessageBody`, move the `DOMPurify.sanitize` call so it runs on the
raw `html` **before** the image loop, and add `'svg'` and `'math'` to
`FORBID_TAGS`. Keep every existing forbidden tag and attribute. The target
shape:

```ts
const SANITIZE = {
  FORBID_TAGS: ['style', 'link', 'iframe', 'form', 'input', 'video', 'audio', 'object', 'embed', 'svg', 'math'],
  FORBID_ATTR: ['srcset', 'style', 'background', 'poster'],
};
// ...
const node = template(DOMPurify.sanitize(html, SANITIZE));
for (const image of node.content.querySelectorAll('img')) { /* the existing gate, unchanged */ }
```

Delete the old `node.innerHTML = DOMPurify.sanitize(...)` that ran after the
loop. The `data:` URLs the loop writes for inline `cid:` images are created by
this code, after sanitizing, which is what you want.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Compute `hasRemoteImages` from the sanitized fragment

Replace the `template(html)` scan at the end with a scan of the sanitized
`node` **as it was before the gate ran**. The simplest correct form: count
remote `<img>` sources inside the image loop in Step 1 (before `hideImage`
replaces them) and return that boolean. Example shape:

```ts
let hasRemoteImages = false;
for (const image of node.content.querySelectorAll('img')) {
  const source = image.getAttribute('src') ?? '';
  if (/^https?:\/\//i.test(source)) hasRemoteImages = true;
  // ...existing branches...
}
```

**Verify**: `grep -n "template(html).content.querySelectorAll" apps/desktop/src/renderer/legacy/mailBody.ts` → no output.

### Step 3: Add a headless browser test

`prepareMessageBody` needs a real DOM (`document.createElement('template')`),
and the repo's unit tests have no DOM library, so test it in headless Chromium
the way `apps/desktop/src/renderer/mailframe/browser/` does. Copy that folder's
pattern:

- `playwright.config.ts`: copy
  `apps/desktop/src/renderer/mailframe/browser/playwright.config.ts` and change
  only the temp-dir prefix (`aplos-legacy-mailbody-`) and the env var names
  (`APLOS_LEGACY_MAILBODY_OUT`, `APLOS_LEGACY_MAILBODY_KEEP`).
- `entry.ts`: `import { prepareMessageBody } from '../mailBody';` and assign it
  to `window` (`(window as any).prepareMessageBody = prepareMessageBody`).
- `mailBody.browser.spec.ts`: in `beforeAll`, bundle `entry.ts` with esbuild
  exactly as `mailframe.browser.spec.ts` does (lines 25-40 of that file show
  the `build({ entryPoints, bundle: true, write: false, format: 'iife', ... })`
  call). Serve a blank host page and the bundle with `page.route` on a fake
  origin, record every other request with `page.on('request')`, and fail on
  any request that is not the host page or the bundle.

Test cases (each builds a minimal `Message` object: `{ html, text: '',
attachments: [] , quoted: '' }` cast to the type, with
`options = { remote: false, spam: false, inline: {} }`):

1. An `<svg><image href="https://tracker.example/p.gif"/></svg>` body: the
   returned `body` contains no `svg` and no `tracker.example`; after setting
   `document.body.innerHTML = body` and waiting 200 ms, zero requests went to
   `tracker.example`.
2. The same with `xlink:href`, and with `<svg><filter><feImage href=...>`.
3. `<math><mi href="https://tracker.example/m">x</mi></math>`: no `math`, no
   request.
4. A plain `<img src="https://tracker.example/i.gif">`: `hasRemoteImages` is
   `true`, the `img` is hidden (its `src` no longer contains `tracker.example`),
   and zero requests went out.
5. The same `<img>` with `remote: true`: `hasRemoteImages` is `true` and the
   returned body still contains the `https://tracker.example/i.gif` source (do
   not mount it; just check the string).
6. `<p>Hello</p>` only: `hasRemoteImages` is `false` and the text survives.

**Verify**: `npx playwright test -c apps/desktop/src/renderer/legacy/browser/playwright.config.ts` → 6 passed.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- New file `apps/desktop/src/renderer/legacy/browser/mailBody.browser.spec.ts`
  with the six cases above, modelled on
  `apps/desktop/src/renderer/mailframe/browser/mailframe.browser.spec.ts`.
- Run it with the command in Step 3. It is not part of `npm test` (no browser
  there), the same as the mailframe browser spec.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] The new Playwright spec: 6 passed
- [ ] `grep -n "'svg'" apps/desktop/src/renderer/legacy/mailBody.ts` finds the forbid entry
- [ ] `grep -c "DOMPurify.sanitize" apps/desktop/src/renderer/legacy/mailBody.ts` prints `1`
- [ ] `npm run check` exits 0
- [ ] `git status` shows only the in-scope files
- [ ] `plans/improve/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `mailBody.ts` no longer matches the excerpts (drift).
- `npm run lint` or `owners:check` reports that `apps/desktop/src/renderer/legacy/browser/` is
  not an allowed location for new files: report it rather than moving the test
  somewhere else.
- A test shows a request still leaving with SVG and MathML forbidden: that means
  another element loads remote content. Report which one; do not keep adding
  tags by trial and error.
- The legacy Reader stops rendering ordinary HTML mail in the dev preview
  after Step 1 (`npm run dev`, open the printed URL with `?legacy=1` added so
  the legacy renderer boots, then open any demo message).

## Maintenance notes

- This file is retired when the real engine becomes the release default (the
  "go-live" step in `plans/HAND-CHECK.md`). Until then it is the shipped
  sanitizer, so a DOMPurify upgrade should re-run this spec.
- Deferred on purpose: after "Load images", the legacy reader fetches images
  directly in the app's default session, so trackers can set cookies. The real
  path already uses a cookieless proxy (`apps/desktop/src/host/proxy/fetch.ts`).
  If go-live slips by weeks, plan a follow-up that strips `Cookie` /
  `Set-Cookie` on image requests in the one module allowed to register
  `webRequest` listeners (`apps/desktop/src/main/mail-protocol.ts`).
- Reviewer: check that the `cid:` → `data:` rewrite still happens after the
  sanitize, and that no new `DOMPurify.sanitize` call was added elsewhere.
