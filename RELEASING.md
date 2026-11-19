# Releasing Aplos Mail

Pushing a version tag builds the macOS app on GitHub Actions and publishes it to a **draft** GitHub Release. The draft stays invisible to users and to the in-app updater until you publish it. Only macOS (Apple Silicon and Intel) is built for now.

What a release contains:

| File | What it is for |
|---|---|
| `Aplos-Mail-X.Y.Z-arm64.dmg`, `…-x64.dmg` | What people download and drag to Applications |
| `Aplos-Mail-X.Y.Z-arm64.zip`, `…-x64.zip` (+ `.blockmap`) | What the in-app updater downloads |
| `latest-mac.yml` | The update feed: version, file names, SHA-512 hashes |

## One-time setup

Without these secrets a local `npm run release:build` still works: it produces ad-hoc signed, un-notarized builds. (The *Release* workflow builds one too, but its hardening check expects a signed, notarized release, so the run ends red and nothing is uploaded.) macOS warns before opening those (right-click → Open, or System Settings → Privacy & Security → Open Anyway), and the in-app updater stays off in them, because macOS refuses to swap in an update for an app that has no Developer ID signature.

To sign and notarize, you need an Apple Developer Program membership (paid, individual is fine).

1. **Developer ID Application certificate.** On this Mac, open Xcode → Settings → Accounts → your team → Manage Certificates → **+** → *Developer ID Application*. (Or create it at developer.apple.com → Certificates, with a CSR from Keychain Access.) It must be *Developer ID Application*, not *Apple Development* or *Mac App Distribution*.
2. **Export it as .p12.** Keychain Access → login → My Certificates → right-click *Developer ID Application: Your Name (TEAMID)* → Export → `.p12`, with a strong password. Make sure the entry includes its private key (it has a disclosure triangle).
3. **Base64-encode it** for the secret: `base64 -i DeveloperID.p12 | pbcopy`. Then delete the `.p12` file, or keep it somewhere safe outside the repo.
4. **App-specific password.** appleid.apple.com → Sign-In and Security → App-Specific Passwords → generate one named "Aplos notarization".
5. **Team ID.** developer.apple.com → Account → Membership details (10 characters, also shown in the certificate name).
6. **Add the repository secrets.** github.com/notkainoa/aplos-mail → Settings → Secrets and variables → Actions → *New repository secret*:

| Secret | Value |
|---|---|
| `CSC_LINK` | The base64 text from step 3 |
| `CSC_KEY_PASSWORD` | The .p12 password from step 2 |
| `APPLE_ID` | Your Apple Account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | The password from step 4 |
| `APPLE_TEAM_ID` | The Team ID from step 5 |
| `GOOGLE_CLIENT_ID` | Aplos's Google **Desktop app** OAuth client ID (Google Cloud → APIs & Services → Credentials) |
| `GOOGLE_CLIENT_SECRET` | That client's secret |
| `MICROSOFT_CLIENT_ID` | Optional. Aplos's Microsoft Entra app (client) ID; leave unset until Outlook sign-in should ship |

`CSC_LINK` + `CSC_KEY_PASSWORD` turn on signing; the three `APPLE_*` secrets additionally turn on notarization. If only some `APPLE_*` secrets are set, the build fails rather than shipping a half-configured release. `GITHUB_TOKEN` is provided by Actions; the workflow asks for `contents: write` so it can create the draft release.

**OAuth clients are built into release builds**, so someone who downloads the DMG can click Continue with Google without any setup. `npm run release:build` and `release:publish` set `APLOS_RELEASE_BUILD=1`, and `scripts/build-main.mjs` then inlines `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_ID` from the build environment into `dist/main/engine.cjs` (inside the asar) with esbuild `define`. They are never written to a file in the repo and never logged. Google treats a Desktop app client secret as non-confidential, so shipping it is the normal setup for installed apps (see DECISIONS.md).

