# Hill-climb scores — ui-onboard visual pass (roadmap 5.1c)

Scored by reading the captured PNGs against the mockups and DESIGN §7.11–7.12.
Scale: 0–10 on arrangement fidelity, honesty (nothing faked or implied), and
what stays readable at 640 × 600 under reduced motion.

## accounts-waiting (OAuth wait track, reduced motion)

Under `prefers-reduced-motion` the indeterminate runner paused at its first
keyframe — off the track — so the bar read empty.

| Candidate | Score | Notes |
|---|---|---|
| A · animation paused off-track | 4 | Bar reads empty; the wait looks broken |
| B · runner rests centred | 9 | Still reads indeterminate; no implied progress |
| C · runner rests flush left | 6 | Reads as a fake 30 % determinate bar |

**Winner: B**, applied to every indeterminate runner in the window
(`onboarding.css`): `animation: none; transform: translateX(117%)` rests the
30 % segment mid-track.

## zero-accounts / first-mail line (empty.html no-accounts, DESIGN 7.14)

The state floated as a bare line at the top-left of a full-width pane — no
shell proportions, no list column.

| Candidate | Score | Notes |
|---|---|---|
| A · bare line on the full pane | 4 | No context; reads unfinished |
| B · shell sidebar + centred list column | 8 | The mail window's real proportions; the status slot can carry the reason |
| C · list column on a full-width pane | 6 | Column helps, but a pane with no sidebar isn't a real window |

**Winner: B**, applied to `zero-accounts`, `zero-accounts-open-failed` and
`zero-accounts-first-sync` (which also draws the real `StatusSlot` in the
sidebar's footer, so "Reading your newest mail · 24 of 50" appears where the
mail window actually shows it). The sidebar's own contents belong to ui-shell.

## accounts-choose (one provider row, round 1)

| Candidate | Score | Notes |
|---|---|---|
| A · caption + lone quiet row (baseline) | 7 | Matches "hairlines between rows, no box" |
| B · tighter caption-to-row gap | 6 | Nearly invisible change; slightly cramped |
| C · hairline-bounded row | 6 | Edges look deliberate, but the pattern doesn't exist in the mockups or DESIGN's quiet lists |

**Winner: A** — the baseline stays; the deviation isn't worth a new pattern.

## Drill ("Try the keys while you wait")

The mockup order is head → practice rows → letter card → step prompt. The real
`FocusLetter` is taller than the mockup's tiny card, so at 640 × 600 (and
worse at the 520 minimum) the tail of the section overflows.

| Candidate | Score | Notes |
|---|---|---|
| A · prompt under the head, cursor letter as an inline card | 7.5 | The step's instruction ("J goes down, K goes up") is always visible; the letter opens in place like Home's focus slot |
| B · mockup order: rows, card, prompt | 6.5 | Closest to the mockup on paper, but the prompt falls below the fold and the card clips mid-button — the teaching line is invisible |
| C · inline card, prompt under the list | 6.5 | Card renders fully, but the instruction is still below the fold |

**Winner: A.** The mockup's bottom prompt only works because its card is
compact; with the real component the instruction must stay in view. A keeps it
under the head. The drill body scrolls inside the step (F13), so nothing is
unreachable.

## Direct fixes (not scored — clear gaps)

- `FirstSync` never passed `accountCount`, so `ProgressSegments` drew no
  account dots even with two accounts (mockup + DESIGN decision 16 both want
  them). Now passed `view.rows.length`.
- Hosted AI rows now use `ChoiceRow`'s `keySource` prop — the mockup's exact
  "Key found in the environment as `GROQ_API_KEY`" wording with the variable
  in mono — replacing the model's plain "From environment: GROQ_API_KEY".
- The found-provider row (`#onb-found-google`) is the mockup's "tall" row:
  icon and status top-aligned with the name instead of centred.
