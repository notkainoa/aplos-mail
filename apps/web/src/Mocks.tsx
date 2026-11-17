import { ActionGlyph, type ActionIcon } from './Icons';

// Static HTML copies of parts of the app, on original demo data. Summaries appear only here and in the working
// demos, never painted onto a screenshot: the screenshots are taken with AI off.

type Suggestion = { sender: string; summary: string; verb: string; icon: ActionIcon };

const suggestions: Suggestion[] = [
  {
    sender: 'Drew',
    summary: 'The October illustrations are finished, and Drew needs the invoice approved.',
    verb: 'View invoice',
    icon: 'paperclip',
  },
  {
    sender: 'Maya Chen',
    summary: 'Maya is planning Saturday in the community garden and asks if you can come at 10.',
    verb: 'Plan Saturday',
    icon: 'calendar',
  },
  {
    sender: 'Sam Rivera',
    summary: 'The cabin is booked for the weekend, and nothing is needed from you.',
    verb: 'Done',
    icon: 'check',
  },
];

type Face = { verb: string; icon: ActionIcon };

/** What the app's filled button shows: the action's icon, its verb and the Space keycap. */
export function ActionButtonFace({ verb, icon }: Face) {
  return (
    <>
      <ActionGlyph icon={icon} />
      {verb}
      <kbd className="kbd kbd-on-fill">Space</kbd>
    </>
  );
}

function ActionButton(face: Face) {
  return (
    <span className="app-filled">
      <ActionButtonFace {...face} />
    </span>
  );
}

function SuggestionCard({ item }: { item: Suggestion }) {
  return (
    <li className="suggest-card">
      <span className="suggest-sender">{item.sender}</span>
      <p className="suggest-summary">{item.summary}</p>
      <ActionButton verb={item.verb} icon={item.icon} />
    </li>
  );
}

/** Three focus cards whose main button names a different next step. */
export function SuggestionCards() {
  return (
    <ul className="suggest-cards" aria-hidden="true">
      {suggestions.map(item => (
        <SuggestionCard key={item.sender} item={item} />
      ))}
    </ul>
  );
}

type DayEvent = { title: string; time: string; top: number; tone: 'sky' | 'sand' };

const dayEvents: DayEvent[] = [
  { title: 'Friday review', time: '11:00 AM', top: 1, tone: 'sky' },
  { title: 'Cabin planning', time: '1:00 PM', top: 3, tone: 'sand' },
];

const dayHours = ['10 AM', '11 AM', '12 PM', '1 PM'];

/** A phone-sized day view of Friday, in the calendar's style. Shown instead of the week on phones. */
export function CalendarDayMock() {
  return (
    <div className="cal cal-day" aria-hidden="true">
      <div className="cal-head">
        <span className="cal-title">Friday 20</span>
        <span className="cal-sub">November 2026</span>
      </div>
      <div className="day-grid">
        {dayHours.map(hour => (
          <div key={hour} className="day-hour">
            <span>{hour}</span>
          </div>
        ))}
        {dayEvents.map(event => (
          <div
            key={event.title}
            className={`cal-event day-event tone-${event.tone}`}
            style={{ '--row': event.top } as React.CSSProperties}
          >
            <strong>{event.title}</strong>
            <span>{event.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type WeekEvent = { day: number; start: number; len: number; title: string; tone: 'sky' | 'sand' };

const weekDays = ['Sun 15', 'Mon 16', 'Tue 17', 'Wed 18', 'Thu 19', 'Fri 20', 'Sat 21'];
const weekHours = ['9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM'];
const TODAY = 1;

const weekEvents: WeekEvent[] = [
  { day: 1, start: 0.5, len: 1, title: 'Standup', tone: 'sky' },
  { day: 1, start: 3, len: 1, title: 'Lunch with Maya', tone: 'sand' },
  { day: 2, start: 1, len: 1.5, title: 'Pottery class', tone: 'sand' },
  { day: 3, start: 0, len: 1, title: 'Library holds', tone: 'sky' },
  { day: 4, start: 4, len: 1, title: 'Design critique', tone: 'sky' },
  { day: 5, start: 2, len: 1, title: 'Friday review', tone: 'sky' },
  { day: 5, start: 4, len: 1, title: 'Cabin planning', tone: 'sand' },
];

function WeekColumn({ name, index }: { name: string; index: number }) {
  const events = weekEvents.filter(event => event.day === index);
  return (
    <div className={`week-col${index === TODAY ? ' is-today' : ''}`}>
      <span className="week-name">{name}</span>
      {weekHours.map((hour, line) => (
        <i key={hour} className="week-line" style={{ '--n': line } as React.CSSProperties} />
      ))}
      {events.map(event => (
        <div
          key={event.title}
          className={`cal-event week-event tone-${event.tone}`}
          style={{ '--start': event.start, '--len': event.len } as React.CSSProperties}
        >
          {event.title}
        </div>
      ))}
    </div>
  );
}

/** A week view for wide screens. Blue and sand are two Google accounts' calendars. */
export function CalendarWeekMock() {
  return (
    <div className="cal cal-week" aria-hidden="true">
      <div className="cal-head">
        <span className="cal-title">November 2026</span>
        <span className="cal-sub">November 15 to 21</span>
      </div>
      <div className="week-grid">
        <div className="week-hours">
          {weekHours.map(hour => (
            <span key={hour}>{hour}</span>
          ))}
        </div>
        {weekDays.map((name, index) => (
          <WeekColumn key={name} name={name} index={index} />
        ))}
      </div>
    </div>
  );
}
