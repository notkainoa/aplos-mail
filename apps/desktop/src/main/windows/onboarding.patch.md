# REQUEST to eng-host: call `main/windows/onboarding.ts` from `windows.ts`, `lifecycle.ts`, `native-methods.ts`, `engine-host.ts`

This is a request, not applied code. The diff applies cleanly (`git apply --check`) to this branch's files and the result typechecks.

```diff
diff -ruN a/apps/desktop/src/main/engine-host.ts b/apps/desktop/src/main/engine-host.ts
--- a/apps/desktop/src/main/engine-host.ts
+++ b/apps/desktop/src/main/engine-host.ts
@@ -14,7 +14,7 @@
 import { draftMutationId } from './desktop-policy';
 import type { AppState, Listener } from '@aplos/contract/legacy/types';
 import { assertCaller, external } from './security';
-import { claims, emit, applyAppearance } from './windows';
+import { claims, emit, applyAppearance, onboarding } from './windows';
 import { nativeMethods, notify, invokeNative } from './native-methods';
 import { closing } from './lifecycle';
 import { legacyEngineMethods } from '@aplos/contract/allowlists';
@@ -177,6 +177,8 @@
     const draftId = draftMutationId(method, payload);
     if (draftId) claims.assertEditable(draftId, BrowserWindow.fromWebContents(event.sender)!.id);
     if (!service) throw new Error('The mailbox is restarting. Try again in a moment.');
+    // The renderer ended setup itself; main's own `Setup/end` on close is then skipped (the engine is idempotent anyway).
+    if (method === 'Setup/end') onboarding.noteRendererSetupEnd();
     return service.invoke(method, payload);
   });
   latestState = (await service.invoke('state.get')) as AppState;
diff -ruN a/apps/desktop/src/main/lifecycle.ts b/apps/desktop/src/main/lifecycle.ts
--- a/apps/desktop/src/main/lifecycle.ts
+++ b/apps/desktop/src/main/lifecycle.ts
@@ -4,7 +4,7 @@
 import { join } from 'node:path';
 import { homedir } from 'node:os';
 import { installPermissionHandlers } from './security';
-import { windows, focusMain, syncTheme, createWindow, setMain } from './windows';
+import { windows, focusMain, syncTheme, createWindow, setMain, onboarding, sessionFacts } from './windows';
 import { handleLink } from './protocol';
 import { menus } from './menu-bar';
 import { updates, installUpdate, startUpdates } from './updater';
@@ -52,7 +52,8 @@
     handleLink(url);
   });
   app.on('second-instance', (_event, argv) => {
-    focusMain();
+    // F3: while the engine boots, startup is still choosing the one window; a second launch only queues its link.
+    if (started) focusMain();
     for (const arg of argv) if (/^(mailto|aplos):/i.test(arg)) handleLink(arg);
   });
   app.on('activate', () => {
@@ -95,7 +96,9 @@
       startUpdates();
       menus();
       // eng-host: a menu-bar status item added here must also skip creation when `isTest`.
-      setMain(createWindow());
+      // No account and a login launch: no window until the Dock or the menu-bar item is clicked.
+      const atLogin = !isTest && app.getLoginItemSettings().wasOpenedAtLogin;
+      if (onboarding.start(sessionFacts(), { atLogin }) === 'mail') setMain(createWindow());
       if (!isTest) app.setAsDefaultProtocolClient('aplos');
       for (const arg of process.argv) if (/^(mailto|aplos):/i.test(arg)) handleLink(arg);
     })
diff -ruN a/apps/desktop/src/main/native-methods.ts b/apps/desktop/src/main/native-methods.ts
--- a/apps/desktop/src/main/native-methods.ts
+++ b/apps/desktop/src/main/native-methods.ts
@@ -11,14 +11,18 @@
 import { join, basename, extname } from 'node:path';
 import { tmpdir } from 'node:os';
 import { record, text, external } from './security';
-import { claims, pendingClose, permittedClose, main, emit, focusMain, popout } from './windows';
+import { claims, pendingClose, permittedClose, main, emit, focusMain, popout, onboarding } from './windows';
 import { updates, restartToUpdate, cancelInstall } from './updater';
 import { latestState } from './engine-host';
 import { cancelQuit } from './lifecycle';
 import { legacyDesktopMethods } from '@aplos/contract/allowlists';
 import { isTest, recordNotification } from './test-mode';
 
-const nativeMethods = new Set<string>(legacyDesktopMethods);
+const nativeMethods = new Set<string>([
+  ...legacyDesktopMethods,
+  'Window/openOnboarding',
+  'Window/finishOnboarding',
+]);
 function notify(title: string, body: string, threadId?: string) {
   if (isTest) return recordNotification(title, body, threadId);
   if (!Notification.isSupported())
@@ -69,6 +73,15 @@
     await external(payload.url);
     return true;
   }
+  if (method === 'Window/openOnboarding') {
+    if (payload.mode !== 'first' && payload.mode !== 'review') throw new Error('Invalid onboarding mode.');
+    onboarding.open(payload.mode);
+    return true;
+  }
+  if (method === 'Window/finishOnboarding') {
+    await onboarding.finish();
+    return true;
+  }
   if (method === 'window.compose') {
     const id = text(payload.draftId, 'draft ID', 200);
     if (!latestState?.drafts.some(draft => draft.id === id))
diff -ruN a/apps/desktop/src/main/windows.ts b/apps/desktop/src/main/windows.ts
--- a/apps/desktop/src/main/windows.ts
+++ b/apps/desktop/src/main/windows.ts
@@ -4,9 +4,12 @@
 import type { AppState, Listener } from '@aplos/contract/legacy/types';
 import { rendererFile, devURL, trustedURL, external } from './security';
 import { pendingLinks } from './protocol';
-import { latestState } from './engine-host';
+import { latestState, service } from './engine-host';
 import { closing, quitting, finishQuit } from './lifecycle';
 import { isTest } from './test-mode';
+import { createOnboarding, adaptBrowserWindow } from './windows/onboarding';
+import type { SetupFacts } from './windows/onboarding.policy';
+import { randomUUID } from 'node:crypto';
 
 const windows = new Set<BrowserWindow>();
 const claims = new DraftOwnership();
@@ -21,9 +24,18 @@
   const win = BrowserWindow.getFocusedWindow() || main;
   win?.webContents.send('aplos:event', { type: 'command', payload: value });
 }
+/** What `Session/get.hasAccounts` and `.setup` will say; until the engine serves them, today's state answers. */
+function sessionFacts(): SetupFacts {
+  return {
+    hasAccounts: !!latestState?.accounts.length,
+    setup: latestState?.settings.onboardingDone ? { completedAt: 1 } : {},
+  };
+}
 function focusMain() {
+  // Dock, second launch, links, notifications. An open onboarding window answers them (F3: never a second window).
   // Test mode never shows or focuses a window (a window is still created so the renderer can be inspected).
-  if (isTest) return;
+  const decision = onboarding.activate(sessionFacts());
+  if (isTest || decision.kind === 'focus-onboarding' || decision.kind === 'open-onboarding') return;
   if (!main || main.isDestroyed()) main = createWindow();
   if (main.isMinimized()) main.restore();
   main.show();
@@ -184,6 +196,38 @@
 function setMain(win: BrowserWindow) {
   main = win;
 }
+/** The onboarding window (DESIGN 7.11): one at a time, handoff to a hidden mail window, `Setup/end` on every close. */
+const onboarding = createOnboarding({
+  createWindow: options => {
+    const win = new BrowserWindow(options);
+    windows.add(win);
+    win.on('focus', () => syncTheme(false));
+    win.webContents.on('did-finish-load', () => {
+      if (latestState) win.webContents.send('aplos:event', { type: 'state', payload: latestState });
+    });
+    win.on('closed', () => {
+      windows.delete(win);
+      if (quitting && !windows.size) finishQuit();
+    });
+    return adaptBrowserWindow(win);
+  },
+  engine: { call: (method, input) => service!.invoke(method, input) as Promise<unknown> },
+  mail: {
+    current: () => (main && !main.isDestroyed() ? adaptBrowserWindow(main) : undefined),
+    // createWindow() shows on ready-to-show itself; the handoff's show is idempotent and fades onboarding right after.
+    create: () => adaptBrowserWindow((main = createWindow())),
+  },
+  countAccounts: async () => latestState?.accounts.length ?? 0,
+  testMode: isTest,
+  dark: () => nativeTheme.shouldUseDarkColors,
+  preloadPath: join(__dirname, 'preload.cjs'),
+  trustedURL,
+  openExternal: url => external(url),
+  target: { devURL, file: rendererFile },
+  clock: { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout) },
+  opId: () => randomUUID(),
+  sendShown: win => win.send('aplos:event', { type: 'shown' }),
+});
 
 export {
   windows,
@@ -200,4 +244,6 @@
   createWindow,
   popout,
   setMain,
+  onboarding,
+  sessionFacts,
 };
```

