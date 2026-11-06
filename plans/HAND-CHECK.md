# Hand-check: the packaged app in 10 minutes

The app to check (built 2026-11-06 from `revamp` `eed51934`, includes the go-live flip, the
Session/Settings engine stubs, the close-handshake fix, and every hand-check fix batch:
chrome #318/#319, Settings resilience #320, first-sync window + progress #316, OAuth return
#321/#329, Calendar/Event reads #315/#330/#332, Search auth/coalescing #317/#322/#324,
Settings data sources #313):

`~/Applications-test/Aplos Mail (revamp).app`

Verified before this list: the real-engine packaged sweep is 21/21 PASS — every screen renders,
Calendar loads, Settings shows all sections, Search gives the honest sign-in copy on a dead
token, no `aplos:invoke` refusals (full table lands in `plans/platform/SWEEP.md` with PR #333;
earlier runs are already there).

It is ad-hoc signed for this Mac — double-click to open; if macOS refuses, right-click → Open.
It was never downloaded, so no quarantine warning is expected.

**Two ways to launch:**

- **Demo engine (default):** just open the app. It starts on the bundled demo mailbox — good for a
  look at every screen without touching a real account.
- **Real engine (the go-live path):** from a terminal run
  `APLOS_ENGINE=real "$HOME/Applications-test/Aplos Mail (revamp).app/Contents/MacOS/Aplos Mail"`
  This starts the new engine. Most screens now connect through the real bridge (Ask, Calendar,
  Settings, onboarding are merged); a few older calls still answer "This screen is not on the new
  engine yet" — that's the last-mile gap being closed, not a new bug. Google sign-in in this build
  reads `~/.config/aplos-mail/.env` (already present on this Mac).

Everything below is a quick look, not a test suite. Tick what behaves; write down anything that
doesn't and where it stopped.

## 1. Install and launch (1 min)

- [ ] Open `Aplos Mail (revamp).app` from `~/Applications-test`.
  Expected: the icon appears, the app starts, and the welcome screen shows. No crash, no
  "damaged app" dialog.

## 2. Sign in (1 min)

- [ ] Choose the Google sign-in on the welcome screen and use the spare test account.
  Expected: a browser window opens for Google's consent, you approve, and the app comes back
  signed in. If it says "Google sign-in isn't available", the OAuth client env is missing —
  a setup gap, not a bug.

## 3. First sync (1 min)

- [ ] Let the first sync finish.
  Expected: a progress state, then the Inbox fills with real mail. Newest on top, no duplicates,
  unread marks match Gmail. (First sync's "Open Settings" button should land on Settings → AI.)

## 4. Read a message (1 min)

- [ ] Open a letter that has remote images.
  Expected: text renders, remote images are BLOCKED by default, and the per-letter "load images"
  choice shows them on demand. (Global allow lives in Settings → Mail.)
- [ ] While in a letter, press `j` then `k`.
  Expected: one step per press (next / previous letter). If one press jumps two letters, that's a
  known class of bug — note it.
- [ ] Click a `mailto:` link and a normal `https` link inside a letter.
  Expected: mailto opens Compose in Aplos; https opens your default browser. Anything else does
  nothing.
- [ ] Real-engine run only: open Activity Monitor and confirm the letter renders in its own
  renderer process (the sealed frame).

## 5. Attachment (1 min)

- [ ] Open a letter with an attachment; save it, then open it.
  Expected: it opens in the right app with the right name — no empty or 0-byte file. Saved files
  should carry the usual "downloaded from the internet" quarantine marking (new this build).

## 6. Search, Ask, Today, Calendar, Settings (2 min)

- [ ] Search (⌘K or the Search screen) for a word in a real subject.
  Expected: the right letters come back; no spinner that never ends.
- [ ] Open the Ask dock and ask something trivial (or just look at the consent gate).
- [ ] Today shows the day's agenda; Calendar shows day/week/month.
  Expected (2026-11-05, eng-views NOTICE): the grid opens and is EMPTY — Google Calendar sync is not wired yet
  (no adapter syncer; the OAuth connect flow keeps calendar scopes off until it lands, so the account's grant has
  none). An empty grid is correct; an error banner is not. RSVP needs a synced event, so it is out of this check.
- [ ] Settings opens; the AI section lets you pick providers/models; the account switcher works.

## 7. Compose and send to yourself (2 min)

- [ ] Compose a message to the spare account's own address and send it.
  Expected: the "undo send" affordance shows for the configured window; the message then sends and
  lands in Inbox and Sent. Undo during the window cancels it cleanly (no half-sent copy).
- [ ] Save a draft, close the window, reopen Drafts.
  Expected: the draft is there with your text, and it also exists in Gmail's Drafts.

## 8. Quit and relaunch (1 min)

- [ ] Quit with ⌘Q, then relaunch.
  Expected: it comes back signed in (no OAuth dance again), mail is still there, and anything
  pending is remembered — not silently lost.
- [ ] Quit while a send is still in its undo window.
  Expected: a clear warning that a send is pending, with a real choice. If it just quits and loses
  the send, that's a bug — note it.

## 9. Weekly reconnect note

- The test sign-in grant lapses about every 7 days (current grant expires **2026-11-10**). If the
  app ever shows "reconnect", doing the sign-in dance again should restore everything without
  resyncing from zero.

---

## Known gaps today (agent run, 2026-11-06, build at eed51934)

- Everything your last pass flagged is merged and re-verified packaged: Settings renders all
  sections (Help now lives in Settings → Help & about), Calendar loads its day/week/month
  views, the chrome nits are fixed (sidebar collapse, compose button, key hints, Tab roving),
  first-sync shows real progress, and Search on a dead/expired sign-in says "sign in again
  before it can search" instead of a fake rate-limit error. The 21-screen packaged sweep is
  21/21 PASS — full table lands in `plans/platform/SWEEP.md` with PR #333.
- Live-account coverage is API-level only (the guarded runner): sign-in reuse, first-sync
  shape, header parsing and the draft probe all PASS. Search results, archive/undo and the
  on-screen first-sync UI have no automated live check — this list is the check.
- Small UI nit already sent to the UI lane: with an expired sign-in, Search shows two stacked
  banners ("Couldn't load this list." plus the sign-in message).
- The guarded runner's send-to-self probe is once a day and the owner has skipped the live send
  gate; the draft probe leaves one `aplos-live-probe` draft in the test account's Drafts —
  discard it by hand when you're next in there.
- `scripts/verify-release.mjs` passed all 13 checks on this build line; under heavy load it once
  exceeded the old 30 s quit cap — the wait is now 60 s with a SIGKILL floor, and a stop failure
  no longer hides the real error.
- No GitHub CI (owner decision): `scripts/local-ci.sh <ref>` is the replacement and runs daily on
  revamp — last run all green.
