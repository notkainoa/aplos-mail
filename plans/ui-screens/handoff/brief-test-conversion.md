# Task: turn a lane's pending test list into real tests (Aplos Mail, UI-screens thread)

You work in ONE git worktree, given below as WT. Do everything inside WT. TypeScript, node:test, run with tsx.

## Inputs
1. The pending list: run `git -C WT show origin/rv/thread/ui-screens:apps/desktop/tests/LANE/pending.test.ts` (a file of `test.todo(...)` names grouped by `describe`).
2. The tests that already exist: every file in `WT/apps/desktop/tests/LANE/` (read them all).
3. The code under test: the pure modules of the lane (`*.model.ts`, `flow.ts`, `connect.ts`, `parse.ts`, `copy.ts`, `demo.ts`, `reconnect/*.model.ts`, `drill.model.ts`, etc.) under `WT/apps/desktop/src/renderer/` in the lane's folders: SRC (given below). Read their exports and doc comments.

## What to produce: exactly ONE new file, `WT/apps/desktop/tests/LANE/pending.test.ts`
Go through every todo in the pending list, in order, keeping the same `describe` groups:
- If an existing test already checks it, do NOT duplicate it. Write `// covered: <existing file>: <existing test name>` in its place.
- Else, if it can be tested now with the pure modules' exported functions (no DOM, no browser, no Electron, no running engine), write a real `test(...)` with the same name and assert the behaviour the todo describes, using only exported functions and small hand-written inputs. Import with relative paths like the existing tests do. Use invented demo data only (people on example.com). Keep each test short and clear.
- Else keep `test.todo('<same name> [waits: <reason>]')` where reason is one of: `Playwright base` (needs a DOM/browser or screenshots), `Electron` (needs a hidden Electron window), `engine` (needs the stand-in or real engine running), `live` (needs a real account or provider), `owner` (hands-on check).
Never invent behaviour: if the module's doc comments or code don't settle what the right answer is, keep it as a todo with `[waits: unclear]` and a 6-word note.

## Rules
- Do NOT edit any other file. Do NOT change source code even if a test you write fails: if a real test fails, keep it but mark it `test.skip('<name> [FAILS: one-line why]', ...)` and list it in your final message — that's a possible bug for a human to check.
- No git commands that change state (no add, commit, checkout, merge, push). No `npm install` (node_modules is already there).
- Never read or print `.env`, keys or tokens.
- Verify: `cd WT/apps/desktop && npx tsx --test tests/LANE/pending.test.ts` runs with 0 failures, and `npx tsc --noEmit -p .` shows no errors in your file (it may take two minutes).
- Final message: counts (real tests written, covered, todo by reason, skipped-as-failing), the list of skipped-as-failing tests with why, and the test run's summary lines.
