// Pending tests for lane `ui-calendar` (UI-screens thread, Phase 0, drafted 2026-10-27).
// Source: plans/ui-screens/map-calendar.md (test list) and plans/30-ui-revamp.md U7 acceptance (items 3, 6, 8 touch this lane).
// Each todo becomes a real test when the lane starts (day 5-6). Layer per group: node = pure logic (node:test),
// dom = Playwright on the browser preview with the stand-in engine, electron = hidden _electron, visual = harness screenshots in both themes.
// Stand-in scenarios used: demo, empty, offline, ai-off, ai-budget-spent, needs-reauth, rate-limited, calendar-dense, calendar-paused, calendar-no-scope, calendar-readonly, calendar-dst.
// Fixture/control knobs: clock {set|advanceMs}, calendarChange {eventId|new, patch}, failNextWrite {type:'Event', error}, setCalendarStatus {calendarId, state, until}, planFound {threadId}, providerCallLog.
import {describe, test} from 'node:test';

describe('ui-calendar: behaviour and DOM (dom)', () => {
  test.todo(`week renders 7 columns Sun-Sat with today tinted – the 2026-10-29 column has today and aria-current="date"; the others do not`);
  test.todo(`three overlapping events fold to first lane plus +N at ≥ 44 px – the overlap state shows one .ev.beside and an .ev-stack "+2" whose width is ≥ 44 px (plan 30 U7 acc. 6)`);
  test.todo(`stack opens a menu of the folded events in time order – "2 more at 11:00 AM" with 2 items`);
  test.todo(`events under 30 minutes are one line, title only – Standup has no time node`);
  test.todo(`plan renders dashed with From mail and is not an event – is-plan, the label, and no Event row behind it until it is confirmed`);
  test.todo(`confirming a plan writes one event and removes the dashed block – Plan/confirm is called once; the grid shows a solid event`);
  test.todo(`ai-off shows no plans – zero .is-plan`);
  test.todo(`day empty shows Nothing scheduled with New event N – exact copy and keycap; rail hidden`);
  test.todo(`day title carries the comma and year – live region "Sunday, November 1, 2026. Nothing scheduled." (U7 acc. 6, comma in day titles)`);
  test.todo(`rsvp starts with nothing chosen and Send reply disabled – no aria-selected="true"; the button is disabled (acc. 6)`);
  test.todo(`choosing an answer enables Send reply; Return sends once – exactly one Event/rsvp call with response`);
  test.todo(`RSVP on a repeating invite offers occurrence or series – the scope dialog appears with two rows`);
  test.todo(`no Delete on an unsaved event – the quick-create/editor draft has no Delete; a stored event has it in ⋯ (acc. 6)`);
  test.todo(`delete is undoable for 8 s and nothing reaches Google before it – the provider-call log is empty at 7.9 s; Z restores the event; at 8.1 s one delete is sent`);
  test.todo(`repeating event move asks This event / All events; following hidden – two options while the capability is off`);
  test.todo(`moving a locked event does nothing – drag on a non-organizer event leaves start unchanged and calls nothing`);
  test.todo(`rejected move returns the event with Couldn't move … Retry – failNextWrite → original position, ErrorLine`);
  test.todo(`remote change arrives without moving a held event – calendarChange during a drag applies after release`);
  test.todo(`month view never shows "1 more" – any cell with 3 events shows 3 chips`);
  test.todo(`narrow pane under 720 px shows the agenda list – no grid, the same events grouped by day`);
  test.todo(`invite row opens the invite thread – O on Q4 review routes to the reader with the linked thread`);
  test.todo(`calendar list toggles and solos – click hides Family's events; ⌥-click Work shows only Work`);
  test.todo(`colour tag follows hash with override – Settings override changes the swatch and every block`);
  test.todo(`dense month stays complete – calendar-dense November shows every event (no 200 cut)`);
  test.todo(`DST event keeps its wall time – an 11:00 weekly event stays at 11:00 across 2026-11-01`);
});

