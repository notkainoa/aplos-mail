import { BubbleIcon, CheckIcon, ClockIcon, MoreIcon, ReplyIcon } from './Icons';

type Row = { sender: string; due?: string; subject: string; when: string };

export const homeRows: Row[] = [
  { sender: 'Maya Chen', due: 'Thu', subject: 'Saturday in the community garden', when: 'Nov 13' },
  {
    sender: 'Maple Library',
    due: 'Fri',
    subject: 'Your holds are ready to collect',
    when: 'Nov 13',
  },
  { sender: 'Sam Rivera', subject: 'Cabin weekend: a few loose ends', when: '8:32 PM' },
];

const heroRows: Row[] = [
  { sender: 'Maya Chen', due: 'Thu', subject: 'Saturday in the community garden', when: 'Nov 13' },
  {
    sender: 'Maple Library',
    due: 'Fri',
    subject: 'Your holds are ready to collect',
    when: 'Nov 13',
  },
  { sender: 'Theo Kim', subject: 'Friday review: agenda and room', when: '8:32 PM' },
];

type Focus = { sender: string; due: string; time: string; text: string; serif?: boolean };

const subjectFocus: Focus = {
  sender: 'Jordan Park',
  due: 'Wed',
  time: '9:17 PM',
  text: 'A quieter home for our project',
};

export const summaryFocus: Focus = {
  sender: 'Theo Kim',
  due: 'Fri',
  time: '8:32 PM',
  text: 'Theo needs the room for Friday’s review confirmed by tomorrow.',
  serif: true,
};

function DueChip({ day }: { day: string }) {
  return (
    <span className="chip">
      <ClockIcon />
      {day}
    </span>
  );
}

function FocusCard({ focus }: { focus: Focus }) {
  return (
    <div className="focus-card">
      <div className="focus-meta">
        <span className="focus-sender">{focus.sender}</span>
        <DueChip day={focus.due} />
        <span className="focus-time">{focus.time}</span>
      </div>
      <p className={focus.serif ? 'focus-summary' : 'focus-subject'}>{focus.text}</p>
      <div className="focus-actions">
        <span className="mock-filled">
          <ReplyIcon />
          Reply
          <kbd className="kbd kbd-on-fill">Space</kbd>
        </span>
        <span className="mock-spacer" />
        <span className="mock-text">
          <ClockIcon />
          Later
          <kbd className="kbd">←</kbd>
        </span>
        <span className="mock-text">
          <CheckIcon />
          Done
          <kbd className="kbd">→</kbd>
        </span>
        <span className="mock-icon">
          <MoreIcon />
        </span>
      </div>
    </div>
  );
}

function MailRow({ row }: { row: Row }) {
  return (
    <li className="mail-row">
      <span className="row-sender">{row.sender}</span>
      <span className="row-subject">
        {row.due ? <DueChip day={row.due} /> : null}
        <span className="row-text">{row.subject}</span>
      </span>
      <span className="row-when">{row.when}</span>
    </li>
  );
}

type HomeMockProps = {
  focus?: Focus;
  rows?: Row[];
  plain?: boolean;
  summaryOnly?: boolean;
  className?: string;
};

/** A small, static copy of Home: the section label, the focus card and the next rows. */
export function HomeMock({
  focus = subjectFocus,
  rows = heroRows,
  plain,
  summaryOnly,
  className = '',
}: HomeMockProps) {
  if (summaryOnly) {
    return (
      <div className={`mock mock-home mock-solo ${className}`} aria-hidden="true">
        <FocusCard focus={focus} />
      </div>
    );
  }
  return (
    <div className={`mock mock-home ${plain ? 'mock-plain' : ''} ${className}`} aria-hidden="true">
      <div className="home-head">
        <span className="home-label">
          Do now <span className="home-count">6</span>
        </span>
        <span className="home-link">Go one by one</span>
      </div>
      <FocusCard focus={focus} />
      <ul className="mail-rows">
        {rows.map(row => (
          <MailRow key={row.sender} row={row} />
        ))}
      </ul>
      <div className="low-band">
        <span className="low-label">Low importance</span>
        <span className="low-names">Weekly Digest, Parcel Trail and Book Nook</span>
        <span className="low-count">3</span>
      </div>
    </div>
  );
}

/** A static copy of the Ask dock: one question, one answer with its source. */
export function AskMock() {
  return (
    <div className="mock mock-ask" aria-hidden="true">
      <div className="ask-head">
        <BubbleIcon />
        Ask
      </div>
      <div className="ask-thread">
        <p className="ask-question">What is still open for the cabin weekend?</p>
        <div className="ask-answer">
          <p>
            Two things. Sam is asking who brings groceries, and whether Theo can drive on Friday
            afternoon.
          </p>
          <span className="ask-source">
            <span className="ask-source-from">Sam Rivera</span>
            Cabin weekend: a few loose ends
          </span>
        </div>
      </div>
      <div className="ask-field">
        <span>Ask about your mail or calendar</span>
        <kbd className="kbd">A</kbd>
      </div>
    </div>
  );
}

