// Run: cd apps/desktop && TZ=America/Los_Angeles npx tsx --test tests/ui-calendar/*.test.ts*
// CalendarScreen drawn with react-dom/server from the model's view model (no DOM): the DOM facts of the pending list
// that a static render can prove. Popovers, menus and the measured agenda switch need layout; the preview gallery's
// capture script (screens/calendar/preview/shoot.mjs) checks those headlessly.
import './tz';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HARNESS_NOW_MS } from '../../src/renderer/data';
import { copyProblem } from '../../src/renderer/commands/internal';
import {
  defaultCalendarId,
  draftFromEvent,
  entriesFor,
  initialState,
  periodOf,
  shownView,
  viewModel,
  type CalendarContext,
  type CalendarState,
} from '../../src/renderer/screens/calendar/calendar.model';
import { CalendarScreen } from '../../src/renderer/screens/calendar/CalendarScreen';
import { calendarSidebar } from '../../src/renderer/screens/calendar/sidebar';
import { demoWorld } from '../../src/renderer/screens/calendar/preview/states';

const THU = '2026-10-29';
const { calendars, events, plans } = demoWorld;

function ctxFor(state: CalendarState): CalendarContext {
  const period = periodOf(shownView(state), state.anchor, 0);
  const def = defaultCalendarId(calendars);
  return {
    now: HARNESS_NOW_MS,
    weekStartsOn: 0,
    entries: entriesFor({ events, plans, calendars, solo: state.solo, period, planCalendarId: def }),
    events: new Map(events.map(e => [e.id, e])),
    plans: new Map(plans.map(p => [p.id, p])),
    calendars,
    defaultCalendarId: def,
  };
}

function draw(over: Partial<CalendarState>): string {
  const state = { ...initialState(THU), ...over };
  return renderToStaticMarkup(<CalendarScreen vm={viewModel(state, ctxFor(state))} dispatch={() => undefined} />);
}

/** Visible copy of a render: text nodes plus aria-label, title and placeholder values. */
function copyOf(markup: string): string[] {
  const decode = (s: string) =>
    s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const attrs = [...markup.matchAll(/(?:aria-label|title|placeholder)="([^"]*)"/g)].map(m => decode(m[1]));
  const text = markup.replace(/<[^>]+>/g, '\n').split('\n').map(t => decode(t.trim())).filter(Boolean);
  return [...attrs, ...text];
}

