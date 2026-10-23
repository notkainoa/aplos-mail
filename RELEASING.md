# Releasing Aplos Mail

Pushing a version tag builds the macOS app on GitHub Actions and publishes it to a **draft** GitHub Release. The draft stays invisible to users and to the in-app updater until you publish it. Only macOS (Apple Silicon and Intel) is built for now.

What a release contains:

| File | What it is for |
|---|---|
| `Aplos-Mail-X.Y.Z-arm64.dmg`, `…-x64.dmg` | What people download and drag to Applications |
| `Aplos-Mail-X.Y.Z-arm64.zip`, `…-x64.zip` (+ `.blockmap`) | What the in-app updater downloads |
| `latest-mac.yml` | The update feed: version, file names, SHA-512 hashes |

## One-time setup

Without these secrets the pipeline still works: it produces ad-hoc signed, un-notarized builds. macOS warns before opening those (right-click → Open, or System Settings → Privacy & Security → Open Anyway), and the in-app updater stays off in them, because macOS refuses to swap in an update for an app that has no Developer ID signature.

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

`CSC_LINK` + `CSC_KEY_PASSWORD` turn on signing; the three `APPLE_*` secrets additionally turn on notarization. If only some `APPLE_*` secrets are set, the build fails rather than shipping a half-configured release. `GITHUB_TOKEN` is provided by Actions; the workflow asks for `contents: write` so it can create the draft release.

No Google or Microsoft secrets are needed at build time: the app reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_ID` at runtime (a packaged app reads `~/.config/aplos-mail/.env`). Where those live for a public release is still an open decision (see DECISIONS.md).

## Cutting a release

From an up-to-date, clean `main`:

```sh
npm run release -- patch      # or minor, major, or an exact version like 0.2.0
```

This bumps the version in `package.json`, `apps/desktop/package.json` and `package-lock.json`, commits "Release vX.Y.Z", creates the tag `vX.Y.Z` and prints the push command. It never pushes. Add `--dry-run` to see the new version without changing anything. Then push the commit and tag together:

```sh
git push --atomic origin main vX.Y.Z
```

The *Release* workflow checks that the tag matches the app version, runs the typecheck and tests, builds both architectures, signs and notarizes when the secrets exist, and uploads everything to a draft release named after the version. The same files are kept as a workflow artifact.

To build the artifacts locally instead (no upload): `npm run release:build`. Output goes to `apps/desktop/release/`. Locally the build signs only when `CSC_LINK` or `CSC_NAME` is set in your shell; a certificate in your keychain is never picked up by accident. `npm run package` stays the fast, unsigned, this-Mac-only `.app` build.

## Checking the draft

On github.com → Releases → the draft:

- Six assets plus blockmaps: two DMGs, two ZIPs and `latest-mac.yml`. The version in `latest-mac.yml` matches the tag.
- The workflow log says "signing and notarizing" and "notarization successful". If it says "ad-hoc signed and not notarized", the secrets are missing.
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
