# Aplos revamp: start here

This folder is the plan for rebuilding Aplos Mail. Nothing in it is built yet. Six AI coding threads will follow it in parallel, one of them an Integrator that keeps the shared branch healthy and reports to you. Expect a build you can use every day in about two and a half weeks, and a finished redesigned version in about three and a half. Nothing in the plan costs money.

## Read this first (about 8 minutes)

1. Open [overview.html](overview.html) in a browser. It shows the four phases in days, the six threads and the decisions.
2. Read [00-roadmap.md](00-roadmap.md) down to "Reference": the plan in days, the decisions already made, and your free tasks.
3. No decisions are open. You review work feature by feature: a thread posts steps to try, screenshots and a short recording, you give feedback until you approve, then it runs deep reviews, opens a pull request and merges into `revamp` itself unless something you would notice changed. Main only changes when you merge.

The look is called Paper. DESIGN.md has the full spec, and `../mockups/index.html` (also at aplos-mockups.vercel.app) shows every screen. The screen threads build from both.

## What happens after you say go

The Integrator and Engine threads start first. For two or three days the Engine thread sets the shared rules while the others prepare. This round is Gmail and Google Calendar; Outlook, iCloud and Fastmail come in round 2. Then about 23 lanes build at once. Features reach you for review from about day 7, with the main screens on demo mail around day 9, the new Aplos on your real mail around day 15, and you start using it daily around day 18. Main changes only when you merge, and agents never merge to main for you.

## What's in here

| File | What it is | Read it? |
|---|---|---|
| [overview.html](overview.html) | Visual overview | First |
| [00-roadmap.md](00-roadmap.md) | The plan in days, your decisions and tasks; lanes, threads and branches below | The top part |
| [50-thread-briefs.md](50-thread-briefs.md) | Launch messages for the six threads and the launch checklist | Optional |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Engine rules for storage, sync, Google's limits and security | Optional |
| [DESIGN.md](DESIGN.md) | The look, every screen, the keyboard map (being revised) | Optional |
| [10-engine-foundation.md](10-engine-foundation.md) | Engine detail | Optional |
| [20-providers-sync.md](20-providers-sync.md) | Providers detail | Optional |
| [30-ui-revamp.md](30-ui-revamp.md) | Screens detail | Optional |
| [40-platform-quality.md](40-platform-quality.md) | Tooling, tests, security, releases, website | Optional |
| STATUS.md, OWNERS.md | The threads' shared log and folder ownership map, created at launch | Optional |
| [proposals/](proposals/) | The competing proposals the plans chose between | History |
| [_council/](_council/) | Records of how the plans were made | History |

Plans 10 to 40 still describe the earlier week-based schedule in places. Where they disagree with the roadmap, the roadmap wins until they are aligned.
