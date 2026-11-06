# Real-engine screen sweep — packaged app

Source of truth: `apps/desktop/scripts/verify-hardening-sweep.mjs` (launches the packaged app
`APLOS_TEST=1` + `APLOS_ENGINE=real` on a seeded isolated copy of the signed-in spare account,
drives every screen over CDP, screenshots each, flags fatal/error/blank/refused-bridge states).

Run 2026-11-05 on `~/Applications-test/Aplos Mail (revamp).app` built from `93c21b85`
(flip #307 + Session/Settings stubs #308 + handshake #309). Evidence:
`~/.local/share/aplos-mail-review/sweep/93c21b85/` (sweep.json, sweep.md, shots/*.png).

## Table

| Screen | Result | Notes |
|---|---|---|
| Home | PASS | Do now 145 + featured card (Reply/Later/Done/⋯) render |
| Go one by one | PASS | Focused triage opens ("1 of 100"), verified by real click |
| Reader | PASS | Row expands inline to card (Reply Space/Later/Done), verified by real click |
| ⋯ menu | PASS | Opens: Bookmark (B), Why it's here (I), Move to Trash (#) — reader-menu-verified.png |
| Later | PASS | Renders; Bookmarks empty state |
| Calendar | FAIL | "Couldn't load this list" + Try again — owned: Engine 4 |
| Calendar week/month/agenda | FAIL | No view tabs render (Calendar never loads) — same root cause |
| All mail | PASS | Real mail list renders |
| Done | PASS | 4 items render |
| Drafts | PASS | "No drafts" empty state |
| Sent | PASS | Renders |
| Spam | PASS | "Spam is empty" |
| Trash | PASS | "Trash is empty" |
| Search | FAIL | Query "receipt" → "Couldn't load this list" + "Google asked us to slow down. Search again in a few minutes." — REQUEST filed to engine-4 (see below) |
| ⌘K palette | PASS | Go-to list + Suggested actions render |
| Ask dock | PASS | Opens with tabs Ask/Today; "Ask needs a provider. Choose one in Settings." + Open Settings → AI link (no AI key in seed) |
| Compose | PASS | "New message" To/Cc/Send ⌘↩ opens and closes |
| Settings | FAIL | Blank pane — sidebar only, zero content — owned: Engine 4 Settings/get stub |
| Help | PASS | "Help isn't in this build yet" placeholder — owned: Fix shell chrome |

## Caveats

- The seeded run shows "Google needs you to sign in again / Reconnect" throughout: the app's
  refresh token lives in the login keychain and test mode's mock keychain can't read it. Cached
  mail renders fine; live calls (search, calendar, sync) may fail for auth rather than for the
  bug they name. The search error text says "Google asked us to slow down" — possibly a
  mislabeled auth error; verify against the owner's real launch before treating it as a rate limit.
- Sidebar/nav clicks work via synthetic events; message rows and "Go one by one" only respond to
  real pointer events (the script uses `Input.dispatchMouseEvent`).
- Live sync/send not exercised here — use the guarded live runner for mail operations.

## New failures filed

- **Search**: REQUEST to Engine 4 (`eng-contract` methods / real-path). Repro: real-engine
  packaged app, Search → type "receipt" → Enter → "Couldn't load this list" + rate-limit copy.
  Evidence `~/.local/share/aplos-mail-review/sweep/93c21b85/shots/search.png`.

## Run 2 — 2026-11-05, revamp `6f1ad17c` (includes #319 shell-chrome batch)

App rebuilt to `~/Applications-test/Aplos Mail (revamp).app` (397 MB, verify-hardening
`--expect adhoc` 10/10). Evidence `~/.local/share/aplos-mail-review/sweep/6f1ad17c/`.

**#319 verified packaged:** new chrome renders — sidebar collapse toggle, compose button at top,
key-hint chips on the featured card ("Later ←", "Done →"), Ask chip top-right.

**Unchanged (engine PRs #313/#315/#317/#320 still open):** Calendar + views "Couldn't load this
list"; Search "Couldn't load this list" on query; Settings pane fully blank (the stub the
#320 fail-safe addresses); "Help isn't in this build yet" — and per #319 Help now routes through
Settings → Help & about, so with Settings blank the Help section is unreachable too.

**Script note:** the sweep's Settings nav enumeration now trips the new sidebar-collapse toggle
(and collapsed-sidebar clicks miss by design), so `settings-sections`/`help` rows show
click-miss flags that are sweep artifacts, not app bugs. A collapsed sidebar + blank pane is the
end state — the owner can recover by toggling the sidebar back.

## Run 3 — 2026-11-05, revamp `f8b7d2b4` (includes #319 + #320 + #317)

App rebuilt to `~/Applications-test/Aplos Mail (revamp).app` (406 MB, verify-hardening
`--expect adhoc` 10/10). Evidence `~/.local/share/aplos-mail-review/sweep/f8b7d2b4/`.

**#320 verified packaged — Settings is alive:** full section nav renders (General, Mail,
Calendar, AI, Notifications, Accounts, Keyboard, Help & about). General shows Appearance/
Theme/Density/Keys/Window sections; Calendar shows "Week starts on", "Add plans automatically",
"Events from Gmail". No blank pane. Help & about now reachable inside Settings per #319 routing.

**Search still FAILS in seeded mode** — same "Couldn't load this list" + "Google asked us to
slow down" copy post-#317. Expected if the dead seeded-token auth error is classified as a
throttle; #317's honest needsReauth/paused body may or may not be what renders here. The owner
should retry search on the real signed-in launch before counting this as open.

**Unchanged:** Calendar + views "Couldn't load this list" (engine #313/#315 still open).
Rows `settings-sections`/`help`/`reader-menu` show click-miss flags that are sweep artifacts
(enumeration trips the sidebar-minimize toggle; ⋯ verified working by real click earlier).

## Run 4 — 2026-11-05, revamp `e03bb50c` (#313, #315, #317, #321, #322, #324 and #327-#329 merged)

Fresh `npm ci` + `npm run package` build; `verify-hardening-real-engine.mjs` PASS (engine up, first
window, no `aplos:invoke` refusal). Sweep on a disposable copy of the seeded spare-account profile
(`APLOS_ENGINE=real`): **21 of 21 rows PASS, exit 0.**

- **Calendar loads** on the real engine (day, week, month); Settings renders all sections; Help is reachable.
- **Search** now reads "Google needs you to sign in again before it can search." (needsReauth, #322),
  not the throttle copy. It sits under a generic "Couldn't load this list." banner, so two error
  banners show at once: a small UI nit for the ui-screens lane.
- The seed's token is still dead, so mail bodies show "Couldn't load this email." and live calls
  cannot be judged here; the owner's real signed-in launch is the proof for those.
- Sweep script fixes (this PR): it opens a sidebar collapsed to the strip, clicks the reader's "More"
  button (was "⋯"), drops the Agenda view (the calendar switcher is Day/Week/Month), treats
  "Couldn't load" beside the Reconnect copy as the expected dead-token state, and skips the shell's own
  rows when it walks the Settings sections. A seed with "Sidebar minimised" on (a ☰ menu, no toggle)
  is not handled: un-minimise it in the seed first.

---

## Run 5 — real-path e2e on the windowed packaged app (via the APLOS_TEST window/CDP hook)

Driver: `apps/desktop/scripts/verify-hardening-e2e.mjs` — launches the packaged app with
`APLOS_TEST=1 APLOS_ENGINE=real APLOS_TEST_SHOW_WINDOWS=1 APLOS_TEST_CDP_PORT=<port>
APLOS_TEST_KEYCHAIN=login APLOS_DATA_DIR=<private copy>` and drives the shown window over
loopback CDP (real pointer/key events, screenshots every step). Requires the test-window
hook (PR #338). Seed = private copy of the signed-in spare-account data dir (cached mail
renders; the copied credential does not unwrap → Reconnect state, documented below).

Evidence: `~/.local/share/aplos-mail-review/e2e/final/` (43 screenshots + e2e.json).

| Area | Result | Notes |
|---|---|---|
| Boot → Home | PASS | Sidebar, list, Do now + featured card render |
| Triage keys E / → / L / Space | PASS | Done/Later move cards, Space opens |
| One by one | PASS | Triage view works; harness ordering nit (already in obo mode from Space) |
| Reader open | PASS | Letter opens inline; honest "Couldn't load this email. Try again" body state |
| Reader images / links / mailto / ⋯ | n/a-seed | Body fetch needs live token — owner to check on real launch |
| Attachment affordance | PASS | Save/open affordance present |
| All mailboxes (Later/Done/Drafts/Sent/Spam/Trash/All mail) | PASS | Correct lists + empty states |
| Search (query, open hit, clear) | PASS | Live query runs; results open |
| Ask + Today | PASS | Dock opens, Today panel renders |
| Calendar day/week/month + open event | PASS | Views render; an event opens (cached) |
| Settings all sections (General/Mail/Calendar/AI/Notifications/Accounts/Keyboard/Help & about) | PASS | Every section renders — Accounts shows Reconnect/Remove/Add account |
| Add account redirect | PASS | Recorded (test mode records the OAuth redirect, never opens a browser) |
| Compose open | PASS | Compose renders |
| Compose → send to spare itself | PASS | To/Subject/Body filled, ⌘↩ send accepted (dead auth queues — the flow itself works) |
| Draft save → Drafts | PASS | Draft persists |
| Sidebar toggle ⌘S | PASS | Collapses/restores |
| Account switcher | PASS | All accounts menu opens |
| Window drag / fullscreen | SKIP | Browser-domain bounds unavailable over page-level CDP headless |

**Seed-state caveat (not app bugs):** the private copy cannot unwrap the credential — the
account shows "Google needs you to sign in again. Reconnect" throughout. Letter bodies show
"Couldn't load this email. Try again" (correct fail-soft), and any live network step
(images/links/refresh) can't be verified on the copy. Live-account coverage for these stays
with the owner's launch + the guarded live runner.

**Finding:** the seeded-path screens are clean. Search now behaves (local index + honest
copy) — the earlier seeded Search failure is closed.
