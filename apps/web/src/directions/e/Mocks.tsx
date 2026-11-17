import { DEMO_EMAILS, DO_NOW_TOTAL, type DemoEmail } from './demo';

function MockHead({ index }: { index: number }) {
  return (
    <div className="mock-head">
      <span className="mock-label">
        Do now <span className="mock-count">{DO_NOW_TOTAL - index}</span>
      </span>
      <span className="mock-dim">Go one by one</span>
    </div>
  );
}

function MockActions({ email, pressed }: { email: DemoEmail; pressed: boolean }) {
  return (
    <div className="mock-actions">
      <span className={pressed ? 'mock-btn mock-btn--main is-on' : 'mock-btn mock-btn--main'}>
        {email.action} <kbd className="kbd">Space</kbd>
      </span>
      <span className="mock-spacer" />
      <span className="mock-btn">
        Later <kbd className="kbd">←</kbd>
      </span>
      <span className="mock-btn">
        Done <kbd className="kbd">→</kbd>
      </span>
    </div>
  );
}

/** The Home focus letter, built in the app's style. */
export function FocusCard({ email, pressed = false }: { email: DemoEmail; pressed?: boolean }) {
  return (
    <article className="mock-card" aria-label={`${email.sender}: ${email.subject}`}>
      <div className="mock-meta">
        <span className="mock-sender">{email.sender}</span>
        <span className="mock-chip">{email.day}</span>
        <span className="mock-time">{email.time}</span>
      </div>
      <p className="mock-summary">{email.summary}</p>
      <p className="mock-subject">{email.subject}</p>
      <MockActions email={email} pressed={pressed} />
    </article>
  );
}

function NextRows({ index }: { index: number }) {
  const rows = DEMO_EMAILS.slice(index + 1, index + 3);
  return (
    <ul className="mock-rows" aria-hidden="true">
      {rows.map(row => (
        <li key={row.sender}>
          <span className="mock-row-sender">{row.sender}</span>
          <span className="mock-row-subject">{row.subject}</span>
        </li>
      ))}
    </ul>
  );
}

export function HomeView({ index }: { index: number }) {
  const email = DEMO_EMAILS[index];
  if (!email) return <ClearView />;
  return (
    <div className="view view--home">
      <MockHead index={index} />
      <FocusCard email={email} />
      <NextRows index={index} />
    </div>
  );
}

function ReplyBox({ email }: { email: DemoEmail }) {
  return (
    <div className="mock-reply">
      <p className="mock-reply-to">To {email.sender}</p>
      <p className="mock-reply-field">
        <span className="mock-caret" aria-hidden="true" />
        Write a reply
      </p>
    </div>
  );
}

function PlanBox() {
  return (
    <div className="mock-plan">
      <div>
        <p className="mock-plan-title">Friday review</p>
        <p className="mock-plan-when">Fri, 2:00 to 3:00 PM · Corner room</p>
      </div>
      <span className="mock-btn mock-btn--main">Add</span>
      <span className="mock-btn">Not now</span>
    </div>
  );
}

export function ActionView({ index }: { index: number }) {
  const email = DEMO_EMAILS[index];
  if (!email) return <ClearView />;
  const isPlan = email.action === 'Add to calendar';
  return (
    <div className="view view--action">
      <MockHead index={index} />
      <FocusCard email={email} pressed />
      {isPlan ? <PlanBox /> : <ReplyBox email={email} />}
    </div>
  );
}

export function ClearView() {
  return (
    <div className="view view--clear">
      <p className="clear-title">Do now is clear.</p>
      <p className="clear-sub">Press ← or → to start again, or Z to bring the last one back.</p>
    </div>
  );
}

/** Ask, as a small panel: a question, a cited answer in the serif, and the field. */
export function AskMock() {
  return (
    <div className="ask" aria-label="Ask">
      <p className="ask-q">What does Sam still need from me?</p>
      <p className="ask-a">
        Sam needs a headcount for the cabin and whether you can drive, by Thursday.
        <sup className="ask-ref">1</sup>
      </p>
      <p className="ask-source">
        <span className="ask-source-n">1</span>
        <span className="ask-source-from">Sam Rivera</span>
        <span className="ask-source-subject">Cabin weekend: a few loose ends</span>
      </p>
      <div className="ask-field">
        <span>Ask about your mail or calendar</span>
        <span className="ask-hint">
          Hold <kbd className="kbd">A</kbd> to dictate
        </span>
      </div>
    </div>
  );
}

export function AskView() {
  return (
    <div className="view view--ask">
      <AskMock />
    </div>
  );
}
