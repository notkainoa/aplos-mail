# Hill-climb scorers

Commands the hill-climb harness (`npm run hillclimb`, plans/00-roadmap.md 5.1c) runs to score a UI
target. **Attempts must not edit this folder** (nor `known-defects.ts`, `states.ts` or the goldens):
the harness rejects any diff that touches a scorer.

## Output contract

A scorer prints, as the **last line of stdout**, one JSON object and exits 0 even when the score is low:

```
{"score": 98.33, "details": ["list-rows light nested-interactive known:serious 1 #r-error"]}
```

- `score`: 0 to 100, higher is better, rounded to 0.01.
- `details`: at most 20 strings, worst finding first, no ANSI codes.
- Exit non-zero only when the tool itself failed (server did not start, browser crashed, bad
  arguments). Progress goes to stderr, never to stdout.

`common.ts` has `printScore(score, details)` which enforces all of this.

## Running

Run from the repo root, headless, no keys. A scorer starts the gallery's Vite server itself on a free
port and stops it at the end. An `APLOS_VISUAL_PORT` that is set and already answers is reused;
the default port 4427 never is.

```
npx tsx tests/visual/scorers/axe.score.ts                        # every state, both themes, 1440x900
npx tsx tests/visual/scorers/axe.score.ts --state shell-sidebar  # states whose id starts with the prefix
npx tsx tests/visual/scorers/axe.score.ts --size 1100x760 --theme dark
npx tsx --test tests/visual/scorers/*.test.ts                    # unit tests, no browser
```

Shared arguments (`common.ts`): `--size 1440x900`, `--state <id prefix>`, `--theme light|dark|both`,
`--reuse` (scorers that shoot PNGs skip re-shooting when fresh ones are in `artifacts/visual/shots/<size>/`;
axe does not shoot, so ignores it).

## Scorers

| File | Measures |
|---|---|
| `axe.score.ts` | axe-core (wcag2a, wcag2aa, wcag21a, wcag21aa) on every state. Setup is shared with `axe.spec.ts` through `../support/axe.ts`. |

**axe**: each violation costs `impact weight x min(nodes, 3)` with critical 8, serious 5, moderate 2,
minor 1. Entries in `axeKnownDefects` count half and are labelled `known:<impact>`. The total is divided
by 300 (20 serious violations of 3+ nodes), so a clean run is 100 and 20 serious ones is 0. A state that
fails to open counts as one critical finding (`state-failed-to-open`). Details read
`state theme rule impact nodes target-selector`. A full run takes about 4 minutes; use `--state` for a screen.

## Files

`common.ts` (output, args, state list, shots dir), `axe-score.ts` (pure scoring maths), `server.ts`
(starts and stops the Vite gallery), `common.test.ts` (unit tests).

## taste-judge scorer

`taste.score.ts` has Claude Sonnet judge screenshots against `taste.rubric.md` (a 55-line distillation of
DESIGN sections 3, 4 and 9 and the aplos-design skill) and the matching mockup, rendered like
`mockups/shoot.cjs` (`?shot=1&theme=...&state=...`; a reference is skipped, and noted in details, when
the mockup has no such state). Needs a logged-in `claude` (`CLAUDE_BIN` overrides the binary, `TASTE_MODEL`
the model). Extra arguments: `--samples N` keeps the first N states, `--runs K` asks K times per state and
takes the median per criterion. Default states are listed in `taste.sample.json` (8); `--state` replaces them.

One call per state and run covers both themes (4 images with the reference). Score per state is 10 x the mean
of the criteria the judge scored (it may answer `null` for one that cannot be assessed); overall is the mean
over states. Details read `state: finding`, lowest states first, judge failures first. A failed state is listed
and left out of the mean; if every state fails the scorer exits 1. Results are cached in
`artifacts/visual/judge-cache/` by sha256 of the image bytes, rubric, model, prompt version and run index, so an
unchanged screenshot costs nothing; stderr reports the hit count. Numbers are for comparing versions, not absolute.
Files: `taste-score.ts` (pure: prompt, parsing, maths, cache), `taste.test.ts` (fake judge, no network).

## visual-diff scorer (`mockup-diff.score.ts`)

How close is each implementation state to its mockup in layout and style? Per state and theme it shoots
the gallery state, renders `mockups/<file>.html?shot=1&theme=<theme>&state=<state>` headlessly at the same
viewport (clock frozen, animations off, fonts awaited, the mockup's own state bar hidden), crops both to
the same region (shell states: the whole window; pane states: the gallery pane against the mockup's
`.main`; onboarding window states: the 640 x 600 window) and compares them, not pixel by pixel because
the demo data differs:

`score = 100 x (0.6 x colourSimilarity + 0.4 x structure)`. `colourSimilarity = max(0, 1 - meanDeltaE / 40)`,
the mean CIEDE2000 between the per-cell mean colours on an 8 px grid. `structure` is the mean Pearson
correlation of the column and row sums of luminance gradient magnitude (the ink profile). Overall is the
mean over compared states and themes. Details read `state theme score% worst x,y,w,h` (worst first; the
rectangle is the 4 x 4 cell block with the largest mean ΔE, in pixels of the compared region).

```
npx tsx tests/visual/scorers/mockup-diff.score.ts [--size 1440x900] [--state prefix] [--theme light|dark|both] [--reuse]
```

`mockup-diff.exclude.json` maps a state id to the reason its mockup is not comparable (several states share
a page that shows another state, a mockup page that does not exist, overlays). States whose mockup label is
not one of the page's states are also skipped and logged. Overlays for humans (implementation | mockup |
heatmap) go to `artifacts/visual/mockup-diff/<size>/<state>.<theme>.png`. Maths and unit tests:
`mockup-diff-score.ts`, `mockup-diff.test.ts`.
