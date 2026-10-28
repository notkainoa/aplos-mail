# Aplos Mail X.Y.Z

Copy this into the draft release and fill in the parts in angle brackets. Delete this line and any section that does not apply.

## What changed

- <One short line per change that a person using the app would notice.>

## Install

1. Download the DMG for your Mac. Choose `arm64` for Apple silicon (M1 and later) or `x64` for an Intel Mac. To check, open the Apple menu and choose About This Mac.
2. Open the DMG.
3. Drag Aplos Mail onto the Applications folder in the window.
4. Eject the DMG, then open Aplos Mail from Applications.

Do not run the app from inside the DMG. It cannot update itself from there.

## First open

This build is signed with the developer's Apple Developer ID and notarized by Apple. The first time you open it, macOS shows the standard prompt that the app was downloaded from the internet. Choose Open. You should see no other warning.

If macOS says the app is damaged or cannot be checked, stop. Delete it, download the DMG again, and tell the owner. Do not bypass the warning.

## Checksums

Check your download before you open it. In Terminal, run `shasum -a 256 <file>` and compare the result with this table.

| File | SHA-256 |
|---|---|
| `Aplos-Mail-X.Y.Z-arm64.dmg` | <sha256> |
| `Aplos-Mail-X.Y.Z-x64.dmg` | <sha256> |

## Accounts in this build

- Gmail and Google Calendar are the only accounts that work.
- Gmail sign-in works only for people the owner has listed as test users. If you are not on the list, Google will refuse the sign-in. Ask the owner to add you.
- Google asks test users to reconnect every 7 days. When it does, sign in to that account again in Aplos.
- Outlook, iCloud, Fastmail and other IMAP accounts are not available in this build.

## Privacy

What Aplos stores, and what it sends where, is explained at https://aplos.email/privacy/.

## If updates fail

While this repository is private, an installed copy cannot reach the update feed. Settings > Updates shows "Couldn’t check" with a short error, and Check for Updates in the Aplos Mail menu shows the same error in a dialog. This is expected and nothing is broken.

To get a new build, download the new DMG from the release page and install it the same way as above. Drag the new app onto Applications and choose Replace.

If you cannot open the release page, ask the owner to send you the DMG.

## Known problems

- <List anything the owner knows is broken, or write "None known".>
