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