1. **Startup and second launch (F3).** `onboarding.start(facts, {atLogin})` opens the onboarding window itself when there is no account and no recorded finish or skip; it returns `mail` (the caller opens the mail window), `none` (a login launch with no account stays windowless) or `onboarding`. `second-instance` does nothing until `started`, then `focusMain()` asks `onboarding.activate(facts)`, which focuses the one window and never opens a second.
2. **Native methods.** `Window/openOnboarding {mode}` calls `open(mode)` (creates, or focuses the existing window); `Window/finishOnboarding` calls `finish()`: the mail window is created hidden, shown on `ready-to-show`, and the onboarding window is faded over 120 ms in that same callback and closed (300 ms force-close, F4). With two or more accounts, `ui.lastAccount` is set to `all` before the mail window exists (F7). Both names also go in the generated methods table and in `preload.ts`'s allowlist (generated from the contract); the diff adds them to `nativeMethods` only.
3. **`shown` event.** `sendShown` runs on `ready-to-show` (also in test mode, so the renderer reaches its entrance state in a hidden window); the diff sends `{type:'shown'}` on today's `aplos:event` channel, and moves to the `desktop` frame when the host routes it (`wire.ts` `DesktopEvent`).
4. **`Setup/end {reason:'closed'}`** is sent by main once per onboarding window on `closed`; the `engine-host.ts` hunk reports the renderer's own `Setup/end` so main skips its call (the engine is idempotent either way). Until `eng-ai` serves `Setup/*` the legacy engine rejects it and the rejection is swallowed.
5. **Facts and test mode.** `sessionFacts()` reads today's `latestState` (`accounts`, `settings.onboardingDone`) and becomes `Session/get.hasAccounts` and `.setup` later. Test mode (`APLOS_TEST=1`) never shows or focuses any window, and the menu-bar item (not in this diff) should call `focusMain()` so a click opens the onboarding window on a fresh install. `createWindow()`'s own `ready-to-show` show stays; the handoff's show is idempotent and its fade follows in the same tick.
