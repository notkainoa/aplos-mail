# Task: workstream plan "Platform, security, distribution and quality"

Binding decisions (read both in full first): /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/ARCHITECTURE.md and /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/DESIGN.md. Also read the relevant research under /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/../research/.

Write the workstream plan to /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/40-platform-quality.md.

Scope: Electron hardening (fuses, CSP, entitlements, LSMinimumSystemVersion 13), keychain/provisioning profiles, distribution (a public release feed or a public repo, publishing, update testing), open-source readiness (license choice, secret-history audit, CONTRIBUTING, public docs), CI (formatter/linter adoption in one mechanical commit, emulator E2E, AI evals in CI, live-provider smoke tests), code-style modernization of the dense one-line files, and the website truthfulness pass.

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
