# Next: jobs for the rethink

The plan is [../RETHINK.md](../RETHINK.md). Read it first. This folder holds one brief per job that can start now. Each job is one branch and one or more small pull requests into `next`. GitHub's CI runs on every pull request into `next`.

## In plain English

Job 1 is done. Jobs 2 and 3 are ready, and both are judged by tests. Two more wait: the record in the core waits for a careful review, and the screen blocks wait until we have decided what a block is.

| # | Job | Brief | Status |
|---|---|---|---|
| 1 | A test bar every mail provider must pass, and a list of Gmail-only leaks | [01-provider-test-bar.md](01-provider-test-bar.md) | Done: #590 ([provider-leaks.md](provider-leaks.md)), #591 (`packages/engine/tests/conformance-provider/`); two capability checks left as `todo` |
| 2 | Made-up emails with known answers, then the no-AI sorter for the six jobs | [02-sorting-test-set.md](02-sorting-test-set.md) | Ready |
| 3 | Remove the old screens and the old engine | [03-remove-old-app.md](03-remove-old-app.md) | Ready |
| 4 | The record and corrections in the core | not written | Waits for review time (the store's write path) |
| 5 | Claude Code and Codex as model choices | not written | Waits for a terms check |
| 6 | Screen blocks | not written | The block design is settled (RETHINK.md Part 3 items 11 to 20). Waits for one speed experiment: a walled-off panel must meet DESIGN.md §5's key budgets (item 13) |

## Rules for every job

- Branch from `next`, name the branch `next-<job>-<slug>` (git cannot hold `next/...` beside a branch named `next`), and open the pull request into `next`. Never push to `main` or `revamp`.
- Do the one job you were given. If the brief is wrong or something blocks you, stop and say so in the pull request instead of widening the job.
- Run `npm ci` once, then `npm run check` before every commit. It must pass.
- The repository is public. Never commit real mail, real addresses, keys or tokens. Made-up mail uses reserved domains (`.example`, `.test`).
- Commits are authored as `Kainoa Newton <k@kainoa.me>` (`git config user.name` and `user.email`). No AI credit lines in commits or pull requests.
- Every new file needs an owner row in `plans/OWNERS.md`, or `npm run check` fails.
- The engine core bundle has a size cap (`budgets.json`, 470,000 bytes, nearly full). The owner agreed on 2026-11-20 to raise it, but the new number is not set. Until it is, do not add code to the engine core: keep new modules out of what the core imports.
- You run on Linux. Do not try to build the packaged Mac app, sign anything or reach a real mailbox.
- Follow the root `AGENTS.md` code rules: named exports, small functions, no multi-statement one-liners.
- Pull request text: the problem in a sentence or two, then how you fixed it, in plain language.
