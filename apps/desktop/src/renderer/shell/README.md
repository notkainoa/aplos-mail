# `renderer/shell`: what other lanes call on the shell (F9)

This folder holds the few shell functions that screens owned by other lanes need. It is part of Phase 0 artifact F9 and freezes on day 3 (2026-10-29). After the freeze, changes are **additive only**. Lane `ui-shell` owns the folder. `index.ts` is implemented on small module-level stores (`store-core.ts`, `store-sheet.ts`, `store-target.ts`, `store-toast.ts`, `store-route.ts`); React reads them with `useSyncExternalStore`. `NotImplementedError` stays exported but nothing throws it now.

Run the tests with `cd apps/desktop && npx tsx --test 'src/renderer/shell/*.test.ts'`. `app.test.ts` covers the new renderer entry's boot proof (`renderer/App.tsx`, mounted by `renderer/main.tsx`): it boots the stand-in engine on the `demo` and `empty` scenarios, watches Home through `watchHome` (window frames, `Counts` changes, a `reset` frame reopening the window), and renders `HomeContent` with react-dom/server, in node with no DOM. `npx tsc --noEmit -p apps/desktop/tsconfig.json` checks the call examples and their `@ts-expect-error` lines.

## The surface in plain words

**Sheets.** `ui-onboard` builds the reconnect sheet and the consent card, but other lanes open them: the status slot, Settings → Accounts, Settings → AI and Ask. They call `openSheet('reconnect', {accountId, mode})` with `mode` `'reconnect'` (for `needsReauth`, or `health.reconnectBy` within 24 hours) or `'grant'` (for `needsPermission`). The sheet then calls `api.account.reconnect` or `api.account.grantPermissions` and follows that flow's `connect` frames. For consent they call `openSheet('consent')`, optionally with `{provider, model}` in the contract's names, which otherwise default to the Summaries choice; Allow sends `api.consent.grant`. The shell shows one sheet at a time. Opening a different one cancels the first. While a sheet is open the shell adds the modal `sheet` key context, so Esc cancels and nothing behind the sheet answers. `closeSheet()` closes it, and `useSheet()` tells the shell's sheet slot what to render (gap list U5, S16).

**The command target.** The palette's first line names what commands act on ("For: Drew Bell · October illustrations"). The focused screen calls `useCommandTarget({kind, id, title, detail})`. The reader passes its thread, the calendar its open event, Settings the focused account row. The innermost focused caller wins. `useCurrentTarget()` returns the target, and the shell puts it in every `CommandContext` (gap list U1, A12).

**Routes.** Choosing a Settings row in ⌘K returns a route such as `settings/mail#undoSeconds`. `openRoute(route)` opens Settings on that section, scrolls the row into view and focuses its control. Ask's "Use another provider" link uses `settings/ai` (gap list U3, S15).

## Additive exports (implementation notes)

- **Sheet key context.** `renderer/commands` defines the modal `sheet` context and its `sheet.default` / `sheet.cancel` keys but has no helper that pushes it. The shell calls `useSheetContextActive()` and adds `'sheet'` to the contexts it passes to `buildStack`. `registerSheetCancel(hook)` registers a hook called with a sheet that another sheet replaced (the reconnect sheet cancels its `api.account.cancelConnect` flow there); `closeSheet` does not call it. Focus returns to the element focused when the first sheet opened (no DOM, no focus change).
- **Toasts.** An Undo toast is one with `undoable: true` or an action whose `commandId` is `app.undo`. The store runs no timers: the `Toast` component owns the life (plain 4 s, Undo 8 s, `persistent` never, paused on hover and focus) and calls `dismissToast` after its fade (`ToastData.undoable` is set for any Undo toast). `persistent` is how a failure stays (`ToastKind` has no error kind). The stack keeps `TOAST_LIMIT` (3): a fourth drops the oldest toast that is neither Undo nor persistent, which can be the newcomer when three Undo toasts are open; Undo and persistent toasts are never evicted, so the stack can exceed the cap and `ToastStack` shows the last three. A push with a live id updates that toast in place. `holdToast` / `releaseToast` are no-ops kept for the frozen surface. `setToastCommandRunner(run)` is how the shell wires the registry: `runToastAction(id, actionId)` calls `run(commandId)` (`KeysProviders` mounts it over the registry and the current context stack, and clears it on unmount), falls back to the toast's `onAction`, then closes the toast. Navigation, saves and sync ticks never toast: callers do not push for them.
- **Routes.** `openRoute` also shows Settings and leaves the route pending. Settings reads `useSettingsTarget()` (or `useRoute()`), opens `section`, scrolls `row` into view, focuses its control, then calls `consumeRoute(seq)`. `useAppRoute()` / `navigate(screen)` hold the shell's current `Screen` (default `'home'`).

## Where the rest lives

| Need | Home |
|---|---|
| Keys, contexts, the palette's entries, Settings rows in the palette | `renderer/commands` (`registerSetting`, `commandsForPalette`, `run`) |
| Streams, the clock, the shared undo stack, consent | `renderer/data` (`useFrames`, `useNow`, `undoStack`, `useConsent`) |
| Component props | `renderer/ui/props.ts` |
