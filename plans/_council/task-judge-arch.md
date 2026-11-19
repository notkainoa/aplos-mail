# Task: judge the three architecture proposals

Read in full: /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/proposals/arch-evolve.md, /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/proposals/arch-localserver.md, /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/proposals/arch-portable.md. Spot-check surprising claims against /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/../research/email-clients/SYNTH-architecture.md and the gap reports.

Score each proposal 0-10 on three lenses, separately:
1. RELIABILITY AND PERFORMANCE: sync correctness under real quotas and flaky networks, a 100k-thread mailbox, send safety, data integrity, and latency.
2. PRODUCT AND ROADMAP FIT: daily-drivable soon on the owner's real Gmail and iCloud/Fastmail, the phone future, timed features while the window is closed, the open-source goal, privacy, and Google verification burden.
3. EXECUTION RISK (higher means safer): effort for one owner plus AI agents, migration safety, testability, how threads can split the work, and reversibility.

Then list the 5-10 best specific ideas from ANY proposal that the final architecture should graft in, and give a 150-word verdict.
Write your scorecard (800-1500 words, markdown with a score table) to /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/_council/judge-arch-$JUDGE.md. Do not edit any other file. Print only: done: <path>