type Key = { cap: string; does: string };

const keys: Key[] = [
  { cap: 'Space', does: 'Main action' },
  { cap: '→', does: 'Done' },
  { cap: '←', does: 'Later' },
  { cap: 'Z', does: 'Undo' },
  { cap: 'B', does: 'Bookmark' },
  { cap: 'C', does: 'Compose' },
  { cap: 'A', does: 'Ask or dictate' },
  { cap: '?', does: 'All shortcuts' },
];

/** The keyboard map as one list: the cap, then what it does, in reading order. */
export function KeyList() {
  return (
    <ul className="key-grid" data-claim="key-list">
      {keys.map(item => (
        <li key={item.cap} className="key-item">
          <kbd className="cap">{item.cap}</kbd>
          <span>{item.does}</span>
        </li>
      ))}
    </ul>
  );
}

type Choice = { feature: string; provider: string; where?: string };

const choices: Choice[] = [
  { feature: 'Ask', provider: 'Groq' },
  { feature: 'Summaries', provider: 'Ollama', where: 'on this Mac' },
  { feature: 'Drafts', provider: 'Groq' },
  { feature: 'Plans', provider: 'Groq' },
  { feature: 'Voice', provider: 'Groq' },
];

/** A static copy of Settings → AI: one provider per feature. */
export function ProviderMock() {
  return (
    <div className="mock mock-ai" aria-hidden="true">
      <div className="ai-head">
        <span>Settings</span>
        <span className="ai-crumb">AI</span>
      </div>
      <ul className="ai-rows">
        {choices.map(choice => (
          <li key={choice.feature} className="ai-row">
            <span className="ai-feature">{choice.feature}</span>
            <span className="ai-select">
              {choice.provider}
              {choice.where ? <span className="ai-where">{choice.where}</span> : null}
              <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
                <path
                  d="m2.5 4 2.5 2.5L7.5 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const dayEvents = [
  { title: 'Friday review', time: '11:00 AM', top: 1, tall: 1, tone: 'blue' },
  { title: 'Cabin planning', time: '1:00 PM', top: 3, tall: 1, tone: 'sand' },
];

const hours = ['10 AM', '11 AM', '12 PM', '1 PM'];

/** A phone-sized day view of Friday, in the calendar's style. Shown instead of the wide crop. */
export function CalendarDayMock() {
  return (
    <div className="mock mock-day" aria-hidden="true">
      <div className="day-head">
        <span className="day-title">Friday 20</span>
        <span className="day-sub">November 2026</span>
      </div>
      <div className="day-grid">
        {hours.map(hour => (
          <div key={hour} className="day-hour">
            <span>{hour}</span>
          </div>
        ))}
        {dayEvents.map(event => (
          <div
            key={event.title}
            className={`day-event day-${event.tone}`}
            style={{ top: `${event.top * 64}px`, height: `${event.tall * 64 - 4}px` }}
          >
            <strong>{event.title}</strong>
            <span>{event.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type WeekEvent = { day: number; start: number; len: number; title: string; tone: string };

const weekDays = ['Sun 15', 'Mon 16', 'Tue 17', 'Wed 18', 'Thu 19', 'Fri 20', 'Sat 21'];
const weekHours = ['9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM'];

const weekEvents: WeekEvent[] = [
  { day: 1, start: 0.5, len: 1, title: 'Standup', tone: 'blue' },
  { day: 1, start: 3, len: 1, title: 'Lunch with Maya', tone: 'sand' },
  { day: 2, start: 1, len: 1.5, title: 'Pottery class', tone: 'sand' },
  { day: 3, start: 0, len: 1, title: 'Library holds', tone: 'blue' },
  { day: 4, start: 5, len: 1, title: 'Design critique', tone: 'blue' },
  { day: 5, start: 2, len: 1, title: 'Friday review', tone: 'blue' },
  { day: 5, start: 4, len: 1, title: 'Cabin planning', tone: 'sand' },
];

/** A static week view for wide screens: events sit inside their own day column. */
export function CalendarWeekMock() {
  return (
    <div className="mock mock-week" aria-hidden="true">
      <div className="week-head">
        <span className="day-title">November 2026</span>
        <span className="day-sub">November 15 to 21</span>
      </div>
      <div className="week-cols">
        <div className="week-hours">
          {weekHours.map(hour => (
            <span key={hour}>{hour}</span>
          ))}
        </div>
        {weekDays.map((name, index) => (
          <div key={name} className={`week-col ${index === 1 ? 'week-today' : ''}`}>
            <span className="week-name">{name}</span>
            {weekHours.map(hour => (
              <i key={hour} className="week-line" />
            ))}
            {weekEvents
              .filter(event => event.day === index)
              .map(event => (
                <div
                  key={event.title}
                  className={`week-event day-${event.tone}`}
                  style={{ top: `${44 + event.start * 44}px`, height: `${event.len * 44 - 3}px` }}
                >
                  {event.title}
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
