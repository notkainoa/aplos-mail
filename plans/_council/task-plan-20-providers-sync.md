# Task: workstream plan "Providers, sync and connectivity"

Binding decisions (read both in full first): /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/ARCHITECTURE.md and /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/DESIGN.md. Also read the relevant research under /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/../research/.

Write the workstream plan to /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/20-providers-sync.md.

Scope: Per-provider connectors and sync built on the engine foundation: the Gmail metadata-first quota-governed sync, history polling, drafts API, filters, List-Unsubscribe, and OAuth production readiness plus Google verification/CASA track; Microsoft Graph (Entra app, delta, throttling, refresh rotation); IMAP (IDLE, QRESYNC/CONDSTORE, connection limits, iCloud/Fastmail/Yahoo specifics); JMAP push; CalDAV/Google Calendar/Graph calendar sync with recurrence and RSVP; and the provider emulators plus live-provider verification harness. Use the defect lists in the protocol reports.

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
