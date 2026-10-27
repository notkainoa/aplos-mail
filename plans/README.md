# Aplos revamp: start here

## In plain English

This folder is the complete plan for rebuilding Aplos Mail. Nothing in it is built yet. It turns research into decisions, schedules and instructions, so three AI coding threads can work in parallel while you steer.

The new Aplos is a calm, keyboard-first mail and calendar app that is clearly its own. The look is called Skypaper: the email in front of you is a sheet of paper, and everything around it is sky. Finishing an email has one signature motion, where the letter is carried off. Gmail's inbox appears in seconds and fills in quietly within Google's limits. iCloud and Fastmail get new mail within seconds, and your calendars stop losing meeting links. Mail keeps arriving when the window is closed, each email shows in a sealed box that cannot track you, and a huge mailbox still feels instant.

How long it takes. About one week for a small Gmail fix (0.2.4), so real Gmail works. About six weeks for a Gmail app you can live in, on the new engine (0.3.0). About fourteen weeks for everything, new screens included (0.4.0). If reviews and live checks run slow, plan on seventeen or eighteen. Google's own review of Aplos runs alongside and may take months.

> **What this means:** A plan, not code. Real Gmail in about a week, a solid new engine in about six, the full new Aplos in about fourteen, with you deciding at each step.

## Read these, in this order (about 20 minutes)

1. [00-roadmap.md](00-roadmap.md): read its "In plain English" section, then its "Decisions for you" section (section 6). The first ten matter most; the rest have defaults.
2. [ARCHITECTURE.md](ARCHITECTURE.md): the "In plain English" section only. It covers storage, syncing, and why Gmail fails today.
3. [DESIGN.md](DESIGN.md): the "In plain English" section only. It covers the Skypaper look and the rules that keep Aplos its own.
4. [50-thread-briefs.md](50-thread-briefs.md): the "In plain English" section only, then its "Decisions for you" at the bottom. It covers the three threads and what you will see.

The workstream plans (10, 20, 30, 40) are only for checking on one thread; each starts with its own plain-English section.

> **What this means:** Four short reads and a handful of answers are all that is needed before saying go.

## What's in here

| File or folder | What it is |
|---|---|
| [README.md](README.md) | This page. |
| [00-roadmap.md](00-roadmap.md) | The master plan: threads, timeline, branches, your calendar, every decision. Read first. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The binding engine design: storage, sync, Google's limits, sending, AI jobs, security. |
| [DESIGN.md](DESIGN.md) | The binding design language, Skypaper: look, motion, every screen, keyboard map, wording. |
| [10-engine-foundation.md](10-engine-foundation.md) | The Engine thread's plan: the new foundation, a real database, the sealed email box, the AI queue, outgoing mail. |
| [20-providers-sync.md](20-providers-sync.md) | The Providers & Sync thread's plan: the Gmail fix, Gmail rebuild, iCloud, Fastmail, calendars, Outlook, Google's review. |
| [30-ui-revamp.md](30-ui-revamp.md) | The UI thread's plan: the new look, motion, every screen, onboarding, accessibility, speed. |
| [40-platform-quality.md](40-platform-quality.md) | Tooling, tests, security, releases, open-source readiness, Google paperwork. |
| [50-thread-briefs.md](50-thread-briefs.md) | The exact launch messages for the three threads, plus the launch checklist and launch decisions. |
| STATUS.md | Not there yet. Created at launch. The threads' shared notes file. |
| [proposals/](proposals/) | The six competing proposals (three architectures, three designs) the final documents chose between. Kept for history. |
| [_council/](_council/) | How the plans were made: shared facts, critiques, judges' scorecards, planning-agent logs. Process records only. |

> **What this means:** Everything you need to decide on is in the roadmap and the two rulebooks. The rest is detail and history.

## What happens next

1. You answer the decisions in the roadmap, or accept the defaults. Silence means the defaults. The first five are the most time-sensitive, because Google's calendar depends on them.
2. In the first two days you pick a domain for the website, create a public repository for downloads, and confirm Google's per-minute limit.
3. You say "go". The orchestrator pushes the plans and launches the threads in the order set out in [50-thread-briefs.md](50-thread-briefs.md): Providers & Sync first, so the Gmail fix starts at once, then Engine, then UI.
4. Each thread reports in plain English after every step: what works, what you can try, what is next. You try local builds and run a few live checks by hand.
5. You merge the 0.2.4 fix to main when it is ready. Later you merge 0.3.0 and 0.4.0. Agents never do that for you.

> **What this means:** You answer, you say go, and then you review short updates. Main changes only when you merge.

## What this is not

- **No code yet.** This phase is planning only. No app code is written and nothing is built.
- **Nothing on main.** Everything lives on the `revamp` branch. Main only changes when you merge the 0.2.4 fix and later releases.
- **Not a promise about Google.** Its review runs on its own clock. Until it ends, Gmail works for you and up to 100 invited testers.

The HTML mockups of every screen are being built separately, on the branch `rv/ui/mockups`. They will show the new look before any real screen is built.

> **What this means:** This folder is the plan, nothing more yet. Your code and your mail are untouched until you decide otherwise.

## Decisions for you

**Do you want to answer the roadmap's ten main decisions, or accept every default?**
- Options: (a) answer the ten, accept the defaults for the rest; (b) accept every default; (c) read everything first.
- **Default: (a).** The first ten shape Google's calendar and the look; the rest are easy to change.
- Consequence: (b) starts fastest and is safe. (c) is thorough but delays the Gmail fix.
