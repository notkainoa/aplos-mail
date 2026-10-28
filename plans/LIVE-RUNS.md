# Live runs on the agent test account

The integrator runs every automatic live check against the owner's spare Gmail (the agent test account), on this Mac only, because its OAuth grant lives in this Mac's Keychain. Threads on the Linux box (`kainoas-linux-mba`) can't reach it. They ask through `plans/STATUS.md`, and the integrator answers there. The account rules are in [00-roadmap.md](00-roadmap.md), "Decisions already made", "The agent test account". The runner is `apps/desktop/scripts/live/` (lane `prov-emu`) and plan 20 section 5.4.

## In plain English

Another thread asks for a live check in the shared log. The integrator reads the exact command, makes sure it goes through the guarded runner and stays within the rules, runs it here, and posts back a result that names no address and no mail.

## How to ask

Post one line: `REQUEST | prov-<lane> | to integrator: live-run <tier R|M|S-self> | <exact command, run from the repo root> | <commit SHA of the runner and probes> | <what it proves, and the expected units per minute>`.

## What the integrator checks before running

1. The command is a single `node` or `npx tsx` call of `apps/desktop/scripts/live/run.ts` at the named SHA, which must be on `revamp` or in an open PR the integrator has checked. Nothing else: no shell pipes, no extra scripts, no environment overrides beyond the runner's documented flags.
2. The guard at that SHA includes the fixes from PR #38's security review (draft ids, label and filter keys, query keys, the account binding). Until #38 merges, no live run happens.
3. The tier is allowed: read-only tier R first. Tier M and S-self run only after a clean tier R run on the same SHA, and only with the probes the request names.
4. One Gmail run at a time, under 3,000 units a minute (the runner's pacer), and never overlapping an AI eval run on the account.
5. The account's `reconnectBy` is more than a day away. Otherwise the run is skipped with a plain note, and the owner reconnects at the weekly reconnect.

## How it runs

- From this worktree, on a clean checkout of the named SHA, headless, with no window.
- The grant and the Groq test key come from the Keychain inside the runner. They are never printed, logged or copied.
- Evidence is the runner's content-free report, kept outside the repo in `~/Library/Application Support/Aplos Mail Review/live/<date>/`. Before anything is posted, it is checked for any `@` or address-like text, any subject or body text, and any token.

## How the result comes back

One STATUS line: `NOTICE | prov-<lane> | live-run <tier> at <sha>: <pass or fail>, <units per minute peak>, <refusals by class>, <what was proven>`. The detail goes in the evidence file. A failure that looks like a guard refusal is reported as is; the integrator never loosens the guard to make a run pass.

## Never

No mail to any address but the account's own. No permanent delete, emptying Trash, unsubscribe, RSVP or attendee. No settings change. Nothing on the owner's main account; those checks are the owner's own, by hand, on days 14 to 16.
