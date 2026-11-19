# Visual harness

The headless camera for the Paper design (plans/DESIGN.md 12.5, plans/30-ui-revamp.md 6.2). It draws
each named state from the real components in a small gallery page, shoots it in light and dark, and
checks the DOM beside the pixels. It never opens a visible window: `base.config.ts` in `tests/e2e`
refuses `--headed`, `--debug`, `--ui` and `PWDEBUG`.

```
npx playwright test -c tests/visual/playwright.config.ts                      # everything, both sizes
npx playwright test -c tests/visual/playwright.config.ts --project 1440x900   # one size
npx playwright test -c tests/visual/playwright.config.ts hover.spec           # one spec
npx playwright test -c tests/visual/playwright.config.ts -g "home-focus"      # one state
node tests/visual/contact-sheet.mjs 1440x900 0 4                              # look at the shots, light beside dark
VISUAL_CAPTURE_DIR=/tmp/base node tests/visual/contact-sheet.mjs 1440x900 0 4  # the same, for a run made with that capture dir
```

Run from the repo root. The npm script names (`test:visual`) are plat-ci's to wire. Output goes to
`artifacts/visual/` (ignored by git): `shots/<size>/<state>.<theme>.png`, diff overlays and
`results.json`.

## What is where

| File                                          | Role                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `states.ts`                                   | The named states: id, title, components, DESIGN section, mockup, golden or not, expected filled buttons, summary kind                                                                  |
| `gallery/scenes.tsx`                          | One scene per state: the component tree with original demo data and no-op handlers                                                                                                     |
| `gallery/main.tsx`, `index.html`, `stage.css` | The entry Vite serves. It loads `ui/styles.css`, sets `data-theme` and `data-contrast` from the URL, and marks the page ready once fonts are in                                        |
| `playwright.config.ts`                        | Extends `tests/e2e/base.config.ts`. Headless Chromium, scale 1, en-US, Los Angeles time, two projects (`1440x900`, `1100x760`), its own Vite server on port 4427 (`APLOS_VISUAL_PORT`) |
| `visual.spec.ts`                              | Screenshot compare, light and dark                                                                                                                                                     |
| `hover.spec.ts`                               | Hover never changes layout (DESIGN 5 rule 17)                                                                                                                                          |
| `dom.spec.ts`                                 | DOM assertions (DESIGN 12.5)                                                                                                                                                           |
| `axe.spec.ts`                                 | axe-core accessibility check, every state, both themes and sizes                                                                                                                       |
| `known-defects.ts`                            | Component defects found by the harness that belong to another lane, each with its reason (`KNOWN_DEFECTS` as expected failures, `axeKnownDefects` for axe)                             |
| `__golden__/1440x900/`                        | The committed golden set                                                                                                                                                               |
| `support/`                                    | The gallery opener, the ΔE comparison and shared paths                                                                                                                                 |

The gallery URL is `/tests/visual/gallery/index.html?state=<id>&theme=light|dark[&contrast=more]`.

## Adding a state

Screens add states through the same two files: one entry in `states.ts`, one scene in
`gallery/scenes.tsx` under the same id. Scenes import only `renderer/ui`. They use original demo data
and never the data layer, the shell or the engine, so a state needs no engine and no keys. Set
`filled` to the number of filled buttons on show (0 or 1, never more), `summary` when a Summary
renders, and `golden: true` only for a hero state.

Screens that need their data (Home, Later, the lists, Done: `gallery/scenes.home.tsx`) are the exception:
they set `frame: 'shell'` and render the real `App` on the stand-in engine (the `demo` or `backfilling`
scenario, `connectStandInDataLayer`), with a few steps (a key, a click, a drag, a write through the
data layer) that run once the screen has painted. Such a scene holds the shot back with
`data-gallery-pending` until the steps are done. Dispatch keys on `window` and never move the real pointer.

## Determinism

- The clock is fixed with `page.clock.setFixedTime` at 2026-10-29T10:00 (Los Angeles). Timers keep
  running so tooltips and toasts still schedule.
- Locale en-US, time zone `America/Los_Angeles`, device scale factor 1, caret hidden, cursor hidden,
  reduced motion on for screenshots (the tokens zero every duration). `hover.spec` and `dom.spec`
  turn reduced motion off so they see the real transitions.
- Newsreader is the bundled variable font. The sans is **not** bundled yet: `gallery/stage.css`
  forces Helvetica Neue, so a macOS update cannot shift the pixels, but the output is still tied to
  macOS fonts. Plan 30 6.2 asks for a bundled open sans in test mode; this is the stand-in.
- No keys: the server starts with blank AI keys and the gallery reads none.

## Screenshot compare

