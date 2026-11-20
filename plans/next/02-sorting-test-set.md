# Job 2: made-up emails with known answers, then the no-AI sorter

## In plain English

Aplos will sort every email by the job it is doing (RETHINK.md, Part 1). Before any model is involved, a first pass uses plain facts about the email and runs with AI off. This job first builds a set of made-up emails where the right answer is written down, then writes that first pass and measures it against the set. The set comes first, in its own pull request, so the rules are not written to fit their own tests.

## What exists

- `packages/engine/src/ai/lanes.ts` has `laneFor`: a pure function that sorts mail into `do`, `update` or `low` from headers, folder roles and thread facts. Its comment explains the trust order. Tests: `packages/engine/tests/ai/lanes.test.ts` and `lanes.table.ts`.
- Home uses `laneFor` today. Do not change it or what it returns.

## The six jobs

`ask` (asks you for something), `update` (tells you something that affects you), `read` (a newsletter: recurring writing sent the same to everyone, with nothing about you in it), `newPerson` (someone new writing to you personally), `record` (receipts, statements, policy updates), `other` (promos, mass outreach, app notifications). RETHINK.md has the table and the definitions.

## Part A: the test set (first pull request)

Add `packages/engine/tests/ai/jobs-corpus/`: at least 240 made-up emails as JSON, 40 per job, each with the same input fields `laneFor` reads (see `LaneInput` in `packages/engine/src/ports`), a short body, the expected job and one sentence on why.

- Every address uses `.example` or `.test`. No real company's exact wording.
- At least a third must be hard cases, marked `"hard": true`. Examples: a bulk-sent school notice with a real date (an `update`); a person you know sending a plain FYI (`update`) and the same person asking for approval (`ask`); a template with a first name dropped in (`other`) next to a real cold email (`newPerson`); a failed payment or refund (`update`, not `record`); a shop's promo next to that shop's shipping notice.
- Add a test that checks the set itself: valid shape, 40 or more per job, no duplicates, reserved domains only.

## Part B: the sorter (second pull request, after A is merged)

Add `jobFor` in a new file `packages/engine/src/ai/jobs.ts`: pure, deterministic, no model, same style and trust order as `laneFor`. It returns the job and a confidence of `sure` or `unsure`.

- Nothing in the engine may import it yet. This keeps it out of the core bundle (see the size cap in README.md).
- When it cannot tell, it answers `unsure` and picks the visible side: `ask` for mail from a person, never `other`.
- Do not edit the test set in this pull request. If an expected answer looks wrong, list it in the pull request and leave it.

## Done when

- A test prints accuracy per job and overall, on the easy and the hard cases separately.
- On cases answered `sure`, at least 95% are right, and no email from a person is answered `other` or `record`.
- The pull request reports the numbers honestly, including where it does badly. A low score on hard cases is expected: those are what the model step is for.
- `npm run check` passes.