describe('ui-calendar: the screen, drawn statically', () => {
  test('week renders 7 columns Sun-Sat with today tinted – the 2026-10-29 column has today and aria-current="date"; the others do not', () => {
    const html = draw({ view: 'week' });
    const heads = [...html.matchAll(/role="columnheader"[^>]*aria-label="([^"]+)"/g)].map(m => m[1]);
    assert.equal(heads.length, 7);
    assert.equal(heads[0], 'Sunday, October 25, 2026');
    assert.equal(heads[6], 'Saturday, October 31, 2026');
    assert.equal((html.match(/aria-current="date"/g) ?? []).length, 1);
    assert.match(html, /data-today="true"[^>]*aria-label="Thursday, October 29, 2026"[^>]*aria-current="date"/);
    assert.match(html, /role="grid" aria-label="Week of Sunday, October 25, 2026"/);
  });

  test('the date label is a small title with the range, never a page title, and the week has no filled button', () => {
    const html = draw({ view: 'week' });
    assert.match(html, /ui-page-head__date-label">October 2026</);
    assert.match(html, /ui-page-head__date-range">October 25 – 31</);
    assert.doesNotMatch(html, /<h1/);
    assert.doesNotMatch(html, /data-variant="filled"/);
    assert.match(html, /aria-label="Previous week"/);
    assert.match(html, /role="tablist"[^>]*aria-label="View"|aria-label="View"[^>]*role="tablist"/);
  });

  test('events under 30 minutes are one line, title only – Standup has no time node', () => {
    const html = draw({ view: 'week' });
    const standup = html.match(/<button[^>]*data-density="tiny"[^>]*>(.*?)<\/button>/);
    assert.ok(standup, 'a tiny block exists');
    assert.match(standup[1], /Standup/);
    assert.doesNotMatch(standup[1], /ui-event-block__time/);
  });

  test('plan renders dashed with From mail and is not an event', () => {
    const html = draw({ view: 'week' });
    assert.match(html, /class="ui-plan-outline"[^>]*data-kind="plan"/);
    assert.match(html, /found in mail, not added yet/);
    assert.match(html, /From mail/);
  });

  test('day empty shows Nothing scheduled with New event N – exact copy and keycap; rail hidden', () => {
    const html = draw({ view: 'day', anchor: '2026-11-01' });
    assert.match(html, /Nothing scheduled\./);
    assert.match(html, /New event<kbd class="ui-cal-kbd">N<\/kbd>/);
    assert.doesNotMatch(html, /cal-screen__rail/);
    assert.match(html, /aria-label="Sunday, November 1, 2026\. Nothing scheduled\."/);
  });

  test('day view shows the detail rail on the selected event, defaulting to the first', () => {
    const chosen = draw({ view: 'day', selectedId: 'design' });
    assert.match(chosen, /cal-screen__rail[^>]*aria-label="Event details"/);
    assert.match(chosen, /ui-event-detail__title"[^>]*>Design review with Mina and Jordan</);
    const first = draw({ view: 'day' });
    assert.match(first, /ui-event-detail__title"[^>]*>Northwind Dental</);
  });

  test('rsvp starts with nothing chosen and Send reply disabled – no aria-checked="true"; the button is disabled (acc. 6)', () => {
    const html = draw({ view: 'day', anchor: '2026-10-30', selectedId: 'q4' });
    const rsvp = html.slice(html.indexOf('ui-event-detail__rsvp'));
    assert.match(rsvp, /role="radiogroup"/);
    assert.doesNotMatch(rsvp, /aria-checked="true"/);
    assert.match(rsvp, /data-variant="filled" disabled="">Send reply/);
    const chosen = draw({
      view: 'day',
      anchor: '2026-10-30',
      selectedId: 'q4',
      rsvp: { eventId: 'q4', answer: 'yes', changing: false },
    });
    assert.match(chosen, /aria-checked="true"[^>]*>Yes</);
    assert.doesNotMatch(chosen, /disabled="">Send reply/);
  });

  test('RSVP choices are a labelled group with keys in tooltips – Y, M and N from the registry', () => {
    const html = draw({ view: 'day', anchor: '2026-10-30', selectedId: 'q4' });
    assert.match(html, /title="Yes · Y"/);
    assert.match(html, /title="Maybe · M"/);
    assert.match(html, /title="No · N"/);
  });

  test('no Delete on an unsaved event – the editor for a new event has none; an existing one has it', () => {
    const fresh = draw({ view: 'week', editor: { ...draftFromEvent(events.find(e => e.id === 'design')!), mode: 'new', eventId: undefined, persisted: false } });
    assert.match(fresh, /New event/);
    assert.doesNotMatch(fresh, />Delete</);
    const existing = draw({ view: 'week', editor: draftFromEvent(events.find(e => e.id === 'design')!) });
    assert.match(existing, /Edit event/);
    assert.match(existing, />Delete</);
    assert.equal((existing.match(/data-variant="filled"/g) ?? []).length, 1, 'Save is the dialog’s one filled button');
  });

  test('month view shows six weeks with "2 more", never "1 more"', () => {
    const html = draw({ view: 'month' });
    assert.equal((html.match(/role="row"/g) ?? []).length, 7);
    assert.match(html, /aria-label="2 more events on Thursday, October 29, 2026"/);
    assert.doesNotMatch(html, />1 more</);
    assert.match(html, /ui-page-head__date-range">\d+ events</);
  });

  test('narrow pane under 720 px shows the agenda list – no grid, the same events grouped by day', () => {
    const html = draw({ view: 'week', paneWidth: 660 });
    assert.doesNotMatch(html, /role="grid"/);
    assert.match(html, /Sunday, October 25, 2026/);
    assert.match(html, /Brunch with Mom/);
  });

  test('banned strings absent – every string the screen draws passes DESIGN 10, with no sparkle, wand or star', () => {
    const states: Array<Partial<CalendarState>> = [
      { view: 'week' },
      { view: 'day', selectedId: 'design' },
      { view: 'day', anchor: '2026-10-30', selectedId: 'q4' },
      { view: 'day', anchor: '2026-11-01' },
      { view: 'month' },
      { view: 'week', paneWidth: 600 },
      { view: 'week', editor: draftFromEvent(events.find(e => e.id === 'design')!) },
    ];
    for (const s of states) {
      const html = draw(s);
      for (const line of copyOf(html)) assert.equal(copyProblem(line), null, line);
      assert.doesNotMatch(html, /sparkle|wand|lucide-star|backdrop-filter|gradient/i);
    }
  });

  test('the sidebar data: the mini month follows the anchor with the week on the puck; the legend solos', () => {
    const state = { ...initialState(THU), solo: 'work' };
    const seen: unknown[] = [];
    const side = calendarSidebar({
      state,
      calendars,
      entries: ctxFor(state).entries,
      today: THU,
      weekStartsOn: 0,
      dispatch: a => seen.push(a),
    });
    assert.equal(side.miniMonth.month, '2026-10');
    assert.deepEqual(side.miniMonth.range, { start: '2026-10-25', end: '2026-10-31' });
    assert.ok(side.miniMonth.marks?.includes(THU));
    assert.deepEqual(side.calendarList.calendars.map(c => [c.name, c.visible]), [
      ['Work', true],
      ['Personal', false],
      ['Hollow Creek', false],
      ['Family', false],
    ]);
    side.calendarList.onSolo('work');
    side.miniMonth.onPick('2026-11-12');
    assert.deepEqual(seen, [
      { type: 'soloCalendar', id: 'work' },
      { type: 'pick', date: '2026-11-12' },
    ]);
  });
});