A pixel counts as changed when CIEDE2000 between the two colours is above 2. A state fails when more
than 0.1 % of its pixels changed. The maths runs in the browser (canvas), so no image library is
needed. A failure attaches a diff overlay: the expected image faded, changed pixels in red.

- **Golden set** (`golden: true`, 1440 x 900, light and dark, 10 states, about 0.7 MB). Compared with
  `__golden__/`. These are an internal fixture, never attached to a PR as they are.
- **Everything else is A/B on the same machine** (plan 30 6.2), so no stored image drifts with macOS:
  1. At the base ref, run the harness with `VISUAL_CAPTURE_DIR=/tmp/base`.
  2. At the head, run it with `VISUAL_BASE_DIR=/tmp/base`.

  Without `VISUAL_BASE_DIR` those states are only captured, and the test says so in its annotations.
  The golden states are compared in the same run either way.

- Increase Contrast (`data-contrast="more"`) is captured for the states with `contrastMore`, as A/B.

### Updating the golden set

```
VISUAL_UPDATE_REASON="why the pixels changed" \
  npx playwright test -c tests/visual/playwright.config.ts --project 1440x900 --update-snapshots
```

`--update-snapshots` **requires a reason** in `VISUAL_UPDATE_REASON`. Without one the run fails and
changes nothing. Put the same reason in the commit message. Update only at a milestone close, or when
a deliberate design change moves a hero state, and look at every changed image first. A golden image
that is missing is written and the test fails once, so it cannot be added by accident.

## Hover never shifts

For every state (light theme, both sizes) the spec marks up to 90 visible interactive elements, then
for each one: snapshots every box on the stage, moves the real pointer onto it, waits past the
100 ms hover transition and for any finite animation to end, and compares. Any other element whose
box moved or resized by more than 0.5 px fails the state, named with its delta, for example
`hover button.ui-onb-button "Open Aplos": svg moved by (2.39, 2.39)`. Tooltips are overlays and are
not counted; elements animating a transform forever (the spinner) are skipped, because their
bounding box changes with no hover involved. A keycap (`kbd` or any `*-kbd` class, outside tooltips
and `data-reveal="badge"`) that is on show after the hover and was not before is reported as
`hover X revealed keycap Y`, whether it came from `display`, `visibility` or `opacity` (DESIGN 5
rule 17). Controls plant a row nudge and a keycap revealed by visibility and by opacity, and require
each to be reported.

## DOM assertions

Per state, light and dark:

- at most one filled button, and exactly the count `states.ts` declares; its radius is at most 8 px
- no computed `transition-property` with a layout property (`all` counts when its duration is not
  zero) on any element
- no gradient background, mask, border-image or list-style-image, no `backdrop-filter`, on elements
  or `::before` and `::after`; no SVG `linearGradient`, `radialGradient` or `pattern` under the
  stage, and no `fill` or `stroke` that points at one
- no text under 11 px
- none of the banned phrases of DESIGN 10 and 13, no `!`, no sparkle, wand, star, brain or robot
  glyph or icon name, in text, `aria-label`, `title`, `placeholder`, SVG classes and `data-icon`
- a ready summary is set in Newsreader and the font is loaded; a pending one is not serif
- no button draws the browser's default chrome (see `known-defects.ts`)

One test plants a violation of each kind and requires the audit to name it.

## Accessibility (axe)

`axe.spec.ts` opens every state in light and dark, at both sizes, and runs `@axe-core/playwright`
(dev-only, pinned) with the tags `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa`.

- A `serious` or `critical` violation fails the state.
- `moderate` and `minor` ones do not fail. Every finding of any impact prints one tab-separated line,
  `AXE <size> <state> <theme> <impact|known> <rule> <nodes> <first target | message>`, so a run can be
  tallied with `grep '^AXE' log`.
- A rule is let through only by `axeKnownDefects` in `known-defects.ts`: state id, then axe rule id,
  then the reason (which lane owns the cause, or which token pair the design already approves in
  `contrast-pairs.json`). The entry covers that rule in that state in both themes and sizes, and no rule
  is switched off for the whole run. Delete the entry when the cause is fixed. A run prints an
  `AXE-STALE` line for an entry whose rule did not appear, so a fixed cause shows up.
- Fix the markup (names, roles, landmarks, focus order), never the colours, to make a state pass.

```
npx playwright test -c tests/visual/playwright.config.ts axe
```

## Not here yet

- Motion filmstrips (DESIGN 12.5): a separate work package.
- The not-Avec checks that need a whole screen (Lab b* of the shell, single reading column): they
  run on Home and the reader once those screens exist.
- The full matrix of about 90 states and the Electron window (the onboarding window is a 640 x 600
  frame in the gallery, not the real window).
