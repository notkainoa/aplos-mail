/** Small HTML stand-ins for parts of the app, drawn in the site's style. Demo content only. */

function Kbd({ children }: { children: string }) {
  return <kbd className="b-kbd">{children}</kbd>;
}

const rows = [
  { from: 'Jordan Park', subject: 'A quieter home for our project', when: '9:17 PM' },
  { from: 'Maya Chen', subject: 'Saturday in the community garden', when: 'Nov 13' },
  { from: 'Maple Library', subject: 'Your holds are ready to collect', when: 'Nov 13' },
  { from: 'Theo Kim', subject: 'Friday review: agenda and room', when: '8:32 PM' },
  { from: 'Sam Rivera', subject: 'Cabin weekend: a few loose ends', when: 'Nov 13' },
  { from: 'Rowan Pottery', subject: 'A place opened in the evening class', when: 'Nov 12' },
];

type Focus = { from: string; time: string; subject: string; summary: string };

const jordan: Focus = {
  from: 'Jordan Park',
  time: '9:17 PM',
  subject: 'A quieter home for our project',
  summary: 'Jordan wants your pick between two layouts by tomorrow.',
};

const maya: Focus = {
  from: 'Maya Chen',
  time: 'Nov 13',
  subject: 'Saturday in the community garden',
  summary: 'Maya asks if you can bring tools on Saturday morning.',
};

function FocusCard({ focus }: { focus: Focus }) {
  return (
    <div className="b-focus">
      <div className="b-focus-top">
        <span className="b-focus-from">{focus.from}</span>
        <span className="b-focus-time">{focus.time}</span>
      </div>
      <p className="b-focus-subject">{focus.subject}</p>
      <p className="b-summary b-summary-lg">{focus.summary}</p>
      <div className="b-focus-actions">
        <span className="b-reply">
          Reply <Kbd>Space</Kbd>
        </span>
        <span className="b-action">
          Later <Kbd>←</Kbd>
        </span>
        <span className="b-action">
          Done <Kbd>→</Kbd>
        </span>
      </div>
    </div>
  );
}

/** The hero's phone-width stand-in for the app window: one email in focus. */
export function HeroCard() {
  return (
    <figure className="b-hero-card" aria-label="Jordan Park's email in focus on Home">
      <FocusCard focus={jordan} />
    </figure>
  );
}

/** Home: one email in focus, the rest of Do now beneath it. */
export function HomeMock() {
  return (
    <figure
      className="b-mock"
      aria-label="Home with Maya Chen's email in focus and more emails under Do now"
    >
      <div className="b-mock-head">
        <span>
          <strong>Do now</strong> <span className="b-dim">6</span>
        </span>
        <span className="b-dim">Go one by one</span>
      </div>
      <FocusCard focus={maya} />
      <ul className="b-rows">
        {rows
          .filter(row => row.from !== 'Maya Chen')
          .map(row => (
            <li
              key={row.from}
              className={
                row.from === 'Jordan Park' || row.from === 'Maple Library'
                  ? undefined
                  : 'b-row-extra'
              }
            >
              <span className="b-row-from">{row.from}</span>
              <span className="b-row-subject">{row.subject}</span>
              <span className="b-dim">{row.when}</span>
            </li>
          ))}
      </ul>
      <div className="b-low">
        <span className="b-low-label">Low importance</span>
        <span className="b-dim b-low-names">Weekly Digest, Parcel Trail and Book Nook</span>
        <span className="b-dim">3</span>
      </div>
    </figure>
  );
}

/** Ask: a question, a serif answer and the messages it used. */
export function AskMock() {
  return (
    <figure
      className="b-mock b-ask"
      aria-label="Ask answering a question about Friday's review and citing two emails"
    >
      <p className="b-ask-q">When is the Friday review, and what should I bring?</p>
      <p className="b-summary b-ask-a">
        Friday at 10 AM in the small room. Theo asks everyone to bring their pick of the two layouts
        Jordan shared.
      </p>
      <ul className="b-cites">
        <li>
          <span className="b-cite-n">1</span> Theo Kim{' '}
          <span className="b-dim">Friday review: agenda and room</span>
        </li>
        <li>
          <span className="b-cite-n">2</span> Jordan Park{' '}
          <span className="b-dim">A quieter home for our project</span>
        </li>
      </ul>
      <div className="b-ask-field">
        <span className="b-dim">Ask about your mail or calendar</span>
        <Kbd>A</Kbd>
      </div>
    </figure>
  );
}

const mainKeys = [
  { key: 'Space', label: 'Main action' },
  { key: '←', label: 'Later' },
  { key: '→', label: 'Done' },
  { key: 'Z', label: 'Undo' },
];

const moreKeys = [
  { key: 'B', label: 'Bookmark' },
  { key: 'A', label: 'Ask, hold to dictate' },
  { key: 'C', label: 'Compose' },
  { key: '?', label: 'Shortcuts' },
];

/** The four keys that clear a list, then the rest in a short line. */
export function KeyGrid() {
  return (
    <div className="b-keys" data-claim="key-list">
      <ul className="b-keys-main">
        {mainKeys.map(k => (
          <li key={k.key}>
            <kbd className="b-cap">{k.key}</kbd>
            <span>{k.label}</span>
          </li>
        ))}
      </ul>
      <ul className="b-keys-more">
        {moreKeys.map(k => (
          <li key={k.key}>
            <kbd className="b-kbd">{k.key}</kbd>
            <span>{k.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Calendar: three days of the week, the Thursday events and a proposed one awaiting confirmation. */
export function CalendarMock() {
  return (
    <figure
      className="b-mock b-cal-mock"
      aria-label="Calendar for Wednesday to Friday with a design critique and a dentist visit on Thursday, and a proposed event waiting for confirmation on Friday"
    >
      <p className="b-mock-head">
        <strong>November 2026</strong>
        <span className="b-dim">Nov 15 – 21</span>
      </p>
      <div className="b-week">
        <div className="b-day">
          <p className="b-day-name">
            Wed <strong>18</strong>
          </p>
        </div>
        <div className="b-day">
          <p className="b-day-name">
            Thu <strong>19</strong>
          </p>
          <span className="b-event b-event-blue">
            Design critique <span className="b-dim">2 PM</span>
          </span>
          <span className="b-event b-event-gold">
            Dentist <span className="b-dim">2:30 PM</span>
          </span>
        </div>
        <div className="b-day">
          <p className="b-day-name">
            Fri <strong>20</strong>
          </p>
          <span className="b-event b-event-proposed">
            Friday review <span className="b-dim">10 AM</span>
            <span className="b-confirm">Confirm</span>
          </span>
        </div>
      </div>
    </figure>
  );
}
