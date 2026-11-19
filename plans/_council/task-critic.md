# Task: critique one revamp plan

Read /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/_council/CONTEXT.md, then the plan named in your prompt. The binding decisions are in /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/ARCHITECTURE.md and /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/DESIGN.md; check the plan against both. Spot-check it against the research in /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/../research/email-clients/, using SYNTH-*.md, protocols/*.md and gaps/*.md.

Find REAL issues only, across three lenses:
1. FEASIBILITY AND SEQUENCING
   - Is the order right?
   - Are the estimates honest for one owner plus AI agents?
   - Are dependencies on other workstreams explicit?
   - Does the app stay usable during migration?
   - Can each work package be executed as written?
2. COMPLETENESS
   - Which findings, protocol defects or decisions from ARCHITECTURE.md, DESIGN.md or the research does the plan miss or contradict? Cite the path.
3. OWNER READABILITY
   - Are the plain-English sections clear to a non-engineer?
   - Does every major section end with "> **What this means:**"?
   - Are the "Decisions for you" questions clear and given recommended defaults?

Write a markdown list to the output path in your prompt. Each item has: severity (blocker/major/minor), the issue, and a concrete fix. Keep it under 1200 words. Edit no other file. Print only: done: <path>