- On CI (`CI` set), a release build without `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` **fails** so a release that cannot sign in never ships. Set `APLOS_ALLOW_NO_GOOGLE=1` for an intentionally unconfigured build. A local `npm run release:build` only warns.
- `MICROSOFT_CLIENT_ID` may be missing; Outlook then shows "Outlook sign-in isn't available in this build."
- A release build (`APLOS_RELEASE_BUILD=1`) signs in with the built-in client only: `GOOGLE_*`, `APLOS_GOOGLE_*`, `MICROSOFT_*` and `APLOS_GOOGLE_TESTING_MODE` in the environment or in `~/.config/aplos-mail/.env` are ignored (`oauthEnv` in `src/main/oauth-config.ts`). To try another client, use a development or `npm run package` build, where those variables still win. AI keys in that `.env` are still read.
- `npm run build`, `npm run package` and CI's `npm run build` never read these variables; their apps use `.env` only and show the unavailable state (with a developer hint) when it has none.

## Cutting a release

From an up-to-date, clean `main`:

```sh
npm run release -- patch      # or minor, major, or an exact version like 0.2.0
```

This bumps the version in `package.json`, `apps/desktop/package.json` and `package-lock.json`, commits "Release vX.Y.Z", creates the tag `vX.Y.Z` and prints the push command. It never pushes. Add `--dry-run` to see the new version without changing anything. Then push the commit and tag together:

```sh
git push --atomic origin main vX.Y.Z
```

The *Release* workflow checks that the tag matches the app version, runs the typecheck and tests, builds both architectures, signs and notarizes when the secrets exist, runs the hardening check and, only if it passes, uploads everything to a draft release named after the version. Without the signing secrets the run ends red at the check and uploads nothing. The same files are kept as a workflow artifact.

To build the artifacts locally instead (no upload): `npm run release:build`. Output goes to `apps/desktop/release/`. Locally the build signs only when `CSC_LINK` or `CSC_NAME` is set in your shell; a certificate in your keychain is never picked up by accident. `npm run package` stays the fast, this-Mac-only `.app` build; it is always ad-hoc signed (never with a keychain identity) and uses `build/entitlements.adhoc.plist`, as does an unsigned `release:build`. Developer ID builds use `build/entitlements.mac.plist`.

### Hardening check

