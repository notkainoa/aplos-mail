# Lane card: eng-time (parked)

**Goal.** One clock and timer loop, the send state machine (marker committed before the first byte; uncertain sends settled by `findSent`, never replayed), undo and send-later, drafts, reminders and Later, the notification outbox. Security-sensitive: no duplicate sends.

**Owned paths:** `packages/engine/src/{outbox,clock}/**`, `packages/engine/src/methods/{submission,draft,outbox,later,reminder,notification}.ts`, tests in `packages/engine/tests/{outbox,clock}/**`.

**Read:** `plans/engine/HANDOFF.md`; `plans/engine/phase1-lanes.md` lines 313-384; `plans/10-engine-foundation.md` lines 446-477 (E6); `plans/ARCHITECTURE.md` section 7 (line 444).

**State.** `rv/eng-time/clock-loop` @ 84de2d4 (time-1; 10 review-confirmed defects unfixed), `rv/eng-time/reminders-later` @ 4d1da61 (time-4, 10/10 tests), `rv/eng-time/submissions` @ b756418 (time-2 WIP, unverified). Fix the 10 defects first, then time-2 (Opus; send path).

**Tests.** `npx tsx --test 'packages/engine/tests/clock/**/*.test.ts'` and `'packages/engine/tests/outbox/**/*.test.ts'`; `npm run check`.
