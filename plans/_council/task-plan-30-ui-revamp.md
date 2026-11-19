# Task: workstream plan "UI revamp"

Binding decisions (read both in full first): /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/ARCHITECTURE.md and /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/DESIGN.md. Also read the relevant research under /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/../research/.

Write the workstream plan to /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/30-ui-revamp.md.

Scope: Implementing DESIGN.md in the renderer: tokens and theming, the motion system and enforcement (lint, motion skill), the component library, migrating the renderer from whole-AppState to the engine contract's live windows, every screen, the command palette, the email HTML frame on the UI side, onboarding (absorb PR #21 and fix its review findings), removing Avec-derived layout and wording, accessibility, and the visual regression harness (headless Playwright screenshots). Coordinate with plan 10 on the contract migration.

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
