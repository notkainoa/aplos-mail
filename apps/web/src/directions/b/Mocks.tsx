/** Small HTML stand-ins for parts of the app, drawn in the site's style. Demo content only. */

function Kbd({ children }: { children: string }) {
  return <kbd className="b-kbd">{children}</kbd>;
}

const rows = [
  { from: 'Maya Chen', subject: 'Saturday in the community garden', when: 'Nov 13' },
  { from: 'Maple Library', subject: 'Your holds are ready to collect', when: 'Nov 13' },
  { from: 'Theo Kim', subject: 'Friday review: agenda and room', when: '8:32 PM' },
  { from: 'Sam Rivera', subject: 'Cabin weekend: a few loose ends', when: 'Nov 13' },
  { from: 'Rowan Pottery', subject: 'A place opened in the evening class', when: 'Nov 12' },
];

function FocusCard() {
  return (
    <div className="b-focus">
      <div className="b-focus-top">
        <span className="b-focus-from">Jordan Park</span>
        <span className="b-focus-time">9:17 PM</span>
      </div>
      <p className="b-focus-subject">A quieter home for our project</p>
      <p className="b-summary-label">Summary of this email, once AI is on</p>
      <p className="b-summary">Jordan wants your pick between two layouts by tomorrow.</p>
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

/** Home: one email in focus, the rest of Do now beneath it. */
export function HomeMock() {
  return (
    <figure
      className="b-mock"
      aria-label="Home with Jordan Park's email in focus and five more emails under Do now"
    >
      <div className="b-mock-head">
        <span>
          <strong>Do now</strong> <span className="b-dim">6</span>
        </span>
        <span className="b-dim">Go one by one</span>
      </div>
      <FocusCard />
      <ul className="b-rows">
        {rows.map(row => (
          <li key={row.from}>
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
