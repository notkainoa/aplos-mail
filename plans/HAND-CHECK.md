# Hand-check: the packaged app in 10 minutes

Run this on the app built by `npm run package` (from the repo root). The app lands at
`apps/desktop/release/mac-arm64/Aplos Mail.app`. It is ad-hoc signed for this Mac only — it opens
without any warning because it was never downloaded or notarized. If macOS still refuses, right-click
the app and choose Open.

Everything below is a quick look, not a test suite. Tick what behaves; write down anything that
doesn't and where it stopped.

## 1. Install and launch (1 min)

- [ ] Drag `Aplos Mail.app` to `/Applications` (or run it in place) and open it.
  Expected: the icon appears, the app starts, and the welcome screen shows. No crash, no
  "damaged app" dialog.

## 2. Sign in (1 min)

- [ ] Choose the Google sign-in on the welcome screen.
  Expected: a browser window opens for Google's consent, you approve, and the app comes back
  signed in. If it says "Google sign-in isn't available", the build has no OAuth client configured —
  that's a setup gap, not a bug (developers fix it with `.env`; a real release has it built in).

## 3. First sync (1 min)

- [ ] Let the first sync finish.
  Expected: a progress state, then your Inbox fills with real mail. Newest on top, no duplicates,
  unread marks match Gmail.

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

## 5. Attachment (1 min)

- [ ] Open a letter with an attachment and download/open it.
  Expected: it opens in the right app (or saves) with the right name — no empty or 0-byte file.

## 6. Search (1 min)

- [ ] Search a word you know is in a real subject, then a word from a body.
  Expected: the right letters come back; no spinner that never ends.

## 7. Compose and send to yourself (2 min)

- [ ] Compose a message to your own address and send it.
  Expected: the "undo send" affordance shows for the configured window; the message then sends and
  lands in your Inbox and Sent. Undo during the window cancels it cleanly (no half-sent copy).
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

- The test sign-in grant lapses about every 7 days. If the app ever shows "reconnect", doing the
  sign-in dance again should restore everything without resyncing from zero.

## 10. Real-engine run (only when asked; `APLOS_ENGINE=real`)

- The real engine is opt-in today: launch the packaged app from a terminal with
  `APLOS_ENGINE=real` in its environment only if you want the new engine.
  Today's state: most screens still say "This screen is not on the new engine yet" — expected,
  that flag is for after the remaining gates land.
- With it on: a `j`/`k` press in a letter should still act exactly once, the letter still renders in
  its own process (Activity Monitor shows a separate renderer for it), and the link rules in step 4
  hold.

---

## Known gaps today (agent run, 2026-11-04)

- Packaging works: `npm run package` produced `release/mac-arm64/Aplos Mail.app` (397 MB, ad-hoc
  signed, all hardening checks pass). One caveat seen here: on a fresh `npm ci`, Electron's binary
  may not download on its own — `node node_modules/electron/install.js` once fixes it.
- `APLOS_ENGINE=real` boots and its engine is alive in the packaged app, but the screens aren't
  ported: renderer calls answer "This screen is not on the new engine yet". Expected for now — the
  remaining gates are the reader key wiring and this hand-check.
- Live-account coverage today is API-level only (the guarded runner): sign-in reuse, first-sync
  shape, header parsing and the draft probe all PASS. Search results, archive/undo and the on-screen
  first-sync UI have no automated live check yet — this list is the check.
- The guarded runner's send-to-self probe runs once a day and already ran today; the draft probe
  leaves one `aplos-live-probe` draft in the test account's Drafts — discard it by hand when you're
  next in there.
- `scripts/verify-release.mjs` passed all 13 checks on this build; on a heavily loaded Mac it once
  timed out waiting for the app to exit after SIGTERM (the app does quit cleanly in ~1–2 s alone).
