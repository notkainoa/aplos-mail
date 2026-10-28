# Clean-Mac install and update check

Run by the owner on a Mac that has never run Aplos Mail (plan 40 Q0, deliverable 6). Agents connect to that Mac over SSH only if the owner asks them to.

You need two signed, notarized draft builds in this repository, for example `v0.3.0-beta.1` and `v0.3.0-beta.2`, and about 20 minutes.

1. Download beta.1's DMG from the draft release: `gh release download v0.3.0-beta.1 --repo notkainoa/aplos-mail --pattern '*arm64.dmg'` (use `*x64.dmg` on an Intel Mac).
2. Check the file: `shasum -a 256 Aplos-Mail-*.dmg` must match the checksum in the release notes.
3. Open the DMG and drag Aplos Mail to Applications.
4. Open Aplos Mail from Applications. The only prompt allowed is macOS's standard "downloaded from the internet" question. Any warning about an unidentified developer or a damaged app is a failure.
5. In Terminal: `spctl -a -vv "/Applications/Aplos Mail.app"`. It must say `accepted`, `source=Notarized Developer ID` and name team VW9NDM428H.
6. Connect no account. Open About and check it shows beta.1's version.
7. Serve beta.2 from the local signed feed, using the local feed command in RELEASING.md.
8. In Aplos Mail, choose Check for Updates. It must download beta.2 and install it in place when you restart.
9. After the restart, About shows beta.2, your settings are still there, and macOS shows no Keychain prompt.
10. Write down the results: pass or fail for each step, with the macOS version and the Mac's chip. Don't take screenshots that show personal data.

If any step fails, stop there and post what you saw. The release does not go further until the step passes.
