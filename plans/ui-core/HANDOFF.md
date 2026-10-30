# UI-core handoff (updated 2026-10-31; Linux box kainoas-linux-mba; a fresh thread continues)

Lean mode (roadmap 5.1a/5.1c): Sonnet for thread work, all UI code and every review; SWE-2 (`delegate_task`, `acpRegistry_devin`, `swe-2-high`) for well-specified non-UI work; Opus for MailFrame, the key relay, the composer and prefetch (lane card). Settle your own thread when you park. In every shell `source ~/.nvm/nvm.sh && nvm use 24`; headless only. Run foreground subagents (`run_in_background:false`) and wait in-turn.

## Merged
#96 (ui-foundation requests + axe), #97 (ui-shell), #98 (ui-home) are on revamp; DESIGN section 10 wording landed by the Integrator.

## Open
- **#122** `rv/ui-foundation/ui-scorers` (9465077): axe, mockup-diff and taste-judge scorers for the hill-climb harness, with review fixes and a second-round check. Watch for review comments and the Integrator's merge.
- **ui-reader** `rv/ui-reader/reader` (worktree `~/.t3/worktrees/aplos-mail/rv-ui-reader`, pushed): slice 1 done = `renderer/mailframe/**` (MailFrame host by Opus: sandbox allow-same-origin without scripts, sanitiser, protocol validation, 15-item hostile corpus, 84 unit + 34 browser tests). Needs: an Opus security review of the host (it departs from the card's `sandbox=""`: allow-same-origin is needed to measure a scriptless frame; sanitiser is load-bearing), then:
  1. **Reader screen** `screens/reader/**` (Sonnet): sender line, big summary (Newsreader), action row (Space on the main one), thread with earlier messages (O), find, attachments and failures, image blocked / "N trackers removed"; J/K swap threads with the double-buffer prefetch (no blank sheet: 500-move fuzz with 0-2.5 s body latency; previous letter stays; 12 px loading line after 1.5 s); E, L, Space, R from the reader; `useCommandTarget` for the thread; `openThread`/`useOpenThread` from the shell store (shell/store-thread.ts) feeds it.
  2. **Compose and inline reply** `screens/compose/**` (Opus for the composer): inline reply, compose as a page, schedule, discard, the AI draft as dim text accepted with Tab, dictation with LevelMeter and "Listening. Release R to keep, Esc to cancel." (dictation hook), send states and the outbox/undo tray from the stand-in engine, surviving reload; fuzz of send, undo and stand-in restart (no duplicate tray, no lost draft).
  3. Harness states for every DESIGN 7.5 and 7.6 state, both themes, two sizes, axe clean; then owner-ready visuals (demo mail only) before any PR (roadmap 12), hill-climb visuals before READY-FOR-OWNER.
  4. REQUESTs from the MailFrame report still to post: declare `htmlparser2` ^10.1.0 in apps/desktop/package.json (plat-ci approval), contract comment on `MailFrame.srcdoc` (sandbox note), plat-ci to wire `mailframe/browser/playwright.config.ts` into CI, `frame-src aplos-mail:` CSP when eng-html lands, shell returns focus to the reader on Esc from `onKey`, optional label prop for the loading line ("Loading Maple Library…"), Integrator live run on a Mac for keys with focus inside the sealed frame.
- Lane card: `plans/lanes/ui-reader.md` on revamp; read only the plan sections it names.

## Known gaps carried from #97/#98 (see their PR bodies)
⌘-held hint tracker unwired; FatalScreen has no canRetry; rejected-row Retry in `axeKnownDefects`; data `windows.move()` drops a held response; global commands with no handler (palette, compose, ask.*, nav.today, sidebar toggle, skip links, nav.back).

## Disk and processes
/tmp is a shared 7.5 GB tmpfs; scorers and tests remove their scratch dirs; delete each worktree's `artifacts/` when idle. Worktrees: `rv-thread-ui-core`, `rv-ui-home`, `rv-ui-foundation` (scorers branch), `rv-ui-reader`.
