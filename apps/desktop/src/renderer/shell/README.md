# `renderer/shell`: what other lanes call on the shell (F9)

This folder holds the few shell functions that screens owned by other lanes need. It is part of Phase 0 artifact F9 and freezes on day 3 (2026-10-29). After the freeze, changes are **additive only**. Lane `ui-shell` owns the folder and builds the real shell on days 4-11. Until then, every function in `index.ts` throws `NotImplementedError` naming lane `ui-shell`.

Run the tests with `npx tsx --test apps/desktop/src/renderer/shell/index.test.ts`. `npx tsc --noEmit -p apps/desktop/tsconfig.json` checks the call examples and their `@ts-expect-error` lines.

## The surface in plain words

**Sheets.** `ui-onboard` builds the reconnect sheet and the consent card, but other lanes open them: the status slot, Settings → Accounts, Settings → AI and Ask. They call `openSheet('reconnect', {accountId, mode})` with `mode` `'reconnect'` (for `needsReauth`, or `health.reconnectBy` within 24 hours) or `'grant'` (for `needsPermission`). The sheet then calls `api.account.reconnect` or `api.account.grantPermissions` and follows that flow's `connect` frames. For consent they call `openSheet('consent')`, optionally with `{provider, model}` in the contract's names, which otherwise default to the Summaries choice; Allow sends `api.consent.grant`. The shell shows one sheet at a time. Opening a different one cancels the first. While a sheet is open the shell adds the modal `sheet` key context, so Esc cancels and nothing behind the sheet answers. `closeSheet()` closes it, and `useSheet()` tells the shell's sheet slot what to render (gap list U5, S16).

**The command target.** The palette's first line names what commands act on ("For: Drew Bell · October illustrations"). The focused screen calls `useCommandTarget({kind, id, title, detail})`. The reader passes its thread, the calendar its open event, Settings the focused account row. The innermost focused caller wins. `useCurrentTarget()` returns the target, and the shell puts it in every `CommandContext` (gap list U1, A12).

**Routes.** Choosing a Settings row in ⌘K returns a route such as `settings/mail#undoSeconds`. `openRoute(route)` opens Settings on that section, scrolls the row into view and focuses its control. Ask's "Use another provider" link uses `settings/ai` (gap list U3, S15).

## Where the rest lives

| Need | Home |
|---|---|
| Keys, contexts, the palette's entries, Settings rows in the palette | `renderer/commands` (`registerSetting`, `commandsForPalette`, `run`) |
| Streams, the clock, the shared undo stack, consent | `renderer/data` (`useFrames`, `useNow`, `undoStack`, `useConsent`) |
| Component props | `renderer/ui/props.ts` |
