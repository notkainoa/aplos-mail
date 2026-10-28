# UI-screens Phase 0 map: `ui-calendar`

Lane `ui-calendar` (`renderer/screens/calendar/**`, days 6-12; plan 30 U7, roadmap §2 table). Written 2026-10-27 (day 1) against the PLANNED contract. Nothing in `packages/contract` exists yet.

## Scope

Covers the Calendar route: week (default, overlap, the Month variant at `?view=month`), day (default, empty), event detail and RSVP (`calendar-event.html` detail, rsvp), the shared `cal.js`/`cal.css`, and the sidebar `MiniMonth` and "Calendars" list (`shell.js` `miniMonth()`, `CALENDARS`; placed by `ui-shell`, data from this lane). DESIGN §7.8, §4.2, §7.1 (sidebar on Calendar, pane-header calendar button), §7.13 (undo toasts), §7.14 (Calendar day empty), §7.15, §8 Calendar row, §9 rule 6, §11. Also the undrawn surfaces DESIGN or plan 30 requires: creating, moving and resizing by drag, the event editor (N, E), the repeat-scope choice, delete with 8 s undo, the narrow agenda (< 720 px), plans found in mail, all-day events, and the event data the Today tab (`ui-ask`) and Home's inbox-zero "Next:" line (`ui-home`) read. Baseline checked: plan 10 §4.1 (verbs, frames, scenarios, `Fixture/control`), plan 30 §4.1 (view-spec row `Event/query`), §8.1-8.2, U7 acceptance 6; plan 20 PV8, PV9, PV5 scope manifest, §7; ARCH §3.2 (`calendars`, `events`), §5.5, §6.3-6.4, §9.1-9.2; roadmap §2 and decision 32. Legacy renderer read for what works today (read-only): `Calendar.tsx`, `calendarLayout.ts`, `detectedPlans.ts`, `shared/types.ts` (`CalendarEvent`, `CalendarInfo`), `engine/service.ts:906-935`.

**Baseline facts this map relies on**
- Planned calendar verbs are only `Event/set {scope: occurrence|series|following}` and `Event/rsvp` (plan 10 §4.1 verbs; plan 10 §7.1 "Contract methods backed by plan 20"; plan 20 §7 item 3). No `Event/get`, `Event/query`, `Calendar/get`, `Calendar/set` or plan (found-in-mail) methods are named anywhere. ARCH §9.1 lists `Calendar` and `Event` as types and says every type gets JMAP-style `get/changes/set/query`, which implies but does not name them.
- Plan 30 §4.1 lists "`Event/query` by range and calendars; today agenda; conversations" in the **view specs** table, but `View/watch` windows are keyset lists of at most 200 rows (ARCH §9.2). Whether events are a watched window or a one-shot query is not stated.
- Schema: `calendars(id, account_id, remote_id, name, color, is_primary, hidden, read_only)` and `events(id, calendar_id, remote_id, etag, master_id, recurrence, start_utc, end_utc, all_day, data, ics)`, plus a recurrence id (F4, plan 20 §7 item 6). Masters and overrides are stored, and expansion happens on query (ARCH §3.2, §5.5; PV8).
- Today the legacy `CalendarEvent` has `{id, accountId, threadId?, calendarId, title, start, end, allDay, location, description, guests: string[], remoteId?, url?, etag?, scheduling?}`. It has no attendee status, organizer, RSVP, recurrence, conference or time zone. Found plans live only in a renderer-session `Map` (`detectedPlans.ts`). Delete is a hard delete after a confirm dialog (`Calendar.tsx:136`).
- Google scopes are fixed at `calendar.calendarlist.readonly` and `calendar.events` (plan 20 PV5 scope manifest; thread brief: "never ask for a broader Google scope"). Aplos therefore cannot write a calendar's `selected`, `hidden` or colour back to Google.
- Repeat-edit scopes: "this event" and "all events" ship first, with "this and following" later (roadmap decision 32; plan 20 Decision 6, cut order).

## Element map

### `calendar-week.html` (states `default`, `overlap`; Month via `?view=month`)

