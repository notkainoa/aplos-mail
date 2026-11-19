# Hill-climb scorers

Commands the hill-climb harness (`npm run hillclimb`, plans/00-roadmap.md 5.1c) runs to score a UI
target. **Attempts must not edit this folder** (nor `known-defects.ts`, `states.ts` or the goldens):
the harness rejects any diff that touches a scorer.

**Off limits to attempts** (the harness diffguard enforces it): every file in this folder, which
includes `mockup-diff.exclude.json`, `taste.sample.json`, `taste.rubric.md`, `content-floor.json`,
`locked-states.json` and the tests, plus `tests/visual/gallery/**`, `tests/visual/support/**`
(including `support/axe.ts`), `tests/visual/vite.config.ts`, `tests/visual/states.ts` (including each
state's `mockup` string), `tests/visual/known-defects.ts`, the goldens, `mockups/**` and
`plans/DESIGN.md`. A scorer is changed only by the owner, never to raise a score. Each scorer is built
so that hiding, breaking or deleting a state cannot raise its score: pages that cannot be scored count
as failures, never as absent.

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
port and stops it at the end. An `APLOS_VISUAL_PORT` that is set and already answers is reused,
unless `SCORER_ISOLATED=1` is set (the hill-climb harness should set it): then the port is ignored and
the scorer always starts its own server on a free port. The default port 4427 is never reused.

**Safety**: screenshots are attempt-authored and the taste judge reads on-screen text, so nothing a
scorer spawns inherits `process.env`. `env.ts` (`scorerEnv`) builds an allow-list: PATH, HOME, TMPDIR,
LANG, LC_ALL, TERM, XDG_{CONFIG,DATA,CACHE}_HOME, USER, LOGNAME, SHELL, TASTE_MODEL, CLAUDE_CONFIG_DIR (judge only; login works from HOME alone, no other CLAUDE_* is passed),
and for Vite NODE_ENV and npm_config_cache; never a name ending `_API_KEY`, `_TOKEN` or `_SECRET`, never
NODE_OPTIONS. Each judge call copies its PNGs into a fresh `aplos-taste-*` temp dir (removed afterwards),
runs there with `--restricted --tools Read --allowedTools 'Read(//<dir>/**)'` and Bash, Edit, Write,
NotebookEdit, WebFetch and WebSearch denied. The judge's findings are cut to 8 lines of 300 characters,
without ANSI or control characters (cached entries are cleaned the same way when read; `--runs K` merges at most 8
findings overall). Each `claude` child leads its own process group: on a timeout or error the group gets SIGTERM
and, after about 2 s, SIGKILL, so helpers it spawned cannot outlive the call.

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

| File           | Measures                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `axe.score.ts` | axe-core (wcag2a, wcag2aa, wcag21a, wcag21aa) on every state. Setup is shared with `axe.spec.ts` through `../support/axe.ts`. |

**axe**: each violation costs `impact weight x min(nodes, 3)` with critical 8, serious 5, moderate 2,
minor 1. Entries in `axeKnownDefects` count half and are labelled `known:<impact>`. The total is divided
by 300 (20 serious violations of 3+ nodes), so a clean run is 100 and 20 serious ones is 0. A page that fails to
open or to scan (`state-failed-to-open`, including an axe run that throws) makes the whole score 0, and a
run that visits no page scores 0, so breaking a state never beats fixing it. The first detail line reads
`scanned N of M pages`. Details read
`state theme rule impact nodes target-selector`. A full run takes about 4 minutes; use `--state` for a screen.

**Content floor** (`content-floor.ts`, `content-floor.json`): a page with no violations because it is
empty must not score 100. After the axe run each page is measured in the browser: the visible text
(`document.body.innerText.trim().length`, so `display:none` and `visibility:hidden` text does not count)
and the visible interactive elements (`a`, `button`, `input`, `select`, `textarea`, `[tabindex]` of 0 or
more, and the roles button, option, menuitem, tab, link, checkbox and radio; `checkVisibility()` with
opacity and visibility, and not inside `aria-hidden="true"`). A page under 12 characters, or under its
state's `minInteractive` (default 0), counts as a failed state: it is reported as `state-failed-to-open`
with a `content-floor:` message and the whole score is 0. `exempt` maps a state id to the reason it may
show under 12 characters (the interactive floor still applies). `minInteractive` was seeded from one
measurement of the gallery at about half the lowest count over both themes. A key that is not a state id
fails the run.

**Locked states** (`locked-states.json`): `states` is the sorted list of every state id that exists, and
`lockedSample` the ids `taste.sample.json` must keep. `axe.score.ts` and `mockup-diff.score.ts` exit 1 with a
message on stderr and no score line when a locked id is missing from `states.ts`; `taste.score.ts` does the
same when a `lockedSample` id is missing from `taste.sample.json`. Adding states or sample ids is allowed.
Growing the lists is an owner / ui-core change, and attempts must not touch this folder.

## Files

`common.ts` (output, args, state list, shots dir, `--reuse` freshness), `axe-score.ts` (pure scoring
maths), `content-floor.ts` (page measure and floor check), `locked.ts` (locked ids), `server.ts` (starts and stops the Vite gallery, launches Chromium), `lifecycle.ts` (cleanups
and SIGINT/SIGTERM/SIGHUP handling: stop the Vite process group, close the browser, remove temp dirs,
exit 130/143), `mockup.ts` (finds and shoots a mockup page, shared by the diff and taste scorers),
`common.test.ts`, `lifecycle.test.ts` (unit tests).

`--reuse` only reuses a shot that is younger than an hour and not older than the newest file under
`apps/desktop/src/renderer`, `packages`, `tests/visual/gallery`, `tests/visual/support`,
`tests/visual/vite.config.ts` and `states.ts`; otherwise it re-shoots.

## taste-judge scorer

`taste.score.ts` has Claude Sonnet judge screenshots against `taste.rubric.md` (a 55-line distillation of
DESIGN sections 3, 4 and 9 and the aplos-design skill) and the matching mockup, rendered like
`mockups/shoot.cjs` (`?shot=1&theme=...&state=...`) by the same code as the visual-diff scorer (frozen
clock, reduced motion, state bar hidden; a reference is skipped, and noted in details, when the mockup
has no such state). Needs a logged-in `claude` (`CLAUDE_BIN` overrides the binary, `TASTE_MODEL`
the model). Extra arguments: `--samples N` keeps the first N states, `--runs K` asks K times per state and
takes the median per criterion, `--max-calls N` (default 12) is a run-wide cap: the run is refused (exit 1)
when states x runs exceeds it. Default states are listed in `taste.sample.json` (8); `--state` replaces
them. A sample id that is not in `states.ts` is an error, not skipped.

One call per state and run covers both themes (4 images with the reference). Score per state is 10 x the mean
over the FIXED criterion set of the rubric; a criterion the judge answers `null` for (cannot be assessed)
counts as 5, neutral, and never leaves the mean. Overall is the mean over all states asked for. Details
read `state: finding`, lowest states first, judge failures first. A state that failed (it did not open,
the judge failed) is listed and scores 0; if every state fails the scorer exits 1. The screenshots are
attempt-authored, so the prompt tells the judge to ignore any instructions inside the images. A cache
entry of the wrong shape, or with a criterion outside 0..10, is a miss; the judge's own numbers are clamped to 0..10 when parsed. Results are cached in
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
mean over every state and theme asked for except those in the exclude file: a state whose mockup
cannot be resolved, or that fails to open or render, scores 0 and is flagged (`mockup-unresolved`).
The first detail line reads `compared N of M (excluded E)` (pages are state x theme). Details read `state theme score% worst x,y,w,h` (worst first; the
rectangle is the 4 x 4 cell block with the largest mean ΔE, in pixels of the compared region).

```
npx tsx tests/visual/scorers/mockup-diff.score.ts [--size 1440x900] [--state prefix] [--theme light|dark|both] [--reuse]
```

`mockup-diff.exclude.json` maps a state id to the reason its mockup is not comparable (several states share
a page that shows another state, a mockup page that does not exist, overlays). Every key must be a state
in `states.ts`; a stale key fails the run (exit 1). Overlays for humans (implementation | mockup |
heatmap) go to `artifacts/visual/mockup-diff/<size>/<state>.<theme>.png`. Maths and unit tests:
`mockup-diff-score.ts`, `mockup-diff.test.ts`.

## Known gaps

- A harness that SIGKILLs a scorer cannot be caught: the detached Vite process group and Chromium may
  outlive it. SIGINT, SIGTERM and SIGHUP are handled; SIGKILL is not.
- The taste scorer counts a criterion the judge answers `null` for as 5 (neutral), so a judge that
  declines to assess can pull a state toward 50. Not fixed on purpose.
