# Aplos revamp: start here

This folder is the plan for rebuilding Aplos Mail. Nothing in it is built yet. Three AI coding threads will follow it in parallel, one for the engine, one for mail providers and sync, and one for the screens. You steer by answering a few decisions and trying each build.

## Read this first (about 10 minutes)

1. Open [overview.html](overview.html) in a browser. It shows the timeline, how the parts fit together, and the new look.
2. Read the "In plain English" section of [00-roadmap.md](00-roadmap.md).
3. Read the roadmap's "Top decisions" and answer the ones you care about. If you skip one, its default applies.

The roadmap's "What you need to do, and when" lists your tasks by week, starting on day 1.

The HTML mockups of every screen are being built on branch `rv/ui/mockups`. They show the new look before any real screen exists.

Everything else in this folder is optional. ARCHITECTURE.md, DESIGN.md and 50-thread-briefs.md each open with a plain-English section. The workstream plans (10 to 40) help only when you want to check on one thread.

## What happens after you say go

The orchestrator pushes the plans and starts the Providers & Sync thread first, so the Gmail fix begins at once. The Engine and UI threads follow. Each thread reports in plain English after every milestone. Main changes only when you merge 0.2.4, 0.3.0 and 0.4.0, and agents never merge for you.

## What's in here

| File | What it is | Read it? |
|---|---|---|
| [overview.html](overview.html) | Visual overview | First |
| [00-roadmap.md](00-roadmap.md) | What you get, when, your decisions and tasks; reference below that | The top part |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Engine rules for storage, sync, Google's limits and security | Optional |
| [DESIGN.md](DESIGN.md) | The Skypaper look, every screen, the keyboard map | Optional |
| [10-engine-foundation.md](10-engine-foundation.md) | Engine thread plan | Optional |
| [20-providers-sync.md](20-providers-sync.md) | Providers & Sync thread plan, including the Gmail fix | Optional |
| [30-ui-revamp.md](30-ui-revamp.md) | UI thread plan | Optional |
| [40-platform-quality.md](40-platform-quality.md) | Tooling, tests, security, releases, Google paperwork | Optional |
| [50-thread-briefs.md](50-thread-briefs.md) | Launch messages for the three threads | Optional |
| STATUS.md | The threads' shared log, created at launch | Optional |
| [proposals/](proposals/) | The six competing proposals the plans chose between | History |
| [_council/](_council/) | Records of how the plans were made | History |
