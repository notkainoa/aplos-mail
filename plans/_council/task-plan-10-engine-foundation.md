# Task: workstream plan "Engine foundation and local server"

Binding decisions (read both in full first): /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/ARCHITECTURE.md and /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/DESIGN.md. Also read the relevant research under /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/../research/.

Write the workstream plan to /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/10-engine-foundation.md.

Scope: Everything in the engine core: the normalized store and migrations from today's data, the change log and live windows, the typed contract and method registry (zod), transports (MessagePort, then localhost/WebSocket with auth), the AI job queue and budget, timed features (send-later, Later wake-ups), engine lifecycle (resident menu-bar engine, then a LaunchAgent if decided), diagnostics/logging/crash reporting, and engine-side HTML serving (the custom-protocol origin). Excludes the per-provider protocol code (plan 20) and UI (plan 30).

Every plan must include:
1. The plain-English parts.
2. Scope and non-goals.
3. Milestones in order, each with: goal, concrete deliverables, file/module ownership (which paths this workstream owns or touches), dependencies on other plans, acceptance criteria that can be checked with evidence (tests, benchmarks, live-provider checks, screenshots), and an estimate.
4. Each milestone split into workflow-sized work packages a Claude Code workflow can execute: what to fan out, and what to verify adversarially.
5. Test strategy.
6. Risks and mitigations.
7. Interfaces and contracts with the other workstreams.
8. What to read first.
9. The PR/branch strategy within the revamp (nothing to main without the owner).
Cite the research.

Aim for 6000-11000 words. Follow the plain-English requirement in CONTEXT.md. Edit no other file.