describe('ui-calendar: keyboard paths (dom)', () => {
  test.todo(`T D W M J K ← → switch views and periods – each changes the label and range; M means Month when no invite is open`);
  test.todo(`Y M N answer only while an unanswered invite is open – with the popover closed, M switches to Month`);
  test.todo(`Return opens, E edits, ⌫ deletes the selected event – each only with a selection; ⌫ ignores locked events`);
  test.todo(`↑/↓ move the selection through events in time order – it wraps at neither end`);
  test.todo(`N opens a new event on the default calendar – the default comes from Settings or the last-used calendar`);
  test.todo(`Esc ladder closes popover, then the stack menu, then clears selection, never leaves Calendar`);
  test.todo(`keys typed during a period slide are replayed – 3 J presses within 100 ms move three weeks (section 5 rule 4)`);
  test.todo(`single-key switch off disables T/D/W/M/N/Y – WCAG 2.1.4 setting`);
});

describe('ui-calendar: visual states, light and dark (visual, harness section 12.5)', () => {
  test.todo(`calendar-week default|overlap|month in light and dark`);
  test.todo(`calendar-day default|empty in light and dark`);
  test.todo(`calendar-event detail|rsvp in light and dark`);
  test.todo(`calendar narrow agenda in light and dark`);
  test.todo(`calendar plan selected in light and dark`);
  test.todo(`calendar drag lift mid-gesture in light and dark`);
  test.todo(`calendar scope dialog in light and dark`);
  test.todo(`calendar-readonly locked event in light and dark`);
  test.todo(`calendar-paused in light and dark`);
  test.todo(`sidebar MiniMonth + Calendars with one calendar hidden and with solo, in light and dark`);
  test.todo(`zoom levels – hour height minimum and maximum after pinch`);
});

describe('ui-calendar: accessibility (dom)', () => {
  test.todo(`calendar exposes role grid with labelled cells – axe clean; every event's accessible name is "title, time range, calendar"; a plan says "found in mail, not added yet"`);
  test.todo(`stack button reports aria-expanded and count – "2 more events at 11:00 AM"`);
  test.todo(`period change announces politely – the live region text matches the label and range`);
  test.todo(`RSVP choices are a labelled group with keys in tooltips – "Your answer"; each has the Y/M/N tooltip`);
  test.todo(`focus never lost on view change or delete – after ⌫, focus moves to the next event or the grid`);
  test.todo(`reduced motion: period slide and FLIP become ≤ 120 ms fades`);
  test.todo(`200 % zoom at 900 px keeps the grid usable – no text under 11 px; targets ≥ 24 px`);
  test.todo(`VoiceOver manual pass on week, day, detail and RSVP – hands-on (section 11.7)`);
});

describe('ui-calendar: design checks (dom / visual)', () => {
  test.todo(`banned strings absent – no "magic", "AI-powered", "smart", "Ask me anything", "Hold to talk", and no exclamation marks in calendar copy`);
  test.todo(`no sparkle, wand, star, brain or robot glyph – plans use the mail icon only`);
  test.todo(`one filled button per surface – the RSVP popover's "Send reply" is the only filled button; week, day and month have none (the today badge is not a button)`);
  test.todo(`hover never shifts layout – hovering every .ev, .ev-stack, mini-month day and calendar row moves no other box by more than 0.5 px`);
  test.todo(`contrast – event title, time (light --dim, dark --ink-2) on the weakest fill; mini-month out-of-month --dim; "From mail" --dim on --canvas; the --stamp now line at 3:1 non-text; all in light, dark and Increase Contrast`);
  test.todo(`transform and opacity only – document.getAnimations() during D/W/M, period slide, drag and FLIP touch only transform and opacity (plan 30 section 4.3)`);
  test.todo(`D|W|M puck does not animate width – (plan 30 U7)`);
});
