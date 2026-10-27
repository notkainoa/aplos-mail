# Task: architecture proposal (evolve)

You are one of three independent principal architects (each on a different AI model). Write a COMPLETE target-architecture proposal for the Aplos revamp from this angle:

RELIABILITY-FIRST EVOLUTION. Evolve the current utilityProcess engine in place: normalized store, change log, governor, typed contract and AI job queue. Keep it resident in the menu bar (candidate B), then add a localhost listener (A0). The phone comes later. Optimize for the shortest path to an app the owner can daily-drive on a real Gmail plus iCloud/Fastmail mailbox, with the lowest migration risk.

Cover:
- process topology and lifecycle
- the storage design (schema sketch, bodies/blobs, FTS, encryption-at-rest decision, retention)
- sync per provider (Gmail metadata-first under the 6,000 units/min quota, Graph, IMAP with IDLE/QRESYNC, JMAP push, CalDAV, iCloud)
- the governor and retry design
- outbox/send safety, drafts sync, timed features (send-later, Later wake-ups, reminders)
- the AI pipeline (job queue, budget, consent, heuristic-first Home)
- the UI-to-engine contract and transport
- email HTML isolation (use the tested gap report)
- observability and diagnostics
- security (local listener auth, Electron hardening)
- multi-device and phone future
- migration from today's code, step by step and keeping the app usable throughout
- the effort in weeks for one owner plus AI agents
- the top risks
Cite research files throughout.

Write it to /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/proposals/arch-evolve.md (4000-8000 words), following the plain-English requirement in CONTEXT.md. Do not edit any other file. When done, print only: done: <path>
