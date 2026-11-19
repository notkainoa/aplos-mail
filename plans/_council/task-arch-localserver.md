# Task: architecture proposal (localserver)

You are one of three independent principal architects (each on a different AI model). Write a COMPLETE target-architecture proposal for the Aplos revamp from this angle:

LOCAL-SERVER-FIRST. Design Aplos around a real local mail server/daemon from day one: a typed JMAP-semantics contract over MessagePort/WebSocket/HTTP, per-account actors, a durable change journal with SSE/WebSocket resume, and a staged path from A0 to an SMAppService LaunchAgent (A1) to paired phone clients (A2, T3-Code-style pairing over LAN/Tailscale). The UI becomes a pure client of the local server. Be honest about the costs.

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

Write it to /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans/proposals/arch-localserver.md (4000-8000 words), following the plain-English requirement in CONTEXT.md. Do not edit any other file. When done, print only: done: <path>
