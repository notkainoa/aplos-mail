import { AppShot, type AppScreen } from '../../shared/brand';

export function Shot({ name, alt }: { name: AppScreen; alt: string }) {
  return (
    <figure className="shot">
      <AppShot name={name} alt={alt} />
    </figure>
  );
}

/** A small Ask exchange in the app's style: the prompt, a serif answer and the message it cites. */
export function AskMock() {
  return (
    <div className="mock ask-mock" aria-label="Example of Ask">
      <div className="ask-field">
        <span className="ask-q">What does Jordan need from me?</span>
        <span className="ask-hint">Ask about your mail or calendar</span>
      </div>
      <p className="ask-answer">Jordan wants your pick between two layouts by tomorrow.</p>
      <div className="ask-cite">
        <span className="cite-from">Jordan Park</span>
        <span className="cite-subject">A quieter home for our project</span>
        <span className="cite-date">Wed</span>
      </div>
    </div>
  );
}

const keys: Array<[string, string]> = [
  ['Space', 'Main action'],
  ['←', 'Later'],
  ['→', 'Done'],
  ['Z', 'Undo'],
  ['B', 'Bookmark'],
  ['A', 'Ask, hold to dictate'],
  ['C', 'Compose'],
  ['?', 'All shortcuts'],
];

export function KeyGrid() {
  return (
    <ul className="mock key-grid" data-claim="key-list">
      {keys.map(([key, label]) => (
        <li key={key}>
          <kbd className={key === 'Space' ? 'cap cap-wide' : 'cap'}>{key}</kbd>
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}

const choices: Array<[string, string]> = [
  ['Ask', 'Groq'],
  ['Summaries', 'Groq'],
  ['Drafts', 'Claude'],
  ['Plans', 'Ollama on this Mac'],
  ['Voice', 'OpenAI'],
];

/** A slice of Settings → AI: one provider per feature. Example choices, not defaults. */
export function ProviderMock() {
  return (
    <div className="mock providers" aria-label="Example of Settings, AI">
      <p className="mock-label">Settings · AI</p>
      <ul>
        {choices.map(([feature, provider]) => (
          <li key={feature}>
            <span className="p-feature">{feature}</span>
            <span className="p-pick">{provider}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
