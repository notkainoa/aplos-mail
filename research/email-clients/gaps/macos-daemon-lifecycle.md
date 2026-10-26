# macOS engine lifecycle: resident `utilityProcess` (A0) vs `SMAppService` LaunchAgent (A1)

Gap report, 2026-10-25. This report checks the mechanics behind candidates A0 and A1 in `SYNTH-architecture.md` §11. Earlier reports estimated A1 at 1 to 5 weeks without checking those mechanics.

**Legend.**
- **[V]** verified, with a source path, URL or local measurement.
- **[I]** inference.
- **[U]** unverified.

**Paths.**
- Clone paths are relative to `/Users/knewton/.t3/aplos-research/src/`.
- Aplos paths are relative to `apps/desktop/`.
- Prototype scripts and outputs are in `/Users/knewton/.t3/aplos-research/proto/daemon/`.

**Method.** Nothing was installed or registered with launchd, and no window was opened.
- I measured idle cost with a copy of the worktree's Electron 44.7.2 marked `LSUIElement`. It was ad-hoc re-signed and run with `--use-mock-keychain`.
- No code from a cloned repository was run.

---

## 0. Bottom line

1. **Electron 44 already requires macOS 13** [V `electron/docs/breaking-changes.md` "Removed: macOS 12 support"; `node_modules/electron/dist/Electron.app/Contents/Info.plist` has `LSMinimumSystemVersion` 13.0].
   - Aplos still ships `LSMinimumSystemVersion` 12.0 [V `package.json` `build.mac.minimumSystemVersion`; `release/mac-arm64/Aplos Mail.app/Contents/Info.plist` reads 12.0 with framework 44.7.2]. That is a latent bug: macOS 12 users can launch a build that can't run.
   - Raise it to 13.0. The macOS 13 requirement of `SMAppService` then costs nothing.
2. **Electron 44 can register a LaunchAgent with one call** (`app.setLoginItemSettings({type:'agentService', serviceName, openAtLogin})`). The open-source Electron app LangAlpha ships this.
   - **But the daemon should not be Electron.** A windowless copy of the same binary blocks Squirrel updates, and a separate Electron helper needs a ~286 MB framework copy (§2).
   - The workable A1 shape is a **Node single-executable daemon in its own small nested `.app`**, plus a native shim for Keychain, notifications and sleep/wake.
3. **A1 is blocked on Developer ID signing**, which Aplos doesn't have yet [V `TODO.md:49`, `DECISIONS.md:30`].
   - Electron's docs say login-item settings "may silently fail" for apps that aren't signed and notarized [V `electron/docs/api/app.md:1491-1494`].
   - Ad-hoc builds already trigger Keychain prompts after each update [V `PROGRESS.md:448`].
4. **Recommendation.** Ship A0 now: about 1.5-2 weeks after F4, and it largely overlaps with B. Make it A1-ready, then build A1 only once Developer ID works and a real need appears (sync after ⌘Q, or CLI/agent access with the UI quit). Grounded in the verified steps below, **A1 costs 3.5-5 weeks on top of A0**, the upper end of the earlier estimates.

---

## 1. `SMAppService` from Electron

