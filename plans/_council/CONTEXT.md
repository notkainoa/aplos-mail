# Shared context for every planning agent

## Situation
Aplos Mail is the owner's keyboard-first macOS mail + calendar app: Electron + React + TypeScript, in an npm-workspaces monorepo with apps/desktop and apps/web. It is about two weeks old and built by one owner with AI coding agents. The code is on main at /Users/knewton/.t3/projects/aplos-mail (read-only for you). This worktree is /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a on branch `revamp`. The owner is in a DEEP RESEARCH + PLANNING phase for a full revamp: UI, architecture/backend, basically everything. The goal is "the best UX, beautiful, fast, best-architecture email client, open source or otherwise". No implementation code is being written in this phase. Plans will later be executed by a few T3 Code threads (one UI, one or two architecture) that orchestrate Claude Code workflows.

## Research to use (read what you rely on; don't guess)
- Syntheses: /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/research/email-clients/SYNTH-architecture.md, /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/research/email-clients/SYNTH-features.md, /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/research/email-clients/SYNTH-ui.md
- Architecture audits: /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/research/email-clients/arch/*.md (Zero, Superlocal, Redakt, Inbox Zero client, Mailspring, Nylas, Delta Chat, Geary, Pimalaya, Stalwart, Tuta, EmailEngine, plus extras: comail, Flectar, Velo, Parula/Mustang, Bulwark)
- Protocols: /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/research/email-clients/protocols/proto-google.md, /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/research/email-clients/protocols/proto-others.md (both include defect lists for Aplos's adapters)
- UI studies: /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/research/email-clients/ui/*.md (Tatem, Avec, Zero, Redakt, Superlocal, Inbox Zero Mail, and aplos-baseline). Screenshots are in /Users/knewton/.t3/aplos-research/ui/
- Gap reports: /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/research/email-clients/gaps/*.md (macOS daemon lifecycle, phone-to-Mac connectivity, Electron email HTML isolation with a tested prototype, identity collision audit, engine contract/RPC stack, storage engine benchmark)
- Earlier research: /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/research/inbox-zero/*.md (Inbox Zero deep dive, Aplos product and architecture audits, council synthesis)
- Open PR #21 review: /Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/research/pr21-onboarding-review.md. PR #21, the new onboarding window, is NOT merged and must not be merged by you.
- Aplos's own docs on main: /Users/knewton/.t3/projects/aplos-mail/SPEC.md, DECISIONS.md, PROGRESS.md, TODO.md, MOBILE.md, RELEASING.md, AGENTS.md

## Facts that override the research where they conflict (verified 2026-10-25)
- Aplos releases ARE Developer ID signed and notarized: team VW9NDM428H, "Developer ID Application: SCOTT ANDREW NEWTON". 0.2.0-0.2.3 exist as GitHub draft releases. Any research claim that "Aplos ships ad-hoc builds with no Developer ID" is outdated. Provisioning profiles for keychain access groups and CloudKit have NOT been set up yet.
- The GitHub repo notkainoa/aplos-mail is PRIVATE, so the download link and auto-update feed currently 404 for everyone else. The owner wants Aplos to be open source eventually.
- Google OAuth is in Testing mode (test users only). The Gmail and Calendar APIs are enabled. The Google client ID and secret are inlined into release builds from GitHub secrets. Microsoft has no client ID yet.
- The first real Gmail sync failed with 403. Research found the cause: Gmail's 2026 per-user quota (6,000 units/min) versus a 500-thread format=full first sync (about 60,000 units). 0.2.3's retry fix cannot solve that.
- Owner taste (from memory):
  - A docked Ask panel.
  - The AI primary action on Space.
  - Big summaries.
  - A sender-first reader.
  - NEVER sparkle/wand/star AI glyphs.
  - Loves the feel of Tatem and Avec, but Aplos must have its OWN identity: never copy Avec code, assets, branding, or wording.
  - Keyboard-first and calm.
  - The app icon is a sky with an airmail envelope and a green hill.
- Owner rules: Groq is the default AI provider, with BYO keys for many providers including local Ollama/LM Studio. Never print, commit, or bundle keys. No visible-window automation for agents (headless only). Commits are authored as Kainoa Newton <k@kainoa.me>. Nothing from this phase goes to main.

## Plain-English requirement (MANDATORY for every document you write)
The owner reads the plain-English parts, not the technical detail. Every document must:
1. Start with "## In plain English": 150-350 words, short sentences, no jargon (or jargon explained in passing), covering what this is, why it matters, and what changes for the owner and users.
2. End every major section with a blockquote line: "> **What this means:** ..." (1-3 plain sentences).
3. Include "## Decisions for you": each decision the owner must make, phrased as a plain question, with options, a recommended default, and what happens under each choice.
Technical depth below these parts should be uncompromising: specific, evidence-cited (research file paths), with acceptance criteria.
