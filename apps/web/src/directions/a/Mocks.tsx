import { BubbleIcon, CheckIcon, ClockIcon, MoreIcon, ReplyIcon } from './Icons';

type Row = { sender: string; due?: string; subject: string; when: string };

const rows: Row[] = [
  { sender: 'Maya Chen', due: 'Thu', subject: 'Saturday in the community garden', when: 'Nov 13' },
  {
    sender: 'Maple Library',
    due: 'Fri',
    subject: 'Your holds are ready to collect',
    when: 'Nov 13',
  },
  { sender: 'Theo Kim', subject: 'Friday review: agenda and room', when: '8:32 PM' },
];

function DueChip({ day }: { day: string }) {
  return (
    <span className="chip">
      <ClockIcon />
      {day}
    </span>
  );
}

function FocusCard() {
  return (
    <div className="focus-card">
      <div className="focus-meta">
        <span className="focus-sender">Jordan Park</span>
        <DueChip day="Wed" />
        <span className="focus-time">9:17 PM</span>
      </div>
      <p className="focus-summary">Jordan wants your pick between two layouts by tomorrow.</p>
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

/** A small, static copy of Home: the section label, the focus card and the next rows. */
export function HomeMock() {
  return (
    <div className="mock mock-home" aria-hidden="true">
      <div className="home-head">
        <span className="home-label">
          Do now <span className="home-count">6</span>
        </span>
        <span className="home-link">Go one by one</span>
      </div>
      <FocusCard />
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

const mainKeys: Key[] = [
  { cap: 'Space', does: 'Main action' },
  { cap: '←', does: 'Later' },
  { cap: '→', does: 'Done' },
  { cap: 'Z', does: 'Undo' },
];

const moreKeys: Key[] = [
  { cap: 'B', does: 'Bookmark' },
  { cap: 'A', does: 'Ask, hold to dictate' },
  { cap: 'C', does: 'Compose' },
  { cap: '?', does: 'All shortcuts' },
];

function KeyItem({ item, large }: { item: Key; large?: boolean }) {
  return (
    <li className={large ? 'key-main' : 'key-more'}>
      <kbd className="cap">{item.cap}</kbd>
      <span>{item.does}</span>
    </li>
  );
}

/** The four keys that run Home first, the rest as a quieter list. */
export function KeyList() {
  return (
    <div className="keys" data-claim="key-list">
      <ul className="key-grid">
        {mainKeys.map(key => (
          <KeyItem key={key.cap} item={key} large />
        ))}
      </ul>
      <ul className="key-rest">
        {moreKeys.map(key => (
          <KeyItem key={key.cap} item={key} />
        ))}
      </ul>
    </div>
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