| Element / state | DESIGN § | Needs (data, call, frame, setting, command, component) | Planned home | Status |
|---|---|---|---|---|
| Route `Calendar` (sidebar item, ⌃6), active puck | §7.1, §8 Global | command `nav.calendar` (⌃6); route | plan 30 §4.2 registry; `ui-shell` sidebar | COVERED |
| Pane-header tools: New event (+, N), Ask (A), calendar button (Today, ⇧A) | §7.1 pane header, §8 | commands `cal.new`, `ask.open`, `today.open`; `PageHead`/header slots | plan 30 §4.2; DESIGN §6 | COVERED |
| Date label "October 2026"; a week across months reads "Oct – Nov 2026" | §7.8 Top row | the UI formats it from the visible range (no data); `title` type token, **not a heading** | DESIGN §7.8; F9 tokens | COVERED (mockup disagrees, see DESIGN vs mockup 1) |
| Range beside the label: "October 25 – 31", "Oct 25 – Nov 1"; Month: "N events" (`monthSub`) | §7.8 | Month count needs the event count in the month range across shown calendars | `Event/query` range (plan 30 §4.1), shape unknown | GAP-1 |
| Today button (T), Prev/Next (K/←, J/→) with aria "Previous week/month" | §7.8, §8 Calendar | commands `cal.today`, `cal.prev`, `cal.next`; "today" from one clock source | registry; clock: GAP-15 | COVERED (clock UNCLEAR-12) |
| D \| W \| M segmented control on a `Puck`, `slide`, no width change | §7.8 Motion, §6 `Puck` | commands `cal.view.day|week|month`; remembered view | `Puck` (F9); persistence: GAP-14 | GAP-14 |
| Day headers "Thu 29", today `aria-current="date"`, filled accent badge, `--today-tint` column | §7.8 Grid, §4.1 | clock, local time zone; tokens `--today-tint`, `--accent` | F9 tokens | COVERED |
| Hour labels in `caption` 11 px, 56 px per hour, hairlines `--line` | §7.8 Grid, Fixes | layout only; hour height changed by pinch and ⌘-scroll (persisted?) | F9 tokens; persistence GAP-14 | COVERED |
| Grid shows 8 AM-8 PM (mockup draws only 8-20) | §7.8 "8 AM to 8 PM fits" | 24 h scrollable, opening scrolled to 8 AM | DESIGN | UNCLEAR-7 |
| Now line, 1 px `--stamp` and a 5 px cap, crossing event text | §7.8 Grid | clock ticking each minute, suspended when hidden (§5 rule 15) | `NowLine` (DESIGN §6) | COVERED (clock UNCLEAR-12) |
| Event block: radius 6, 2 px rule in the calendar colour, fill 12 %/20 % over `--canvas`, title `small` 500, time `--dim` (dark `--ink-2`) | §7.8 Events, §4.2 | `event.title`, `event.start/end` as instants, `event.calendarId` → `calendar.colorTag` (one of six tags) | ARCH §3.2 `events.start_utc/end_utc`, `calendars.color` (raw provider colour only) | GAP-3, GAP-8 |
| Under 30 min: one line, title only; under 1 h: one line with time (mockup) | §7.8 | duration | derived | COVERED |
| Wide event shows "time · place" | mockup `evHTML` | `event.location` | not in any planned field list (`events.data` JSON) | GAP-5 |
| Overlap layout: lanes; 3+ concurrent → first lane plus "+N" stack ≥ 44 px | §7.8, plan 30 U7 acc. 6 | pure layout over the range's events | `ui-calendar` layout helper (plan 30 U0 defect 6) | COVERED |
| `overlap` state: "+2" stack opens a `Menu` "2 more at 11:00 AM" listing the events with colour dot and time | §7.8, §6 `Menu` | same event rows | `Menu` (F9) | COVERED |
| Click selects (`is-selected`, `aria-pressed`); Return or double-click opens the detail | §8 Return open | selection state; `cal.open` | registry | COVERED |
| Keyboard selection of an event in W (no key draws it) | §8 (silent) | e.g. ↑/↓ or Tab between events | none | UNCLEAR-8 |
| Plan block "Hollow Creek launch prep": dashed 1 px outline, `--canvas` fill, mail icon + "From mail"; aria "found in mail, not added yet" | §7.8 Events, §11 (dashed + label) | the plan's title, time, source thread and state appear in the same range result | `plan` job kind exists (plan 10 E5 item 1); no storage, type or method | GAP-9 |
| Recurring "Standup" Mon-Thu 11:00-11:15 | §7.8 (implicit) | expanded occurrences, each with a stable id: series id + original start | ARCH §5.5, PV8 (expansion on query); occurrence id scheme not defined | GAP-2 |
| Live updates: an edit from Google appears without reload; a dragged or open event never jumps under the cursor | §5 rule 6 | a live window over a time range, with `holdIds` | `View/watch` (ARCH §9.2) is keyset-only with ≤ 200 rows | GAP-1 |
| Month view: 6×7 cells, out-of-month `--dim`, today tint and badge, ≤ 3 chips or 2 chips + "N more" (never "1 more") | §7.8 (D/W/M); mockup only | 42-day range of events (can exceed 200 rows) | GAP-1 | GAP-1 |
| Toast on stack-item click "Q4 review · 11:00 – 12:00 PM" (mock only) | §7.13 "no toasts for navigation" | none; real app opens the detail | DESIGN §7.13 | COVERED (mock artefact, not built) |
| sr-only live region "October 2026, October 25 – 31" | §11.3 | announce on period change | `ui-calendar` | COVERED |
| Calendar is a `grid` with text equivalents | §11.3 | `role="grid"`, labelled cells, event aria label "Title, 11:00 – 12:00 PM, Work" | `CalendarGrid` (DESIGN §6) | COVERED |

### `calendar-day.html` (states `default`, `empty`)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Label "October 2026" + "Thursday, October 29" | §7.8 Top row, Fixes (comma) | format; the day title gets the comma ("Thursday, October 29, 2026") | `dateLabel` test (plan 30 U0 defect 7) | COVERED |
| One wide column, up to 6 lanes, then a stack | §7.8 | layout | `ui-calendar` | UNCLEAR-14 |
| Detail rail (360 px, `--dock-w`) showing the selected event, defaulting to the first | mockup only (DESIGN silent) | the full event row (GAP-5 fields) | none | UNCLEAR-15 |
| ↑/↓ move the selection through the day's events in time order | mockup only | registry commands `cal.selectNext/Prev` | not in DESIGN §8 | UNCLEAR-8 |
| Detail head: title (`title`), ⋯ ("More: edit, delete" / "More: change your reply, hide" / "More: hide, copy link"), Close (Esc) in the popover | §7.8, §8 E, ⌫ | `event.can.{edit,delete,rsvp}`, `event.isOrganizer`, `event.htmlLink` | none (legacy `scheduling` flag only) | GAP-4 |
| "Thursday, October 29 · 2:00 – 2:30 PM" | §7.8 | `start/end` instants plus all-day dates; display zone | GAP-3 | GAP-3 |
| Calendar row: dot + "Hollow Creek" | §4.2 | `calendar.name`, `calendar.colorTag` | ARCH §3.2 `calendars.name,color` | GAP-8 |
| Video row `meet.fernworks.studio/design-review` (link) | §7.8 (implicit) | `event.conference {url, label}` (Google `conferenceData`/`hangoutLink`) | PV9 keeps `conferenceData` on patch; not a contract field | GAP-5 |
| Place row (pin) "Northwind Dental, 14 Alder Street" | mockup | `event.location` | not a field | GAP-5 |
| Guests: name, role "you, organizer", status icon + "Going/Maybe/Declined/No reply yet" | mockup | `event.organizer {name?, email, self}`, `event.attendees[] {name?, email, response, self, organizer, optional}` | legacy `guests: string[]`; PV9 RSVP patches `attendees` | GAP-5 |
| Description paragraph (plain text) | mockup | `event.description` as safe plain text (Google descriptions can be HTML) | not a field | GAP-5 |
| `empty`: "Nothing scheduled." + text button "New event · N" (keycap always shown); rail hidden | §7.14 Calendar day | an empty range result for one day, distinct from "loading" | GAP-1 (a first window or result with `total: 0`) | COVERED (given GAP-1) |
| No calendar account or calendar scope missing: what the empty day says | undrawn | `Account.capabilities.calendar`, granted scopes | ARCH §3.2 `accounts.capabilities`, `granted_scopes`; copy missing | GAP-13 |
| sr-only "Thursday, October 29, 2026. 3 events." / ". Nothing scheduled." | §11.3 | count | derived | COVERED |