**Verified facts**
- **Types and service name.** Electron 44.7.2 exposes `type: 'mainAppService' | 'agentService' | 'daemonService' | 'loginItemService'` and `serviceName` on both `setLoginItemSettings` and `getLoginItemSettings`. `getLoginItemSettings().status` returns `'not-registered' | 'enabled' | 'requires-approval' | 'not-found'` [V `node_modules/electron/electron.d.ts:22513-22545`, `docs/api/app.md:1449-1513`].
- **First release.** The feature came from electron/electron#37244, merged 2023-10-16 (semver/major, no-backport). The GitHub compare API shows its merge commit `f7b1c75` is an ancestor of v29.0.0 and not of v28.0.0, so **it first shipped in Electron 29** [V `gh api repos/electron/electron/compare/...`].
- **Electron 44 cleanup.** Electron 44 removed `openAsHidden`, `wasOpenedAsHidden` and `restoreState` because they only worked on macOS 12 and earlier [V `breaking-changes.md` "Removed: Pre-macOS 13 login item attributes"; PR #52351].
- **What the code does.** It maps `agentService` to `[SMAppService agentServiceWithPlistName:]` and calls `registerAndReturnError`/`unregisterAndReturnError` [V `electron/shell/common/platform_util_mac.mm:65-84, 197-227`].
  - There is no availability fallback.
  - **Errors are only `LOG(ERROR)`'d.** The JavaScript call returns `void`, so callers must read `status` back afterward. LangAlpha's code says exactly this [V `LangAlpha/desktop/src/remoteControl.js:252-262`].
  - Both calls throw a `TypeError` if `type` isn't `mainAppService` and `serviceName` is empty [V `browser_mac.mm:376-405`].
- **Where things live.** Apple requires the agent plist in `Contents/Library/LaunchAgents` [V Apple `agent(plistName:)`]. `BundleProgram` is "an app-bundle relative path… only supported for plists that are installed using SMAppService" [V `man launchd.plist`].
- **What `register()` does.** For an agent, it bootstraps immediately and on every later login. Already-registered returns `kSMErrorAlreadyRegistered`. A user denial returns `kSMErrorLaunchDeniedByUser` [V Apple `register()` doc].
- **Approval.** Every app with a LoginItem, LaunchAgent or LaunchDaemon gets a switch in System Settings › Login Items. Apple's guidance is to check status at launch and call `openSystemSettingsLoginItems()` if the helper isn't authorized [V Apple "Updating helper executables from earlier versions of macOS"].
  - Electron doesn't expose `openSystemSettingsLoginItems`. Aplos would open the pane by URL [U: the scheme `x-apple.systempreferences:com.apple.LoginItems-Settings.extension` is widely used but undocumented].
  - Users who switch the agent off see `requires-approval`. Ollama treats that as "leave it alone" [V `ollama/app/cmd/app/app_darwin.m:1615-1618`].

**Packaging with electron-builder 26.18**
- `extraFiles` copies into `<App>.app/Contents` on macOS [V `node_modules/app-builder-lib/out/platformPackager.js:135`]. So `{from:'build/launchd', to:'Library/LaunchAgents'}` places the plist, and a helper bundle can go to `Library/LoginItems/`.
- `@electron/osx-sign` walks all of `Contents`, sorts by depth (deepest first) and signs every Mach-O, `.app` and `.framework` [V `@electron/osx-sign/dist/cjs/sign.js:172-194`]. electron-builder gives anything under `Library/LoginItems` the `entitlementsLoginHelper` file and everything else `entitlementsInherit` [V `app-builder-lib/out/mac/MacTargetHelper.js:159-160`].
- **Gotcha from LangAlpha.** A helper placed *beside* the main executable in `Contents/MacOS` is the same depth as that executable. It can be signed after the executable, which seals the bundle, and codesign then fails ("code object is not signed at all, In subcomponent"). It would also inherit Electron's JIT entitlements. LangAlpha replaces the signer to sign the helper first with an empty entitlement set [V `LangAlpha/desktop/scripts/sign-mac.mjs:1-22`].
  - A nested `.app` in `Contents/Library/LoginItems/` avoids the ordering problem because it is deeper [I].
- **Restricted entitlements.** A provisioning profile can only be embedded in an app-like bundle. A bare command-line daemon can't carry one, and Apple's fix is to "wrap your daemon in an app-like structure" [V Apple "Signing a daemon with a restricted entitlement"].
  - electron-builder has a `provisioningProfile` option [V `macOptions.d.ts`].
  - T3 Code signs a Developer ID Electron app with a profile granting `keychain-access-groups` and `com.apple.application-identifier` [V `pingdotgg-t3code/scripts/build-desktop-artifact.ts:1299-1370`].

## 2. Daemon runtime options

**Verified Aplos facts**
- The engine has no Electron imports. `engine-host.ts` only uses `process.parentPort` [V `src/main/engine-host.ts:9`].
- `server.ts` already runs the same `createService` in plain Node for browser preview [V `src/main/server.ts:33`].
- The Electron-only duties live in main:
  - unwrapping the data key with `safeStorage` [V `electron.ts:215`, `keyring.ts`];
  - notifications [V `electron.ts:123-124`];
  - `openExternal`.
- `powerMonitor`, `safeStorage` and `Notification` are main-process-only. `net` and `systemPreferences` also run in utility processes [V `electron/docs/api/*.md` "Process:" lines].
- Electron 44.7.2 embeds **Node 24.21.0** (SQLite 3.53.4), the same version as this Mac's Homebrew Node [V `ELECTRON_RUN_AS_NODE=1 Electron -p process.versions`]. `require('node:sqlite')` prints no experimental warning [V].

**Measured idle cost.** Each variant held a 2,000-row `node:sqlite` WAL database, a loopback HTTP listener and a 1 s timer. I sampled at 20 s, 120 s and 300 s on an M1 with 16 GB on AC power [V `out/samples.txt`].
- RSS is summed per process tree and double-counts shared framework pages, so phys_footprint is the better guide.

| Variant | Processes | RSS (sum) | phys_footprint | CPU |
|---|---|---|---|---|
| Plain Node 24.21 | 1 | 50 MB | **17 MB** | 0% |
| Node under `taskpolicy -b` (darwinbg, pri 4) | 1 | 50 MB | 17 MB | 0% |
| Electron binary as Node (`ELECTRON_RUN_AS_NODE`) | 1 | 64 MB | 13 MB | 0% |
| Electron main, windowless (`LSUIElement`) | 3 (main, GPU, network) | 212 MB | **38 MB** | 0% |
| Same with `disableHardwareAcceleration()` | 3 (GPU process still starts) | 204 MB | 36 MB | 0% |
| Electron main + `utilityProcess` (today's Aplos shape) | 4 | 281 MB | **53 MB** | 0% |

**Timers.** A 1 s timer stayed within 14 ms of schedule (p99 ≤ 4 ms) in every variant over 5 minutes, including windowless Electron and darwinbg Node [V `tools/drift.py` over `out/*.jsonl`]. So I saw no App Nap or timer throttling in this short, AC-powered test. Battery and longer windows remain unverified.

**Environment hazard.** This agent shell inherits `ELECTRON_RUN_AS_NODE` from T3 Code's backend. My first Electron run silently became plain Node until I unset it [V `env`; T3 Code sets it at `pingdotgg-t3code/apps/desktop/src/backend/DesktopBackendConfiguration.ts:533`]. A daemon must never select its mode from inherited environment variables.

**Options**

**(a) The same `Aplos Mail.app` binary in windowless mode as the agent's `BundleProgram`.** Reject this.
- A windowless Electron main launched by plain exec checks in with LaunchServices as `type="UIElement"` under the app's bundle ID and path [V `out/lsappinfo.txt`].
- Squirrel.Mac finds running copies with `runningApplicationsWithBundleIdentifier`, keeps those whose `bundleURL` matches, waits for them, and aborts with "App Still Running Error" if any remain [V `Squirrel.Mac/Squirrel/SQRLTerminationListener.m:51-66`, `SQRLInstaller.m:360-375`, at Electron 44's pinned commit `fffea30e`].
- **So a resident same-bundle daemon would block every update** [I, strong].
- One developer reports that registering an agent whose program is the app itself starts a second instance [V developer.apple.com/forums/thread/745712; no Apple reply].
- Dock clicks and `mailto:` opens could also go to the daemon instance [I].

**(a′) The Ollama trampoline.** Ollama copies its own binary into a mock `Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel` and makes that copy the agent's `BundleProgram` with argument `background` [V `ollama/scripts/build_darwin.sh:221-228`, `app/darwin/Ollama.app/Contents/Library/LaunchAgents/com.ollama.ollama.plist`]. In that mode the copy only spawns the real app with `hidden`. The comment explains this keeps "Allow in the Background" from breaking the main app [V `ollama/app/cmd/app/app.go:78-87`, `app_darwin.go:2005-2015`].
- This is a login launcher for a resident app, not a separate daemon. For Aplos, `mainAppService` already does that job [V `electron.ts:195`].

**(b) A separate Electron helper app** (`Aplos Mail Engine.app`). Viable only with a full second framework.
- Electron finds its framework and helpers at `<executable>/../../Frameworks`, and `LOG(FATAL)`s when the helper is missing [V `electron/shell/common/mac/main_application_bundle.mm`, `shell/app/electron_main_delegate_mac.mm:25-70`].
- A nested Electron app therefore needs its own `Electron Framework.framework`, which is **286 MB** [V `du`]. Sharing the parent's copy would need symlinks out of the nested bundle or rpath surgery [U].
- Idle footprint would be about 38-53 MB.

**(c) Node single-executable application (SEA) in a nested app bundle.** Recommended for A1.
- Node 24.21 SEA supports `"execArgvExtension": "none"`, which ignores `NODE_OPTIONS` and closes the "run my signed interpreter with your code" hole [V `node-files/sea.md:323-332`].
- SEA is still "Stability 1.1" [V]. Aplos already bundles the engine into one CJS file with esbuild [V `scripts/build-main.mjs`].
- Signing:
  - Node's own macOS entitlements are broad, including `get-task-allow` and `allow-dyld-environment-variables` [V `node-files/osx-entitlements.plist`].
  - Re-sign with only `allow-jit` (plus `allow-unsigned-executable-memory` if V8 needs it) [I].
- Cost:
  - about 17 MB footprint;
  - plus a per-architecture Node binary (the arm64 tarball is 27 MB xz-compressed [V]; the unpacked binary is ~100 MB [U]).
- Node can't reach the Keychain, UserNotifications or sleep/wake events by itself, so it needs (d).

**(d) A native shim.** Aplos already builds a universal Swift tool [V `scripts/build-main.mjs`, `native/symbols.swift`]. The shim needs:
- Keychain get/set;
- posting notifications;
- `NSWorkspace` sleep/wake events.

There are two ways to ship it [I]:
- **An N-API addon inside the daemon process.** Keychain ACLs then see the daemon's own identity.
- **A Swift sidecar** in the same helper bundle, talking over stdio. This is simpler to build, but a standalone executable that hands out secrets can be run by anything.

## 3. Keychain access from a helper

**Verified facts**
- **The current item.** `safeStorage` in Electron 44 uses Chromium 152's `KeychainPassword`, with service `"<app name> Safe Storage"` and account `"<app name>"` [V `electron/shell/browser/electron_browser_main_parts.cc:692-693`]. Electron's patch appends `" Key"` (non-MAS) [V `patches/chromium/feat_ensure_mas_builds_of_the_same_application_can_use_safestorage.patch`].
  - This Mac has `"Aplos Mail Safe Storage"` / `"Aplos Mail Key"` in **`login.keychain-db`**, the file-based keychain [V `security find-generic-password` metadata only].
- **Why it's file-based.** Chromium calls `SecItemAdd` and `SecItemCopyMatching` with service and account only, with no `kSecUseDataProtectionKeychain` and no access group [V `chromium-oscrypt/crypto_apple_keychain_v2.mm:106-125, 189-226`]. TN3137: the SecItem API "defaults to targeting the file-based keychain", and the file-based keychain "uses access control lists" [V `apple-docs/technotes_tn3137-on-mac-keychains.txt:15, 41`].
- **Code identity.** ACL trust is tied to the app's designated requirement (DR). Ad-hoc code "has a DR but it's tied to that specific version of the code" [V TN3127].
- **Observed prompt.** A new ad-hoc Aplos build already stopped at a Keychain prompt because "the new ad-hoc signature does not match the ACL" [V `PROGRESS.md:448`].
- **What a helper sees.** A helper with a different identifier or DR isn't on the item's ACL, so reading it **prompts** the user [I, consistent with the observation above].
- **The data protection keychain.** It uses keychain access groups taken from entitlements that "must be authorized by a provisioning profile". The program "needs an app-like bundle structure" to carry it [V TN3137:43].
  - It "is only available to programs running in a user context". A per-user LaunchAgent in the Aqua session qualifies; a system daemon doesn't [V TN3137:29-34].
  - Developer ID apps *can* hold such a profile. T3 Code does [V §1].
- **Fuse hardening.** Aplos sets no fuses. The schema default leaves `run_as_node`, `node_options` and `node_cli_inspect` on [V `electron/build/fuses/fuses.json5`; no fuse config in the repo].
  - Electron's fuse docs recommend turning RunAsNode off to prevent "living off the land" use of the signed binary [V `docs/tutorial/fuses.md:5-36`].
  - While it's on, any local process can start Aplos's signed binary as a Node interpreter and inherit its Keychain trust [I].
  - Aplos uses `utilityProcess.fork`, which the fuse doesn't affect. The fuse only breaks `child_process.fork` [V fuses.md:32-36].

**Plan for A1** [I]

1. Sign both bundles with Developer ID (main `com.aplos.mail`, helper `com.aplos.mail.engine`), each with a Developer ID provisioning profile granting `keychain-access-groups` = `TEAMID.com.aplos.mail.shared`.
2. The helper's native shim stores the 32-byte data key in the **data protection keychain** under that group. No ACL prompts, and the `security` command-line tool can't see it.
3. **Migration, run once on first start of the daemon.**
   - The UI, which can still open `safeStorage`, unwraps `engine-key.bin`.
   - It sends the key over the authenticated socket. The daemon stores it and acknowledges.
   - The UI then renames `engine-key.bin` to `.migrated`.
   - The credential files don't change, because they're sealed with the data key rather than with `safeStorage` [V `keyring.ts:7-10`].
4. **Fallback without a profile.** The daemon creates its *own* file-keychain item from inside its own process (N-API addon), so the default ACL trusts only the helper's DR.
   - This stays prompt-free across updates only if the DR is stable, which requires Developer ID.
5. Never install the key through `/usr/bin/security` or a standalone helper that prints it. The ACL would then trust a tool anyone can run [I].

## 4. Updates

- **Squirrel only waits for the main app.** It checks only processes with the *main* bundle ID [V §2(a)]. A nested helper with a different bundle ID is ignored, and ShipIt moves the bundle (or its `Contents`) away underneath it with `rename()` [V `SQRLInstaller.m:603-650`].
  - A running Node SEA keeps its mapped executable [I].
  - Its danger is a late `require()` of a file that has since been replaced. Bundle everything into the SEA [I].
  - An Electron helper would start mismatched helper processes from the new framework [I].
- **Update flow for A1** [I]:
  1. The UI tells the daemon to drain (flush the op queue and checkpoint the WAL).
  2. The daemon exits.
  3. The UI calls `quitAndInstall`.
  4. After the swap, launchd starts the new daemon.
- **Re-registration.** Apple's docs are silent [V].
  - Developers report that a changed plist doesn't take effect until you unregister and register again, and that registering immediately after unregistering fails with Code 1 unless delayed [V developer.apple.com/forums/thread/768592 (developer, not Apple)].
  - Ollama skips registration when the status is `enabled` [V `app_darwin.m:1612-1614`].
  - **Approach:** store a `launchd-plist-version` marker. Only when it changes: unregister, wait about 1 s, register.
- **Version skew.** On every connection, exchange `{apiVersion, appVersion, schemaVersion, capabilities}` [I].
  - **UI newer than daemon:** the UI asks the daemon to exit, and launchd restarts it from the new bundle.
  - **Daemon newer than UI:** the UI shows "restart Aplos".
  - **Phone clients:** use semver on `apiVersion` only.
- **Migrations.** Only the daemon opens `aplos.db`, behind a lock file. It runs migrations before it binds the socket, so clients see "starting" and not half-migrated data [I]. With A0 the `utilityProcess` already is that single owner.
- **Ad-hoc builds.** They are excluded today because Squirrel requires the same team [V `DECISIONS.md:32`]. The same rule should switch A1 off on ad-hoc builds.

## 5. Power and lifecycle

- **App Nap.** It applies to *apps* that aren't visible or doing user-initiated work. The opt-out is `NSProcessInfo beginActivityWithOptions:reason:` [V Apple Energy Efficiency Guide, `power_efficiency_guidelines_osx/AppNap.html`].
  - Electron has no API for it [V: no `beginActivity` in `electron/shell`].
  - `powerSaveBlocker('prevent-app-suspension')` creates `kIOPMAssertionTypeNoIdleSleep` [V `chromium-oscrypt/services_device_wake_lock_power_save_blocker_power_save_blocker_mac.cc:76-89`]. That stops the Mac from idle-sleeping, so it is **the wrong tool** for a mail engine.
  - `NSAppSleepDisabled` is reportedly ignored in Info.plist since macOS Sierra [U, Eclectic Light].
  - A Node daemon is not an app. Its throttling comes from launchd `ProcessType`. Leaving it unset applies "light resource limits"; `Interactive` applies none [V `man launchd.plist`]. Ollama sets `POSIXSpawnType Interactive` and LangAlpha sets `ProcessType Interactive` [V].
  - Start with the default and measure first-sync throughput [I].
- **Power Nap and DarkWake.** Apple lists only its own work: Mail, Calendar, iCloud, updates and Time Machine. The setting is "only available on Intel-based Mac computers" [V support.apple.com/guide/mac-help/mh40774]. Whether third-party agents get CPU or network time during DarkWake on Apple silicon is **[U]**; this Mac logged no DarkWakes to check.
  - Design for no work during sleep. Provider-side filters remain the only "while asleep" automation.
- **Suspend and resume.** Chromium's power monitor uses `IORegisterForSystemPower` [V `base_power_monitor_power_monitor_device_source_mac.mm:57,116`]. In Electron this is `powerMonitor`, main process only. Aplos doesn't use it today [V grep].
  - **A0:** forward `resume`/`unlock-screen` to `engine.wake()`.
  - **A1 Node daemon:** use the shim's `NSWorkspace` wake notification. As a fallback, a wall-clock jump of more than 30 s between 1 s ticks means a resume [I].
  - On resume: wait for the network, reconnect IDLE, then catch up through history and delta.
- **Notifications.** A process without a bundle can't use UserNotifications. A bare Swift binary calling `UNUserNotificationCenter.current()` aborts with "bundleProxyForCurrentProcess is nil" [V `proto/daemon/swift/un.swift`].
  - Electron's `Notification` uses `UNUserNotificationCenter` and is main-only [V `cocoa_notification.mm:38-250`].
  - An A1 helper bundle posts under its own bundle ID, so the user gets a second notification permission entry. Give it the same display name and icon [I].
- **Crash and restart.**
  - **launchd:** `KeepAlive` respawns the job, never more than once every `ThrottleInterval` (default 10 s). `KeepAlive {SuccessfulExit:false}` restarts only after failures [V `man launchd.plist`]. The man page sets no retry limit, so a crash loop goes on until something stops it [I].
  - **Aplos's guard:** more than 3 exits in 60 s shows a dialog [V `electron.ts:243-250`].
  - **A1 equivalent** [I]:
    - The daemon records its start times on disk.
    - After more than 3 starts in 60 s it enters a "parked" mode: no sync, diagnostics only.
    - Alternatively it exits 0, which stops `KeepAlive`, and the UI shows the error on its next connection.
    - Set `ExitTimeOut` long enough for a WAL checkpoint.
    - Set `AbandonProcessGroup` only if the daemon spawns children that should outlive it. LangAlpha sets it [V].

## 6. Precedents

| Project (license) | Background server | Registration | Updates |
|---|---|---|---|
| **Ollama.app** (MIT) [V `ollama/app/`] | Menu-bar app (`NSStatusItem`, accessory policy) starts `ollama serve` as a child process with a context, on `127.0.0.1:11434` | `SMAppService agentServiceWithPlistName:` for a trampoline copy of its own binary; `RunAtLoad`, `LimitLoadToSessionType Aqua`, no KeepAlive; removes the legacy `LSSharedFileList` login item | Own updater: stage the zip, then back up and swap the bundle at startup (`updater_darwin.go:99-163, 395`). The signing identifier `com.electron.ollama` is left over from its Electron era |
| **LM Studio** (app closed; `lms` CLI MIT) [V `lms/src/localAPIServer.ts:105-160`] | GUI app runs headless with `--run-as-service`; separate "llmster" headless distribution | CLI finds the server through `~/.lmstudio/.internal/http-server.json` (port file), otherwise spawns the recorded app path detached; "run server on login" [U, docs not fetched] | App updater [U] |
| **T3 Code** (MIT) [V `pingdotgg-t3code/apps/desktop/src/backend/`] | Electron main spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (RunAsNode left on); bootstrap secret on fd 3; binds `127.0.0.1`, LAN `0.0.0.0` and Tailscale Serve only on opt-in | None. Backend is a child process that dies with the app | electron-updater; Developer ID plus a provisioning profile with `keychain-access-groups` |
| **Docker Desktop** (proprietary) | Privileged helper `com.docker.vmnetd` "started by launchd", reached by the backend over `/var/run/com.docker.vmnetd.sock` [V docs mirror of docs.docker.com/desktop/setup/install/mac-permission-requirements]. Electron dashboard over a native backend [U] | Installed during setup with admin approval | Own updater [U] |
| **LangAlpha** (Apache-2.0) [V `LangAlpha/desktop/`] | **Electron app plus a separate helper binary as a LaunchAgent** (`KeepAlive`, `ProcessType Interactive`, `BundleProgram Contents/MacOS/langalpha-helper`) | `app.setLoginItemSettings({type:'agentService'})`; plist written at package time and added through `extraFiles`; custom signer | electron-updater; unsigned until a Developer ID exists |
| **electron-builder MAS login helper** (MIT) [V `electronMac.js:51-59`] | `<Product> Login Helper.app` in `Contents/Library/LoginItems` | `entitlementsLoginHelper` | Store |

LangAlpha comes closest to A1-c, since it runs a non-Electron agent inside an Electron app. It ships unsigned, so Squirrel can't update it (§4), and how a running agent behaves through a signed update is still unproven. A1's update choreography is new territory [I].

## 7. Transport between the UI and an out-of-process daemon

The table shows round-trip latency in ms from Electron main to a `utilityProcess` echo server, over 3,000 iterations [V `proto/daemon/bench/results.json`]:

| Transport | Small JSON p50 / p99 | 64 KB JSON p50 / p99 |
|---|---|---|
| `MessagePort` (today) | 0.033 / 0.067 | 0.11 / 0.21 |
| Unix socket, 0600, NDJSON | 0.016 / 0.069 | 0.30 / 0.59 (naive string framing) |
| Loopback HTTP keep-alive | 0.060 / 0.189 | 0.10 / 0.21 |

All three are far below a SQLite page query or a React render, so **choose on security and lifecycle, not speed** [I].

- **`MessagePort` / `MessageChannelMain`.** Only works between Electron and its own children, so it can't reach a launchd daemon. Keep it from renderer to main.
- **Main-process proxy over a Unix socket.** The socket is mode 0600 in a 0700 data directory, plus a token. Other macOS users are excluded by the file mode. The token stays out of the renderer, which matters while email HTML still renders there.
  - Keep the path under the 104-byte `sun_path` limit [I].
  - Optionally check the peer through `LOCAL_PEERPID` and a code-signature check in the shim [I].
- **Loopback HTTP or WebSocket from the renderer.** Needs a per-launch token in renderer memory, exact Host and Origin checks, and protection against DNS rebinding. Any local user can probe the port. Reserve it for the browser preview, CLI or MCP, and a phone through pairing (`SYNTH` §10).

---

## 8. Decision table

| | **A0: resident app + listener in `utilityProcess`** | **A1-a: same Electron binary windowless as agent** | **A1-b: separate Electron helper app** | **A1-c: Node SEA in nested `.app` + native shim** |
|---|---|---|---|---|
| **Verified steps** | Already stays alive with windows closed (`window-all-closed` quits only off macOS, `electron.ts`); `mainAppService` login item works today; `wasOpenedAtLogin` exists (`browser_mac.mm:389-391`); Unix socket and HTTP listeners run inside a `utilityProcess` (bench) | One API call registers it; LaunchServices check-in observed | API call; Electron path resolution read | API call (LangAlpha); `extraFiles` to `Contents`; osx-sign signs nested code; SEA `execArgvExtension:none`; engine is Electron-free |
| **Blockers** | None | Squirrel aborts while it runs; second instance; Dock and URL routing | 286 MB extra framework per architecture, or unverified symlinks | **Developer ID + notarization**; native shim; profile for the access group |
| **macOS version** | 13+ (Electron 44); fix the 12.0 plist | 13+ | 13+ | 13+ (`SMAppService`) |
| **Keychain** | Unchanged (`safeStorage` in main) | Same DR, so silent, but blocks updates | Helper DR differs, so it prompts unless an access group is used | Data protection keychain with a shared access group; one-time key handoff (§3) |
| **Updates** | Unchanged electron-updater | Broken by design | Mismatched framework after the swap | Drain → exit → `quitAndInstall` → launchd restart; plist-version marker; handshake |
| **Idle footprint** | ~53 MB phys_footprint with no window (4 processes) | ~38 MB + UI | ~38 MB + UI, +286 MB disk | **~17 MB** + UI only when open; +~100 MB disk per architecture [U] |

## 9. Recommended path and effort

**Now: A0, about 1.5-2 weeks, assuming F4's typed contract exists** [I, built from the verified steps]

1. Set `minimumSystemVersion` to 13.0 and flip fuses: RunAsNode, NodeOptions and NodeCliInspect off; asar integrity and OnlyLoadAppFromAsar on. Then confirm `utilityProcess` and `aplos-symbols` still work. **0.5-1 day.**
2. Resident mode. **2-3 days.**
   - Start without a window when `wasOpenedAtLogin` is set.
   - Add a menu-bar item showing sync state, with "Open", "Pause sync" and "Quit Aplos completely".
   - Switch to the accessory activation policy when no windows are open.
   - Keep ⌘Q as a full quit, like Mail.
3. Hook `powerMonitor` suspend/resume and unlock to `engine.wake`. **0.5 day.**
4. Engine listener: a 0600 Unix socket plus a token file for CLI and agents, with the versioned handshake. Main stays on `MessagePort`. **3-5 days.**
5. Make A1 cheap later. **1-2 days.**
   - Add a single-writer lock file on `aplos.db`.
   - Run migrations only in the engine.
   - Put the data-key handoff behind an interface.
   - Keep the engine free of Electron imports and enforce it with a lint rule.

**Later: A1-c, about 3.5-5 weeks after A0**, only after Developer ID is verified on a second Mac (`TODO.md:49`) and F2 has landed.

| Step | Estimate |
|---|---|
| SEA build per architecture, nested `Aplos Mail Engine.app` (`LSBackgroundOnly`), plist through `extraFiles`, sign and notarize | 4-6 days |
| Native shim (N-API or Swift): data-protection Keychain, notifications, sleep/wake, peer check | 6-8 days |
| Registration UI with status polling, approval deep link, plist-version re-registration, crash parking, fallback to the `utilityProcess` host when the agent is disabled | 4-5 days |
| Main-process Unix-socket proxy, reconnection, skew handshake, update drain choreography | 3-4 days |
| Key migration plus tests; second-Mac update and uninstall test | 3-4 days |

**Avoid** A1-a and A1-b. Also avoid any design where the daemon reads the existing `safeStorage` item from another binary.

## 10. Still unverified

- **Registration:** real `SMAppService` registration, approval UI and "Background Items Added" notice for an Aplos-signed build (nothing was registered here); agents in ad-hoc apps; whether a changed plist needs unregister plus register after an update (developer reports only); survival after the app is moved; the `x-apple.systempreferences` Login Items link.
- **Power:** App Nap on battery over 30 minutes or more, and for a `utilityProcess` under a hidden app; third-party CPU and network time during DarkWake on Apple silicon.
- **Runtime:** whether a Node SEA needs `allow-unsigned-executable-memory`; the unpacked Node binary size; `UNUserNotificationCenter` from a bundled helper that isn't an `NSApplication`.
- **Keychain:** a data protection keychain group shared by two Developer ID bundles with profiles (inferred from TN3137 and T3 Code, not tested).
- **LaunchServices:** whether it sends Dock clicks or `mailto:` to a same-bundle windowless instance.
- **Closed-source precedents:** LM Studio's run-on-login mechanism and Docker Desktop's backend socket layout.

## Sources

**Local, read-only:** `electron` v44.7.2; `Squirrel.Mac` `fffea30e`; `chromium-oscrypt/*` (Chromium 152.0.7977.149); `ollama`; `lms`; `pingdotgg-t3code`; `LangAlpha/desktop`; `apple-docs/*.txt` (DocC JSON: SMAppService, register, agent(plistName:), "Updating helper executables…", "Signing a daemon with a restricted entitlement", TN3137, TN3127); `node-files/` (Node v24.21.0 entitlements and SEA docs); `man launchd.plist`.

**Web:** [Electron PR #37244](https://github.com/electron/electron/pull/37244), [forums 768592](https://developer.apple.com/forums/thread/768592), [forums 745712](https://developer.apple.com/forums/thread/745712), [App Nap guide](https://developer.apple.com/library/content/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html), [Eclectic Light](https://eclecticlight.co/2023/01/16/app-nap-undead-and-nascent-apps-in-ventura/), [Power Nap](https://support.apple.com/en-ca/guide/mac-help/mh40774/mac), [Docker permissions (mirror)](https://docker.cadn.net.cn/manuals_en/desktop_setup_install_mac-permission-requirements), [LM Studio 0.3.5](https://alternativeto.net/news/2024/10/lm-studio-0-3-5-introduces-headless-mode-and-on-demand-model-loading).

**Licenses:** MIT (Electron, Squirrel.Mac, Ollama, `lms`, T3 Code); Apache-2.0 (LangAlpha); BSD-style (Chromium); proprietary (LM Studio app, Docker Desktop). No code was copied.