Every build carries the Electron fuses in `build.electronFuses` (no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`, asar integrity on, the app only loads from `app.asar`) and requires macOS 13. `scripts/verify-hardening.mjs` checks a built `.app` for these, plus the signature, Gatekeeper, stapling, entitlements, the Developer ID designated requirement and secrets in the bundle:

```sh
npm run verify:hardening -- "apps/desktop/release/mac-arm64/Aplos Mail.app" --expect adhoc    # npm run package
npm run verify:hardening -- "apps/desktop/release/mac-arm64/Aplos Mail.app" --expect release  # signed and notarized
```

`release:build` runs it on every `.app` it built (`--expect release` when signed, `adhoc` otherwise; `-- --expect release` forces it) and exits 1 on any FAIL. A release expectation also runs `--launch-checks=guard`: the app is started with `--remote-debugging-port=0`, `-remote-debugging-port=0` and `--inspect=0` and must exit at once with code 78 (the debug guard below), before any window opens.

Nothing is uploaded before the check passes. electron-builder always builds with `--publish never`; `release:publish` uploads the DMGs, ZIPs, blockmaps and `latest-mac.yml` only after every row passed. The *Release* workflow builds with `--expect release` (so a run without the signing secrets ends red), verifies both apps again in its own step, and only then runs the upload step, which verifies both apps as a release once more and is the only step whose environment has `GH_TOKEN`. The checkout does not keep the job's token in `.git/config` (`persist-credentials: false`), so the build and verification steps, which run npm scripts, electron-builder and the app, never hold a GitHub token. A red run leaves no new files on the draft. `release:publish` refuses before building without a Developer ID certificate (`CSC_LINK` or `CSC_NAME`) and with `--expect adhoc`, so an ad-hoc build is never uploaded, locally either.

**Debug guard (ADR 40-6).** A release build (one built with `APLOS_RELEASE_BUILD=1`, which `release:build`, `release:publish` and the *Release* workflow always set) refuses to start with `--remote-debugging-*`, `--inspect*`, `--debug`, `--debug-brk` or `--debug-port` (one or two leading dashes, or as Chromium parsed them) and exits with code 78, printing the switch name but never its value; `src/main/security.ts` does this while the main process loads, before the single-instance lock and before the app is ready. It is keyed on the build-time define, not on `app.isPackaged`. `npm run desktop` / `electron .` and `npm run package` builds have no release define and keep debugging, so `scripts/verify-release.mjs` (which drives the app over `--remote-debugging-port`) runs against `npm run package` as before. `release-build.mjs` refuses to package a `dist/main` bundle built without the define.

The app icon is the Icon Composer file `apps/desktop/assets/AppIcon.icon`; electron-builder compiles it with Xcode's `actool` into `Assets.car` (the macOS 26 icon) plus `icon.icns` for older systems. That needs full Xcode 26 or later, not just the Command Line Tools: run `sudo xcode-select -s /Applications/Xcode.app` once, or prefix the build with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. The release workflow runs on `macos-26` for the same reason.

The DMG window (800×360, "To install, drag Aplos Mail to Applications") is drawn by `apps/desktop/build/dmg-background.html`. After editing it, run `npm run dmg-background -w apps/desktop` to re-render `build/background.png` and `background@2x.png`, and commit both. Icon positions and size are `build.dmg` in `apps/desktop/package.json`.

## Checking the draft

On github.com → Releases → the draft:

- Six assets plus blockmaps: two DMGs, two ZIPs and `latest-mac.yml`. The version in `latest-mac.yml` matches the tag.
- The workflow log says "signing and notarizing" and "notarization successful". If it says "ad-hoc signed and not notarized", the secrets are missing.
- The "Verify hardening" step is green and every row of both tables says PASS (the launch rows other than the three debug-guard ones say SKIP), and the upload step ran.
- Download the DMG for your Mac on a machine that has never run Aplos (or after `xattr` is reset by downloading through a browser), open it and launch the app. A notarized build opens with only the usual "downloaded from the internet" prompt. `spctl -a -vv "/Applications/Aplos Mail.app"` should say `accepted, source=Notarized Developer ID`.
- Settings → General → Updates shows the new version.
- Write release notes, then **Publish release**.

## How the updater picks it up

The app checks `https://github.com/notkainoa/aplos-mail/releases/latest/download/latest-mac.yml` a minute after launch and every 6 hours (Aplos Mail → Check for Updates… or Settings → General → Check now do it on demand). Drafts and pre-releases are ignored, so nothing reaches users until you publish. When a newer version exists, the matching ZIP downloads in the background; then a notice says "Aplos X.Y.Z is ready" with **Restart** and **Later**. Nothing installs until the owner clicks Restart (Later hides the notice until the next manual check or launch; the download stays cached).

Updates are off, with the reason shown in Settings and logged, when the app is:

- a development or browser-preview build;
- running from the mounted DMG or a translocated location (move it to Applications);
- not signed with a Developer ID (all builds until the certificate secrets exist), because macOS's updater (Squirrel.Mac) verifies that the new app is signed by the same team as the running one.

So the first signed release has to be installed by hand once; updates work from then on. An ad-hoc build will never update itself.

## Trying the updater locally

```sh
npm run release:build                 # makes apps/desktop/release/Aplos-Mail-<version>-<arch>.zip
npm run update-feed -- --version 0.2.0 # serves latest-mac.yml + that ZIP on 127.0.0.1:4329
APLOS_UPDATE_DEV=1 npm run desktop    # in another terminal; uses apps/desktop/dev-app-update.yml
```

Then Aplos Mail → Check for Updates…. A development run is not signed, so the check and download can be exercised but Squirrel.Mac refuses the final install step. The unit tests in `apps/desktop/tests/updates.test.ts` cover the state machine with a fake updater.