### `calendar-event.html` (states `detail`, `rsvp`)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Popover (`role=dialog`, `--elev-float`, `reveal`) anchored to the event, 360 px | §6 `Popover`, §7.8 | anchor geometry; the event row | F9 `Popover` | COVERED |
| Row "Invite from Priya Raman" (mail icon, link, tooltip "Open the invite email", O) | mockup | `event.invite {threadId, messageId, fromName}`, the link from the Google event to its invite email (iCalUID) | none | GAP-10 |
| `rsvp`: "Going?" + Yes \| Maybe \| No (`Puck`), **nothing selected**; filled "Send reply · Return" disabled until a choice | §7.8 RSVP, plan 30 U7 acc. 6 | `event.myResponse === 'needsAction'`, `event.can.rsvp` | `Event/rsvp` (plan 10 §4.1) name only; input shape not defined | GAP-6 |
| Y / M / N choose only while an unanswered invite is open; otherwise M = Month | §7.8, §8 Calendar | registry context `calendar.invite` stacked above `calendar`; `when(ctx)` | plan 30 §4.2 resolver (context stack, `when`) | COVERED |
| Return sends → toast "Reply sent to Priya: Yes · Undo Z" (check, hill) | §7.13 | `Event/rsvp {opId, ref, response, scope}` → receipt; organizer's first name; Undo | `Operation/undo` is an inverse op (DESIGN §5 rule 11) | GAP-6, GAP-7 |
| RSVP on one occurrence of a repeating invite vs the series | §7.8 (silent) | `Event/rsvp.scope` | none | GAP-6 |
| `detail` (answered): no RSVP block; guests show your status; "More: change your reply" | mockup | `myResponse`, attendee `self` | GAP-5 | GAP-5 |
| Guest "Alex Moreno · you" with "No reply yet" until answered, then flips | mockup | optimistic overlay on the attendee list | plan 30 §4.1 `optimistic.ts` (generic) | COVERED (given GAP-5) |
| O opens the invite email in the reader | mockup; §8 (O not listed for Calendar) | `Thread` route with `threadId` | reader route (`ui-reader`) | GAP-10 |
| Esc closes the popover; Esc ladder never leaves Calendar from a closed popover | §8 Global Esc ladder | registry | plan 30 §4.2 | COVERED |
| Agents may never RSVP live | roadmap "Decisions already made" | RSVP live check is the owner's hand step | roadmap §1 rules; plan 20 §5.4 | COVERED |

### Sidebar on Calendar (`MiniMonth`, "Calendars"; placed by `ui-shell`)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Mini month: "October 2026", prev/next month (xs icon buttons), S M T W T F S, out-of-month `--dim`, the visible week on `--puck`, today filled accent | §7.1, §7.8 Sidebar, §6 | props `{month, visibleRange, today, weekStart, onPick(date), onMonth(delta)}`; no engine data | F9 frozen props for `MiniMonth` (plan 30 U3) not yet written | GAP-15 |
| Mini month dots or bold for busy days (legacy `busyDays`) | not drawn | none (not required) | n/a | COVERED (not built) |
| "Calendars" `NavHead` + rows: colour swatch + name ("Work", "Personal", "Hollow Creek", "Family") | §7.1, §4.2 | `Calendar/get` list: `{id, accountId, name, colorTag, primary, readOnly, shown}` | ARCH §9.1 type `Calendar`; no method named; plan 30 §4.1 singletons include calendars | GAP-8 |
| Click a calendar toggles it; hidden-calendar look | §7.1 ("legend") | `Calendar/set {id, shown}` (Aplos-local) | plan 30 §8.2 asks for "hidden and selected calendars"; none planned | GAP-8, UNCLEAR-5 |
| ⌥-click shows one calendar alone | §7.1, §8 Calendar | `solo` view state (session) or `Calendar/set` batch | none | GAP-8 |
| Two accounts each with "Calendar"/primary: telling them apart | §4.2 (account dots with ≥ 2 accounts) | `calendar.accountId` → account display name | ARCH §3.2 `calendars.account_id` | COVERED |
| Colour pair per calendar by stable hash of the name, with a manual override in Settings | §4.2 | `calendar.colorTag` resolved by the engine, `Calendar/set {colorTag}` or `Settings.calendarColors` | `calendars.color` holds Google's hex, which DESIGN does not use | GAP-8, UNCLEAR-6 |

### Undrawn surfaces DESIGN requires (no mockup)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Drag on empty grid to create (`lift`, `snap`, 15 min snap) → quick title field → Return saves | §7.8 Motion | `Event/set create` with a client creation id; default calendar; receipt mapping the creation id to the new id | ARCH §9.1 "client creation ids"; `Event/set` input not specified | UNCLEAR-3 |
| N: new event at the next free slot in view, editor open | §8 | editor; default calendar (last used, else primary) | default calendar not stored anywhere (legacy localStorage) | GAP-14 |
| E: edit (title, time, all-day, calendar, location, guests, description, repeat) | §8 | editable fields + `event.can.edit`; repeat rule round-trip | `Event/set` (name only) | GAP-4, GAP-11 |
| Drag to move or resize (`lift`/`snap`); optimistic; failure returns the block with `ErrorLine` "Couldn't move Q4 review." + Retry | §7.8, §5 rule 11, §7.15 Write rejected | `Event/set update {start,end}` → receipt; failure frame per `opId`; `holdIds` | plan 30 §4.1 optimistic overlay (generic) | COVERED (given GAP-1/2) |
| Locked events cannot be dragged (calendar read-only, not organizer) | §7.8 (implicit) | `event.can.move`, `calendar.readOnly` | ARCH §3.2 `calendars.read_only`; PV9 `forbiddenForNonOrganizer` | GAP-4 |
| Repeating event edit or move: choice "This event" / "All events" (later "This and following"), two key rows, `Dialog` | §7.8, plan 30 U7 | `Event/set {scope}`; `following` hidden until it ships | plan 10 §4.1 `scope: occurrence|series|following`; roadmap decision 32 | UNCLEAR-4 |
| ⌫ delete → "Event deleted · Undo Z" for 8 s; no confirm dialog | §8 Calendar, §7.13 | `Event/set destroy` + `Operation/undo` that **cancels** before the provider is told (Google would email cancellations, and a re-create sends new invites) | `Operation/undo` = inverse op (DESIGN §5 rule 11, plan 30 §4.1) | GAP-7 |
| Delete only on persisted events (not the unsaved draft) | §7.8 Fixes, acc. 6 | `event.persisted` / `syncState` | legacy `event.id` check | GAP-4, UNCLEAR-9 |
| Delete on a repeating event asks the scope | §7.8 | `scope` on destroy | `Event/set {scope}` | COVERED (given GAP-2) |
| Edit conflict (Google 412): change not saved | §7.15 pattern | error type `conflict`; copy | plan 20 §3.3 "412 raises an edit conflict"; no contract error type | GAP-12 |
| Offline create or move: "Saved here · will sync" | §7.13 Offline | op queue + `offline` status | ARCH §6.4; op queue | COVERED |
| Narrow (pane < 720 px): agenda list grouped by day | §7.8 Narrow | same range data | GAP-1 | GAP-1 |
| All-day and multi-day events (a strip above the grid) | not in DESIGN or mockups | `event.allDay`, date-only start and end (exclusive end) | ARCH §3.2 `events.all_day` | UNCLEAR-13 |
| Plan found in mail, opened: detail says "Found in Jordan Park's email: '…' Nothing is added until you confirm." with "Add to calendar · Return" / "Not now · Esc" | §7.8, §9 rules 2, 6 | `Plan {id, threadId, messageId, fromName, quote, title, start, end, allDay, suggestedCalendarId, state}`; `Plan/confirm`, `Plan/dismiss` | `plan` job (plan 10 E5); legacy session-only `detectedPlans.ts` | GAP-9 |
| AI off or no consent: no plans, nothing broken | §9 rule 7 | plans absent in `ai-off` | plan 10 §4.1 scenario `ai-off` | COVERED |
| Calendar paused by Google (`quotaExceeded`, hours) or one calendar failing while others sync | §7.15 pattern; ARCH §6.3 `anti_abuse` | per-calendar or calendar-capability status + copy | ARCH §6.4 status is per account; PV9 "errors reported per calendar"; no field | GAP-13 |
| Ask proposal "Add to Calendar · Thu 2:00–2:30 PM · Hollow Creek" → "Added to Calendar" (`ui-ask`) | §7.7, §9 rule 6 | `Event/set create` from a proposal; calendar name + colour | `Ask/run` (plan 10 E5) + GAP-8 | COVERED (given GAP-8) |
| Today tab: "Thursday, October 29", "4 events · next at 11:00 AM", agenda with now line, "Free for 2 h 45 min", "Open Calendar ⌃6" (`ui-ask`) | §7.7 Today | today's events with `transparency`, `myResponse` (declined and free events do not block a gap) | plan 30 §4.1 "today agenda" | GAP-1, GAP-5 |
| Home inbox-zero "Next: Design review at 2:00 PM" (`ui-home`) | §7.14 | the next event from now | same range query | GAP-1 |
| Settings → Calendar section (DESIGN §7.10 lists it, nothing drawn) | §7.10 | colour overrides, default calendar, week start, show declined | `Settings` schema (F1) | GAP-14 |
| Shortcut sheet and Settings → Keyboard: T, D/W/M, J/K, N, Return, E, ⌫, Y/M/N, ⌥-click, zoom | §8, §6 `ShortcutSheet` | registry entries with context `calendar` | plan 30 §4.2 | COVERED |

