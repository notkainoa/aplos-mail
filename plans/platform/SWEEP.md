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
