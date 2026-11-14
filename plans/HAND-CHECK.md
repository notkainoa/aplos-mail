# Hand-check: the packaged app in 10 minutes

The app to check (built 2026-11-14 from `revamp` `0816151`, includes the go-live flip and every
earlier fix batch plus: calendar accounts UI + "No calendars" vs "Syncing…" #356/#364/#365, the
real AI path #369–#383 — Ask with citations, background summaries, follow-up nudges, the consent
card, Settings → AI provider setup — the one-by-one card #421/#426/#451, Home low-importance lanes
#387–#402, calendar writes + Enable editing #393/#394/#410/#417, Settings Diagnostics/Export/Tools
#416–#439, recipient suggestions #395, theme/menu/show-full fixes #448–#458, calendar holds with
Retry/Discard in the Queue inspector #437/#478–#481, Event/plan extraction #404, and the
legacy-renderer banner #477, and Escape-returns-to-your-spot #482, and the mail-bodies fix #486/#488):

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

  **Check the renderer before anything else.** The new renderer is what every item below is about,
  and it only boots with `APLOS_ENGINE=real` until the go-live word makes it the default. A build
  that starts without the engine bridge silently falls back to the LEGACY renderer — every check
  after that is measuring the old app, not this build. The unmistakable tell is on Home: the new
  renderer's one-by-one entry is **"Go one by one" (S)**; if Home shows **"Swipe through them"** you
  are on the legacy renderer — quit and relaunch with `APLOS_ENGINE=real`. (In dark mode the legacy
  app also draws a white left rail with invisible labels; that is a legacy artefact, not a bug to
  report.)

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
- [ ] Open the Ask dock and ask something trivial.
  Expected: real AI is wired now. If you haven't granted the consent card yet, it asks first —
  approve it. Ask then answers with citations (links back to the letters it used). If a feature
  says "isn't ready — add a key or pick another provider", that's the honest missing-key state:
  Settings → AI → Add key under Groq fixes it.
- [ ] Today shows the day's agenda; Calendar shows day/week/month.
  Expected (updated 2026-11-06, #345+#346 merged): real Google Calendar read-sync is wired, but it
  needs a one-time re-consent first. Your current grant holds mail scopes only, so:
  1. Settings → Calendar shows an "Aplos needs permission to use your Google Calendar" row with a
     Reconnect (grant) button. Click it.
  2. Google's consent asks read-only scopes — calendar list + events read (consent text
     "See the events on your calendars"). If the consent screen (Testing mode) lists scopes,
     make sure `calendar.events.readonly` is among them before approving.
  3. After consent the calendar list syncs first, then the primary calendar's events page in
     (250 per step), then the other calendars every 15–30 min. The grid fills in as pages commit.
  Until the re-consent, an empty grid with that permission row is correct; "Couldn't load this
  list" or an error banner is not. RSVP needs a synced event you can respond to — out of this check.
- [ ] Settings opens; Settings → AI lists all nine providers with per-feature pickers (Ask,
  Summaries, Drafts, Plans, Voice). Your GROQ_API_KEY in `~/.config/aplos-mail/.env` is already
  picked up on a normal launch — Groq should read as ready without pasting anything; pasting a
  key in Settings overrides it. The "Summarise in the background" consent card lives here too.
- [ ] The account switcher works.

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

## 8b. Low importance and Home sorting (3 min, after the build with #387, #388, #407, #413, #389)

(Wording from ui-home; it never opens your real mailbox, so this check is yours.)

1. Open the app and let it sync for a few minutes. The re-sort of mail you already have runs 100 threads per sync round, newest first, so the top of Home fixes first.
2. Home should show Do now with real to-dos and Important updates, and a Low importance line under them that lists a few senders and a count. Click it, or press J until it is highlighted and Return: the by-sender sheet opens (→ twice marks all done).
3. Mail you wrote yourself that nobody answered must not be in Do now.
4. Anything you moved by hand or set a rule for stays where you put it.
5. If step 2 still shows nothing after a few syncs, tell the Integrator the Low count on Home and whether Settings shows the account still importing.

## 9. Weekly reconnect note

- The test sign-in grant lapses about every 7 days (current grant expires **2026-11-10**). If the
  app ever shows "reconnect", doing the sign-in dance again should restore everything without
  resyncing from zero.

---

## Known gaps today (agent run, 2026-11-10, build at 825ee2a0)

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
- AI was verified with NO provider key: Settings → AI lists all nine providers with honest
  "isn't ready — add a key" per-feature copy, the consent/privacy section renders, and Ask
  refuses politely with zero network calls. A real paid-key Ask round-trip, citations, and the
  background summaries queue have no automated check — you're the first live run.
- `APLOS_TEST_KEYCHAIN=login` caveat for future agent runs only (not you): a keychain item
  created by an older build makes the ACL prompt appear and the windowless app then hangs on it;
  test runs now leave it off.
- The guarded runner's send-to-self probe is once a day and the owner has skipped the live send
  gate; the draft probe leaves one `aplos-live-probe` draft in the test account's Drafts —
  discard it by hand when you're next in there.
- `scripts/verify-release.mjs` passed all 13 checks on this build line; under heavy load it once
  exceeded the old 30 s quit cap — the wait is now 60 s with a SIGKILL floor, and a stop failure
  no longer hides the real error.
- No GitHub CI (owner decision): `scripts/local-ci.sh <ref>` is the replacement and runs daily on
  revamp — last run all green.
