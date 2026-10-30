# UI-core handoff (2026-10-30, Linux box kainoas-linux-mba; fresh thread continues)

Lean mode (roadmap 5.1a/5.1c): Sonnet for thread work, all UI code and every review; SWE-2 (`delegate_task`, `acpRegistry_devin`, `swe-2-high`) for well-specified non-UI work and extra attempts; Opus only for named cases (MailFrame host and key relay, composer, prefetch). Settle your own thread when you park; settle child threads after using them. In every shell `source ~/.nvm/nvm.sh && nvm use 24`; headless only; `npm run check` once per PR, one full suite at a time.

## Open PRs (owner approved the visuals 2026-10-29; STATUS APPROVED 18:10)
Merge order #96, then #97, then #98 (stacked; after each merge merge `origin/revamp` into the next branch, and for ui/ file conflicts take the foundation side, never `-X theirs`).
- **#96** `rv/ui-foundation/requests-on-revamp` (b56257d): additive ui props, 8 axe a11y fixes, axe check (`@axe-core/playwright` 4.14.0, dev only). `lane-approved:plat-ci` applied; its CI check is queued behind Mac load. Devin left one flag not visible on GitHub (Devin Review app only).
- **#97** `rv/ui-shell/shell-on-revamp` (0113cb8): the shell. Devin findings fixed and answered.
- **#98** `rv/ui-home/home-on-revamp` (3d388a1): Home, Later, lists, Done. Devin findings fixed and answered.
- **Not self-merging #97/#98**: new failure-path copy and design differences (list in both PR bodies) need the owner's call: "keep as approved" or "apply the design fixes". The orchestrator is asking. If approved as is, squash-merge #97 then #98 yourself after re-running the §12.3(g) image diff against the approval snapshot (`~/.local/share/aplos-mail-review/{ui-shell/b5e4baf,ui-home/91a4c6d}`; the diff script pattern: Playwright page + `tests/visual/support/compare.ts comparePngs`, 112 shots had 0 changed pixels at 18:10; behaviour changes since: nav shortcuts work, per-toast Undo, arrow keys in account menu, paging past 200 rows). Post MERGED lines.
- **Scorers** `rv/ui-foundation/scorers` (9d6e301, pushed, no PR yet): axe, mockup visual-diff and Sonnet taste judge in `tests/visual/scorers/` for the hill-climb harness (plat-ci, roadmap 5.1c); review fixes applied (open failures score 0, no silent sample shrinking, signal cleanup, call budget). Open its PR (base revamp, `Lane-Approved` none needed, stacked on #96-#98) after they merge; one Sonnet review of the diff first. Known: taste judge costs about 8 Sonnet calls per default run, cached by image hash.

## Next work
1. After #96-#98 merge: `rv/ui-reader/reader` from `origin/revamp`, per `plans/lanes/ui-reader.md` (MailFrame host with srcdoc frame, reader, inline reply, compose, send states; Opus for MailFrame, key relay, composer, prefetch; owner-ready visuals before any PR; hill-climb visuals before READY-FOR-OWNER). Needs `eng-html` only for the real frame (parked); live runs go to the Integrator as REQUESTs.
2. Open follow-ups for the Integrator/others (all in STATUS): OWNERS rows for `screens/*.{ts,tsx,css}` (done per orchestrator), a Mac feel pass of Home triage motion (`node scripts/launch.mjs` on the home branch), real-engine switch WP5.6 later.
3. Known gaps listed in PR bodies: ⌘-held hint tracker not wired, FatalScreen has no canRetry, rejected-row Retry in `axeKnownDefects`, data `windows.move()` drops a held response, global commands with no handler (palette, compose, ask.*, nav.today, sidebar toggle, skip links, nav.back).

## Worktrees on this box (`~/.t3/worktrees/aplos-mail/`)
`rv-thread-ui-core` (this thread, branch rv/thread/ui-core; shell branch checked out via `git checkout`), `rv-ui-home` (home branch), `rv-ui-foundation` (scorers branch now). Lane cards: `git show origin/revamp:plans/lanes/<lane>.md`; cached copies of old ones in /tmp/ui-cards may be gone.

## Disk
/tmp is a 7.5 GB tmpfs shared with other threads; a quota stall blocked all shell commands for hours on 2026-10-30. Scorers and tests now remove their own scratch dirs; keep artifacts under each worktree's `artifacts/` (ignored) and delete them when idle.
