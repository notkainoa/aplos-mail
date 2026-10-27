# Task: architecture proposal (portable)

You are one of three independent principal architects (each on a different AI model). Write a COMPLETE target-architecture proposal for the Aplos revamp from this angle:

PORTABLE-ENGINE. Make the engine a platform-neutral core (packages/engine) that runs embedded on every device (candidate D: Mac now, iPhone later via a JS runtime or a port), with CloudKit or provider-side storage for cross-device workflow state and an optional stateless push relay (C) later. Design so the Mac never has to be awake for the phone to work. Be honest about costs and the Gmail per-project quota shared across devices.

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

Write it to /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/proposals/arch-portable.md (4000-8000 words), following the plain-English requirement in CONTEXT.md. Do not edit any other file. When done, print only: done: <path>