## Gaps

**GAP-1. Event reads: a live range query.**
- *Screen needs:* "`Event/query` by range and calendars; today agenda" (plan 30 §4.1). The week, day, month, narrow agenda, Today tab and Home's "Next:" line all read events in a time range, and Google edits must arrive live without moving a held event (§5 rule 6). Month is 42 days, which can exceed the 200-row window.
- *Why not covered:* `View/watch` is a keyset window of ≤ 200 rows with `move` (ARCH §9.2). No `Event/get` or `Event/query` is named (plan 10 §4.1). The spec union has no events member. Recurrences expand per query (PV8), so the result is not a stored list.
- *Proposed shape:*
  - `View/watch {spec: {kind: 'events', from: number /*utc ms*/, to: number, calendarIds?: string[] /*default: shown*/, include?: {plans?: boolean, declined?: boolean}}, holdIds?}`. It returns `window {windowId, state, ids, total}` with **no 200 cap for this kind**, and the range is capped at 62 days (exceeding it gives error `rangeTooLarge`). `View/move {windowId, from, to}` changes the range.
  - `Event/get {ids} → {list: Event[], notFound}`.
  - `View/query` with the same spec for one-shot reads (Ask tools, Home "Next:").
- *Addressed to:* `eng-contract`, `eng-views`, `prov-cal`.
- *Severity:* **blocks-freeze**, because the spec union and the window semantics are frozen at C1.
- *Stand-in:* demo calendars across ±6 weeks; `Fixture/control {kind:'calendarChange', eventId, patch}` to push a remote edit; scenario `calendar-dense` (> 200 occurrences in one month).

**GAP-2. Occurrence identity.**
- *Screen needs:* the repeating "Standup" occurrences must be selectable, movable, deletable and answerable one at a time. Row-cache keys must be stable across reloads.
- *Why not covered:* expanded occurrences have no DB row (ARCH §3.2 comment "expansion on query"). `Event/set {scope}` names a scope but not how an occurrence is addressed.
- *Proposed shape:*
  - The `Event` row carries:
    - `id`: for an expanded occurrence, `"<seriesId>@<originalStartUtc>"`; for a stored row, its own id.
    - `seriesId?`
    - `originalStart?: number`
    - `recurring: boolean`
    - `exception: boolean` (an override)
    - `rev`
  - `Event/set` and `Event/rsvp` take `ref: {id}`, and the engine resolves series and occurrence.
- *Addressed to:* `prov-cal`, `eng-contract`.
- *Severity:* **blocks-freeze**, because the input shape of `Event/set` and `Event/rsvp` is frozen at C1.
- *Stand-in:* the demo standup is Mon-Thu with one override (moved to 11:30 on one day) and one EXDATE.

**GAP-3. Time fields with time zones and all-day.**
- *Screen needs:* "2:00 – 2:30 PM" in local time; correct DST; all-day events; the editor keeps the event's own zone.
- *Why not covered:* the legacy `start/end` are ISO strings with all-day as dates (`shared/types.ts`). The schema stores `start_utc/end_utc/all_day`. No contract shape is defined.
- *Proposed shape:*
  - `start: {utc: number} | {date: 'YYYY-MM-DD'}` and `end`, same form; the all-day end is exclusive, as Google stores it.
  - `allDay: boolean`
  - `timeZone?: string` (IANA, the event's zone)
  - Wire rule (ARCH §9.3): no `Date`, so use numbers.
- *Addressed to:* `eng-contract`, `prov-cal`.
- *Severity:* **blocks-freeze**, because changing a field's type later breaks clients.
- *Stand-in:* one event in `America/New_York` shown in `America/Los_Angeles`; one event across the 2026-11-01 DST change; a two-day all-day event.

**GAP-4. Editability and persistence.**
- *Screen needs:* "Delete appears only on persisted events" (§7.8; acceptance 6); ⋯ shows "edit, delete" only on your own events; drag is blocked on locked events; read-only calendars cannot take new events.
- *Why not covered:* the schema has `calendars.read_only` only. PV9 makes shared fields read-only for non-organizers, but nothing reaches the contract. The legacy coarse `scheduling` flag is gone.
- *Proposed shape:* the `Event` row gains:
  - `can: {edit: boolean, move: boolean, delete: boolean, rsvp: boolean, editGuests: boolean}`
  - `lockedReason?: 'readOnlyCalendar'|'notOrganizer'|'provider'`
  - `syncState: 'pending'|'synced'|'failed'` (a pending create is persisted locally)
  - `isOrganizer: boolean`
  - `htmlLink?: string`
- *Addressed to:* `prov-cal`, `eng-contract`.
- *Severity:* additive-later (optional fields), wanted at F1 because acceptance 6 depends on it.
- *Stand-in:* a read-only "Holidays" calendar; an invite you do not organise; `Fixture/control {kind:'failNextWrite', type:'Event'}`.

**GAP-5. Event detail fields.**
- *Screen needs:* the video link, the place, "Guests" with "you, organizer" and Going/Maybe/Declined/No reply yet, the description, and the Today tab's free gaps.
- *Why not covered:* no planned field list. ARCH stores a `data` JSON blob. The legacy row has `guests: string[]` only.
- *Proposed shape:* the `Event` row gains:
  - `location?: string`
  - `description?: string` (plain text, converted from HTML by the engine)
  - `conference?: {url: string, label?: string}`
  - `organizer?: {email, name?, self}`
  - `attendees: {email, name?, response: 'needsAction'|'accepted'|'tentative'|'declined', self, organizer, optional}[]`
  - `myResponse?` (the same enum)
  - `transparency: 'busy'|'free'`
  - `status: 'confirmed'|'tentative'`
  - Cancelled occurrences are never returned.
- *Addressed to:* `prov-cal`, `eng-contract`.
- *Severity:* additive-later, wanted at F1.
- *Stand-in:* the demo data mirrors `cal.js` `INFO` (Design review with a Meet link and three guests; Q4 review as an invite with `needsAction`; Dental with a place).

**GAP-6. `Event/rsvp` input and per-occurrence answers.**
- *Screen needs:* Yes/Maybe/No; "Send reply" disabled until chosen; answering one occurrence of a repeating invite or the whole series; "change your reply" later.
- *Why not covered:* only the name exists (plan 10 §4.1). PV9 describes the provider side only.
- *Proposed shape:* `Event/rsvp {opId, ref: {id}, response: 'accepted'|'tentative'|'declined', scope: 'occurrence'|'series', notifyOrganizer?: boolean /*default true*/} → receipt {opId, appliedState, undoUntil?}`.
- *Addressed to:* `eng-contract`, `prov-cal`.
- *Severity:* **blocks-freeze** (input schema).
- *Stand-in:* the Q4 review invite (`needsAction`) plus a weekly invited series.

**GAP-7. Undo for calendar writes that notify other people.**
- *Screen needs:* "⌫ delete (8 s undo)" (§8) and "Reply sent to Priya: Yes · Undo Z" (mockup).
- *Why not covered:* DESIGN §5 rule 11 and plan 30 §4.1 define Undo as an *inverse operation*. For Google, deleting an event with guests emails cancellations, and re-creating it gives a new id and sends new invites. An RSVP followed by its inverse emails the organizer twice. The inverse is therefore lossy.
- *Proposed shape:* calendar ops (`Event/set destroy`, `Event/rsvp`, and series-scope updates) are queued with `notBefore = now + 8000` (the op queue already has `next_at`, ARCH §3.2 `ops`). The receipt carries `undoUntil: number`. `Operation/undo {opId}` *cancels* a queued op (state `cancelled`, overlay dropped) and falls back to the inverse only after the hold. The timer loop flushes at `undoUntil`.
- *Addressed to:* `eng-contract` (receipt and undo semantics), `eng-time` (timer), `prov-cal`.
- *Severity:* **blocks-freeze**, because it changes `Operation/undo`'s documented meaning.
- *Stand-in:* `Fixture/control {kind:'clock', advanceMs}` to cross the 8 s mark; assert the provider-call log is empty before it.

**GAP-8. Calendars: list, colour tag, Aplos-side visibility.**
- *Screen needs:* the "Calendars" list with swatches; click to hide or show; ⌥-click solo; "colour by stable hash of the name, with a manual override in Settings" (§4.2); a dot and calendar name in the detail; the calendar picker in the editor and in Ask proposals.
- *Why not covered:* `Calendar` is a type (ARCH §9.1) but no method is named. `calendars.color` holds Google's hex, which DESIGN does not use. There is a `hidden` column but no `selected` (ARCH §5.5 says both are respected). Writing to Google is impossible under `calendarlist.readonly` (PV5).
- *Proposed shape:*
  - `Calendar/get {} → {list: {id, accountId, name, colorTag: 'sky'|'hill'|'stamp'|'dusk'|'sand'|'ember', primary, readOnly, shown, providerHidden}[]}`, a live singleton through the `state` frame.
  - `Calendar/set {id, shown?, colorTag?: tag|null}` is local-only. The first `shown` is Google `selected && !hidden`.
  - Solo is renderer state; leaving it restores the previous set.
- *Addressed to:* `eng-contract`, `prov-cal`; `ui-shell` places the list.
- *Severity:* additive-later (new methods), but the stand-in needs it by day 6.
- *Stand-in:* four demo calendars (Work hill, Personal sky, Hollow Creek ember, Family sand); one `providerHidden`.

**GAP-9. Plans found in mail.**
- *Screen needs:* the dashed "From mail" block until confirmed (§7.8); its detail with the quote and the source; confirm writes the event, and "Not now" dismisses it; nothing is written without confirmation (§9 rule 6); the reader's "Add to calendar" and the Ask proposal use the same object.
- *Why not covered:* the `plan` job kind exists (plan 10 E5 item 1) but its output has no table (ARCH §3.2), type or method. The legacy plans are a session-only renderer `Map` and `autoCalendar` silently adds events, which DESIGN §9 rule 6 now forbids.
- *Proposed shape:*
  - Type `Plan {id, threadId, messageId, fromName, quote, title, start, end, allDay, timeZone?, location?, suggestedCalendarId?, confidence: number, state: 'pending'|'confirmed'|'dismissed', eventId?}`.
  - The events range spec includes pending plans with `include.plans`.
  - `Plan/confirm {opId, id, calendarId?, edits?} → receipt + eventId`.
  - `Plan/dismiss {opId, id}`, undoable.
  - Settings `autoCalendar` is retired.
- *Addressed to:* `eng-ai` (job output), `eng-store` (table, migration), `eng-contract`.
- *Severity:* additive-later (new type and table), wanted at freeze so the stand-in serves it on day 6.
- *Stand-in:* the demo plan "Hollow Creek launch prep" Fri 3:00-4:30 PM from Jordan Park's thread; absent in `ai-off`.

**GAP-10. Invite ↔ email link.**
- *Screen needs:* "Invite from Priya Raman" with O opening the invite email (mockup `data-open-invite`).
- *Why not covered:* Google events carry no Gmail thread id. Nothing plans to match the invite's `text/calendar` UID to the event's `iCalUID`.
- *Proposed shape:* the `Event` row gains `invite?: {threadId, messageId, fromName}`, filled when a message with a matching iCalUID is in the store (computed at ingest and on body fetch).
- *Addressed to:* `prov-cal`, `prov-gmail`.
- *Severity:* additive-later. Without it the row is hidden.
- *Stand-in:* demo thread "Q4 review" from Priya Raman linked to the invite event.

**GAP-11. Recurrence rule for the editor and display.**
- *Screen needs:* the editor's Repeat control and a line such as "Every Tuesday" (not drawn, but the repeat-scope flow implies the user can see the event repeats).
- *Why not covered:* the recurrence module is engine-side (PV8). No contract field exposes the rule.
- *Proposed shape:*
  - The `Event` row gains `recurrence?: {freq: 'daily'|'weekly'|'monthly'|'yearly', interval, byDay?: string[], byMonthDay?: number[], count?, until?: number, editable: boolean}`. `editable` is false when Aplos cannot round-trip the rule (plan 20 §6 "refuse and say so").
  - `Event/set` series updates accept the same shape.
- *Addressed to:* `prov-cal`, `eng-contract`.
- *Severity:* additive-later.
- *Stand-in:* a weekly standup and one rule Aplos refuses (BYSETPOS with BYHOUR).

**GAP-12. Edit-conflict error type.**
- *Screen needs:* a write that loses to a newer Google version comes back with a plain line and a way forward (the §7.15 pattern), for example "Q4 review changed in Google Calendar. Your change wasn't saved." with "Use theirs" / "Try again".
- *Why not covered:* the ARCH §6.3 taxonomy has no `conflict`, although plan 20 §3.3 raises one for 412.
- *Proposed shape:* error `{type: 'conflict', message, current?: Event}` on the op's failure frame.
- *Addressed to:* `eng-contract`, `prov-cal`.
- *Severity:* additive-later (open string enums, ARCH §9.3).
- *Stand-in:* `Fixture/control {kind:'failNextWrite', type:'Event', error:'conflict'}`.

**GAP-13. Calendar-specific status and capability.**
- *Screen needs:*
  - the calendar view when the account lacks the calendar scope or capability (D5);
  - Google Calendar paused for hours (`quotaExceeded`, ARCH §6.3 `anti_abuse`) while mail is fine;
  - one calendar failing while others sync (PV9, D12).
- *Why not covered:* the status vocabulary is per account (ARCH §6.4). The `StatusSlot` copy table (DESIGN §7.1) has no calendar line. `calendars` has no status column.
- *Proposed shape:*
  - `Calendar` row gains `sync?: {state: 'ok'|'paused'|'error', until?, reason?}`.
  - `Account` row exposes `capabilities.calendar` and `calendarStatus?: {state, until?, reason}`.
  - Copy (for owner review): "Google Calendar asked us to slow down. Resuming at 5:10 PM." / "Aplos needs permission to read your calendar." with Reconnect.
- *Addressed to:* `prov-gov`, `prov-cal`, `eng-contract`; copy to `ui-shell`.
- *Severity:* additive-later.
- *Stand-in:* new scenarios `calendar-paused` and `calendar-no-scope`.

**GAP-14. Calendar settings fields.**
- *Screen needs:* the remembered D/W/M view; the pinch or ⌘-scroll hour zoom; the default calendar for N and drag-create ("calendar used last", legacy); week start (the mockup starts on Sunday); whether declined events show; the Settings → Calendar section (§7.10).
- *Why not covered:* the `ui` object lists only density, key hints, dock, keymap and hold threshold (plan 30 §8.1 item 8). The legacy values sit in `localStorage`.
- *Proposed shape:* `Settings.ui.calendar: {view: 'day'|'week'|'month', hourHeight: number, weekStart: 0|1, showDeclined: boolean}` and `Settings.calendar: {defaultCalendarId?: string}`. Colour overrides live on `Calendar/set` (GAP-8).
- *Addressed to:* `eng-contract`.
- *Severity:* additive-later (optional fields), cheapest at F1.
- *Stand-in:* none.

**GAP-15. F9 component props and hooks for Calendar.**
- *Screen needs:*
  - `MiniMonth` and `CalendarList` placed by `ui-shell` with data from this lane;
  - a range hook (not keyset `move`);
  - one clock for the today column, the now line and the Today tab, which the harness can set (plan 10 §4.1 "set the clock (`APLOS_NOW`)" sets only the engine).
- *Why not covered:* F9 freezes the `MiniMonth` and `CalendarList` props and the `useView`/`useRow` signatures (plan 30 U3, §4.1), and none are written yet. `useView` returns `{ids,total,rows,move,state}` for keyset lists.
- *Proposed shape:*
  - `MiniMonth {month: 'YYYY-MM', visibleRange: {from: date, to: date}, today: date, weekStart: 0|1, onPick(date), onMonth(delta)}`.
  - `CalendarList {calendars: CalendarRow[], soloId?: string, onToggle(id), onSolo(id)}`.
  - `useView` accepts the events spec and exposes `setRange({from,to})`, or a thin `useEvents(range, calendarIds)` on top of it.
  - `useNow(granularity)` reads one clock that tests override (Playwright clock or `Session/get.now` in the fixture).
- *Addressed to:* `ui-foundation` (props, hook), `ui-shell` (placement).
- *Severity:* **blocks-freeze** (F9 props and hook signatures are frozen on day 3).
- *Stand-in:* none.

**GAP-16. Calendar demo data and fixture knobs.**
- *Screen needs:* every mockup state reproducible on the stand-in from day 6.
- *Why not covered:* the `demo` scenario is "today's demo data" (plan 10 §4.1), which has no attendees, invites, recurrence or plans.
- *Proposed shape:*
  - The `demo` scenario carries the `cal.js` world: today Thu 2026-10-29 10:00, four calendars, recurring standup, the Q4 invite (`needsAction`), the plan, and Design review with a Meet link.
  - `Fixture/control` adds `calendarChange`, `failNextWrite{type:'Event', error}`, `setCalendarStatus`, and `clock.advanceMs`.
- *Addressed to:* `eng-contract`.
- *Severity:* additive-later, needed by day 6.
- *Stand-in:* the data and knobs themselves.

## Unclear

1. **`Event/query`: a watch or a one-shot query?** Plan 30 §4.1 puts it in the *view spec* table, but the name is a method, and plan 10 §4.1 also has `View/query`. **Read:** `View/watch` with an `events` spec for screens (live) and `View/query` with the same spec for one-shot reads. Do not add a separate `Event/query` method (GAP-1).
2. **Do `Event/get`, `Calendar/get` and `Calendar/set` exist?** ARCH §9.1 implies per-type `get/set/query`, but plan 10 §4.1's verb list names only `Event/set` and `Event/rsvp`. **Read:** list them explicitly in F1 (GAP-1, GAP-8).
3. **`Event/set` shape.** It could be JMAP-style `{create:{clientId:{…}}, update:{id:{patch, scope}}, destroy:[{id, scope}]}` (ARCH §9.1 "client creation ids", `ifInState`) or one verb per action. **Read:** use JMAP style, with `scope` per update or destroy entry, `ifInState`/etag, and a receipt `{opId, appliedState, created: {clientId: id}, undoUntil?}`.
4. **`following` scope.** Plan 10 §4.1 freezes `occurrence|series|following`. Roadmap decision 32 ships "this event" and "all events" first, and plan 20 puts "this and following" in the cut order. **Read:** keep the enum; until the capability flag `Session/get.capabilities.calendarFollowing` is true, the engine and stand-in answer `following` with error `unsupported`; the UI hides the choice.
5. **What clicking a calendar does.** DESIGN §7.1 calls the list a "legend" and defines only ⌥-click (solo). The hidden look is not drawn. Google `selected`/`hidden` cannot be written (PV5 scopes). **Read:** a click toggles Aplos-local `shown`; a hidden calendar keeps its row with a hollow swatch and `--dim` name; the first state comes from Google `selected`. The owner checks this at the feature review.
6. **Colour source.** DESIGN §4.2 says a hash of the name with a manual override; Google supplies a hex per calendar; the legacy code keeps the host colour. **Read:** DESIGN wins: the engine resolves `colorTag` from a stable hash of `name` (with `accountId` as the tiebreak for equal names), and the override is stored by `Calendar/set`. Google's hex is ignored.
7. **Grid hours.** The mockup draws only 8 AM-8 PM; DESIGN says 56 px per hour "so 8 AM to 8 PM fits". **Read:** a 24-hour scrollable grid that opens scrolled to 8 AM (or to the earliest event that day if earlier). Pinch and ⌘-scroll change the hour height.
8. **Selecting an event by keyboard.** DESIGN §8 has Return, E and ⌫ but no key to choose an event; the day mockup uses ↑/↓. **Read:** ↑/↓ move through events in time order within the visible range in D and W, and Tab follows the grid order (§11 grid). ←/→ stay the period keys. Add these to the registry and the sheet.
9. **"Persisted" for Delete.** Persisted could mean stored locally or confirmed by Google. **Read:** a row that exists in the store, including a pending create (deleting it cancels the queued op). Only the unsaved draft in the editor or quick-create lacks Delete.
10. **Undo toast copy while an op is held.** The mockup says "Reply sent to Priya: Yes" during the 8 s window, before anything is sent. §7.13 separates pending from confirmed wording. **Read:** "Replying Yes to Priya · Undo Z" and "Event deleted · Undo Z" (the delete is local at once). One op, one notice (§7.13).
11. **⋯ items "hide" and "copy link".** These appear only in tooltips (`cal.js` `detail()`) and are not defined. **Read:** "copy link" copies `conference.url`, or `htmlLink` when there is no conference. "Hide" is dropped until the owner defines it. "Change your reply" reopens the RSVP block.
12. **One clock.** The today column, the now line, "next at 11:00 AM" and free gaps must agree with the fixture's `APLOS_NOW`. **Read:** the renderer reads time only through `useNow()`, and the harness sets both clocks (GAP-15).
13. **All-day and multi-day events.** DESIGN and the mockups draw none, the legacy code has an all-day lane row, and `events.all_day` exists. **Read:** an all-day strip under the day headers, using the same event style at 24 px height, with "+N" when more than 2 lanes. Owner copy and visual review.
14. **Day view lanes.** DESIGN says three or more overlapping events become the first lane plus "+N", and lanes are never under 44 px. The day mockup allows 6 lanes because the column is wide. **Read:** the rule is width-based: fold to "+N" only when a lane would drop below 44 px. Acceptance 6 ("at 44 px or wider") matches this.
15. **Day-view detail rail.** The mockup draws an always-visible 360 px rail; DESIGN §7.8 does not mention it. **Read:** keep it (the mockup is the visual target, and there is no conflict). Under 720 px it gives way to the narrow agenda.
16. **Week start.** The mockup starts on Sunday. **Read:** follow the macOS locale by default, with `Settings.ui.calendar.weekStart` as the override (GAP-14).
17. **Moving an event to another calendar or account.** The legacy code refuses a move between accounts; Google supports `events.move` within an account. **Read:** the editor's calendar picker lists calendars in the same account only for an existing event; any calendar for a new one.
18. **Free gaps (Today, `ui-ask`).** **Read:** gaps only between events from now to the last event today; events with `transparency: 'free'` or `myResponse: 'declined'` do not block; a gap shows only if it is 30 minutes or longer. Settle this with `ui-ask`.
19. **Two "Today" controls.** The pane-header calendar button ("Today, ⇧A", opens the dock) and the PageHead "Today" button (T, jumps to today) share a word on this screen. **Read:** keep both per DESIGN, with distinct accessible names, "Today in the dock" and "Go to today". The owner checks the copy.

## DESIGN vs mockup

| # | Mockup | DESIGN | Winner | Behaviour change |
|---|---|---|---|---|
| 1 | `<h1 class="page-title keep">October 2026</h1>`; NOTES row "Big month title" | §7.8: a small `title` label, "information, not a heading"; §7 "no page titles" | DESIGN | Yes. Render as a non-heading `title` label (15/22, 600). The range stays beside it |
| 2 | Grid is 8 AM-8 PM only (`H0=8, H1=20`) | 56 px per hour, so 8-20 fits (implies a full day that scrolls) | DESIGN | Yes. 24 h scrollable (UNCLEAR-7) |
| 3 | Day sub-label "Thursday, October 29" (no year) | Fixes: day titles "Sunday, October 25, 2026" | DESIGN where a day *title* appears (live region, detail heading, agenda group) | Small. The PageHead keeps the month label plus range |
| 4 | ↑/↓ select events (day view) | §8 has no selection key | Neither (gap in DESIGN) | Adopt ↑/↓ (UNCLEAR-8) |
| 5 | Settings → Keyboard's Calendar group lacks Return, Y/M/N, ⌥-click and zoom | §8 lists them | DESIGN | Generated sheet and Settings must include them |
| 6 | Day view allows 6 lanes; week folds at 2 lanes | 3+ overlapping → first lane + "+N"; never < 44 px | DESIGN read as width-based | None (UNCLEAR-14) |
| 7 | RSVP toast "Reply sent to Priya: Yes · Undo Z" while still undoable | §7.13 pending vs confirmed wording | DESIGN | Copy change (UNCLEAR-10) |
| 8 | Stack and event clicks show a toast with the event time | §7.13: no toasts for navigation | DESIGN | Mock artefact; open the detail instead |
| 9 | Day-view detail rail | not in §7.8 | Mockup (no conflict) | Built (UNCLEAR-15) |
| 10 | `.kbd.hint` "T" on Today, shown only in hints mode; "New event · N" keycap always shown on the empty line | §5 rule 17, §8 Discoverability (main actions always show their key) | Agree | None |
| 11 | Calendar colours fixed per calendar in `cal.js` | §4.2 hash of name + override | DESIGN | Engine resolves `colorTag` (UNCLEAR-6) |

Roadmap removals: round 1 is Google Calendar only (roadmap §0; plan 20 PV9 round-1 scope). CalDAV and Graph calendars are round 2, so no iCloud or Outlook calendar rows in demo or tests. No sky, airmail stripe, app icon or page titles appear on these pages.

## Harness scenarios and test list

**Scenarios used:** `demo` (the main one; extended per GAP-16), `empty` (no accounts: the Calendar route shows the no-accounts `EmptyLine`, never the grid), `offline` (moves queue with "Saved here · will sync"), `ai-off` (no plans on the grid), `ai-budget-spent` (plans already found still show; no new ones), `needs-reauth` (grid shows cached events; the status slot owns the message), `rate-limited` (mail paused, calendar unaffected).

**New scenarios:**
- `calendar-dense`: more than 200 occurrences in November.
- `calendar-paused`: Calendar `quotaExceeded` with an `until`.
- `calendar-no-scope`: account without `calendar.events`.
- `calendar-readonly`: adds a read-only Holidays calendar and a non-organizer event.
- `calendar-dst`: an event across 2026-11-01 and one in a foreign time zone.

**`Fixture/control` knobs:**
- `clock {set|advanceMs}`, mirrored to the renderer clock.
- `calendarChange {eventId|new, patch}`, a remote edit arriving.
- `failNextWrite {type:'Event', error: 'permanent'|'conflict'|'transient'}`.
- `setCalendarStatus {calendarId, state, until}`.
- `planFound {threadId}`.
- `providerCallLog`, to assert nothing left before `undoUntil`.

### Behaviour and DOM
- `week renders 7 columns Sun-Sat with today tinted` – the 2026-10-29 column has `today` and `aria-current="date"`; the others do not.
- `three overlapping events fold to first lane plus +N at ≥ 44 px` – the overlap state shows one `.ev.beside` and an `.ev-stack` "+2" whose width is ≥ 44 px (plan 30 U7 acc. 6).
- `stack opens a menu of the folded events in time order` – "2 more at 11:00 AM" with 2 items.
- `events under 30 minutes are one line, title only` – Standup has no time node.
- `plan renders dashed with From mail and is not an event` – `is-plan`, the label, and no `Event` row behind it until it is confirmed.
- `confirming a plan writes one event and removes the dashed block` – `Plan/confirm` is called once; the grid shows a solid event.
- `ai-off shows no plans` – zero `.is-plan`.
- `day empty shows Nothing scheduled with New event N` – exact copy and keycap; rail hidden.
- `day title carries the comma and year` – live region "Sunday, November 1, 2026. Nothing scheduled."
- `rsvp starts with nothing chosen and Send reply disabled` – no `aria-selected="true"`; the button is disabled (acc. 6).
- `choosing an answer enables Send reply; Return sends once` – exactly one `Event/rsvp` call with `response`.
- `RSVP on a repeating invite offers occurrence or series` – the scope dialog appears with two rows.
- `no Delete on an unsaved event` – the quick-create/editor draft has no Delete; a stored event has it in ⋯ (acc. 6).
- `delete is undoable for 8 s and nothing reaches Google before it` – the provider-call log is empty at 7.9 s; Z restores the event; at 8.1 s one delete is sent.
- `repeating event move asks This event / All events; following hidden` – two options while the capability is off.
- `moving a locked event does nothing` – drag on a non-organizer event leaves `start` unchanged and calls nothing.
- `rejected move returns the event with Couldn't move … Retry` – `failNextWrite` → original position, `ErrorLine`.
- `remote change arrives without moving a held event` – `calendarChange` during a drag applies after release.
- `month view never shows "1 more"` – any cell with 3 events shows 3 chips.
- `narrow pane under 720 px shows the agenda list` – no grid, the same events grouped by day.
- `invite row opens the invite thread` – O on Q4 review routes to the reader with the linked thread.
- `calendar list toggles and solos` – click hides Family's events; ⌥-click Work shows only Work.
- `colour tag follows hash with override` – Settings override changes the swatch and every block.
- `dense month stays complete` – `calendar-dense` November shows every event (no 200 cut).
- `DST event keeps its wall time` – an 11:00 weekly event stays at 11:00 across 2026-11-01.

### Keyboard paths
- `T D W M J K ← → switch views and periods` – each changes the label and range; M means Month when no invite is open.
- `Y M N answer only while an unanswered invite is open` – with the popover closed, M switches to Month.
- `Return opens, E edits, ⌫ deletes the selected event` – each only with a selection; ⌫ ignores locked events.
- `↑/↓ move the selection through events in time order` – it wraps at neither end.
- `N opens a new event on the default calendar` – the default comes from Settings or the last-used calendar.
- `Esc ladder closes popover, then the stack menu, then clears selection, never leaves Calendar`.
- `keys typed during a period slide are replayed` – 3 J presses within 100 ms move three weeks (§5 rule 4).
- `single-key switch off disables T/D/W/M/N/Y` – WCAG 2.1.4 setting.

### Visual states (both themes; harness §12.5)
- `calendar-week default|overlap|month` in light and dark.
- `calendar-day default|empty` in light and dark.
- `calendar-event detail|rsvp` in light and dark.
- `calendar narrow agenda` in light and dark.
- `calendar plan selected` in light and dark.
- `calendar drag lift` mid-gesture in light and dark.
- `calendar scope dialog` in light and dark.
- `calendar-readonly locked event` in light and dark.
- `calendar-paused` in light and dark.
- `sidebar MiniMonth + Calendars` with one calendar hidden and with solo, in light and dark.
- Zoom levels: hour height minimum and maximum after pinch.

### Accessibility
- `calendar exposes role grid with labelled cells` – axe clean; every event's accessible name is "title, time range, calendar"; a plan says "found in mail, not added yet".
- `stack button reports aria-expanded and count` – "2 more events at 11:00 AM".
- `period change announces politely` – the live region text matches the label and range.
- `RSVP choices are a labelled group with keys in tooltips` – "Your answer"; each has the Y/M/N tooltip.
- `focus never lost on view change or delete` – after ⌫, focus moves to the next event or the grid.
- `reduced motion: period slide and FLIP become ≤ 120 ms fades`.
- `200 % zoom at 900 px keeps the grid usable` – no text under 11 px; targets ≥ 24 px.
- VoiceOver manual pass on week, day, detail and RSVP (§11.7).

### Design checks
- `banned strings absent` – no "magic", "AI-powered", "smart", "Ask me anything", "Hold to talk", and no exclamation marks in calendar copy.
- `no sparkle, wand, star, brain or robot glyph` – plans use the mail icon only.
- `one filled button per surface` – the RSVP popover's "Send reply" is the only filled button; week, day and month have none (the today badge is not a button).
- `hover never shifts layout` – hovering every `.ev`, `.ev-stack`, mini-month day and calendar row moves no other box by more than 0.5 px.
- `contrast` – event title, time (light `--dim`, dark `--ink-2`) on the weakest fill; mini-month out-of-month `--dim`; "From mail" `--dim` on `--canvas`; the `--stamp` now line at 3:1 non-text; all in light, dark and Increase Contrast.
- `transform and opacity only` – `document.getAnimations()` during D/W/M, period slide, drag and FLIP touch only `transform` and `opacity` (plan 30 §4.3).
- `D|W|M puck does not animate width` (plan 30 U7).
