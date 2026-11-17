import type { ReactNode } from 'react';
import { AppShot } from '../../shared/brand';
import { ALL_SHORTCUTS } from './demo';
import { AskMock } from './Mocks';

/** A big, still keycap for a section's left column. */
function BigCap({
  children,
  wide = false,
  label,
}: {
  children: ReactNode;
  wide?: boolean;
  label: string;
}) {
  return (
    <div className="side">
      <span className={wide ? 'bigcap bigcap--wide' : 'bigcap'} aria-hidden="true">
        {children}
      </span>
      <span className="side-label">{label}</span>
    </div>
  );
}

function Section({ id, cap, children }: { id: string; cap: ReactNode; children: ReactNode }) {
  return (
    <section className="row" id={id} aria-labelledby={`${id}-title`}>
      {cap}
      <div className="row-main">{children}</div>
    </section>
  );
}

function CalendarGlyph() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

export function HomeSection() {
  return (
    <Section
      id="home"
      cap={
        <BigCap wide label="Home">
          Space
        </BigCap>
      }
    >
      <h2 id="home-title" className="row-title">
        One email in focus.
      </h2>
      <p className="row-lede" data-claim="home-focus">
        Home puts the email that needs you in focus. Reply, Later or Done brings the next one.
      </p>
      <figure className="summary-note">
        <figcaption className="summary-from">Jordan Park</figcaption>
        <p className="summary-line">Jordan wants your pick between two layouts by tomorrow.</p>
      </figure>
      <p className="row-text" data-claim="summaries-with-ai">
        Once AI is on, each email gets a short summary like this one: what it says, and what it
        needs from you.
      </p>
      <div className="shot">
        <AppShot
          name="home"
          alt="Aplos Mail Home: Jordan Park's email in focus under Do now, with Reply, Later and Done, and the next emails below."
        />
      </div>
    </Section>
  );
}

export function CalendarSection() {
  return (
    <Section
      id="calendar"
      cap={
        <BigCap label="Calendar">
          <CalendarGlyph />
        </BigCap>
      }
    >
      <h2 id="calendar-title" className="row-title">
        Your calendar, beside your mail.
      </h2>
      <p className="row-lede" data-claim="google-calendar-views">
        Your Google calendars share one day, week and month view.
      </p>
      <ul className="facts">
        <li data-claim="several-accounts">
          Connect several Google accounts at once. The week below holds events from two.
        </li>
        <li data-claim="plans-confirm">
          When an email mentions a plan, Aplos can propose the event. It is added only after you
          confirm.
        </li>
      </ul>
      <div className="shot">
        <AppShot
          name="calendar"
          alt="Aplos Mail Calendar: a week view with events from two Google accounts."
        />
      </div>
    </Section>
  );
}

export function AskSection() {
  return (
    <Section id="ask" cap={<BigCap label="Ask">A</BigCap>}>
      <h2 id="ask-title" className="row-title">
        Ask about your mail or calendar.
      </h2>
      <p className="row-lede" data-claim="ask-cites">
        Ask reads your mail and calendar and cites the messages it used.
      </p>
      <ul className="facts">
        <li data-claim="ask-dictate">Type a question, or hold A and say it.</li>
        <li data-claim="ask-never-sends">
          Ask drafts replies for you to review. It never sends on its own.
        </li>
      </ul>
      <div className="ask-frame">
        <AskMock />
      </div>
    </Section>
  );
}

export function ShortcutSection() {
  return (
    <Section id="shortcuts" cap={<BigCap label="Every shortcut">?</BigCap>}>
      <h2 id="shortcuts-title" className="row-title">
        Eight keys, and you know them all.
      </h2>
      <p className="row-lede" data-claim="keyboard-first">
        Your hands stay on the keyboard from the first email to the last. Press ? in the app to see
        this list.
      </p>
      <dl className="keytable" data-claim="key-list">
        {ALL_SHORTCUTS.map(item => (
          <div className="keytable-row" key={item.keys}>
            <dt>
              <kbd className="kbd kbd--table">{item.keys}</kbd>
            </dt>
            <dd>{item.does}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

const PRIVACY: { claim: string; head: string; text: string }[] = [
  {
    claim: 'groq-default',
    head: 'Groq by default',
    text: 'Every AI feature runs on Groq by default.',
  },
  {
    claim: 'provider-per-feature ai-routers',
    head: 'One provider per feature',
    text: 'Pick a provider for each feature in Settings. A feature’s text goes only to that feature’s provider. OpenRouter and OpenCode Go pass each request on to the company that runs the chosen model.',
  },
  {
    claim: 'ai-providers',
    head: 'Your choice of provider',
    text: 'Groq, OpenAI, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio or your own server. Voice uses Groq or OpenAI.',
  },
  {
    claim: 'local-models',
    head: 'Models on your Mac',
    text: 'Ollama and LM Studio run on your Mac at their default addresses, so text sent to them stays there.',
  },
  { claim: 'keys-on-mac', head: 'Keys stay local', text: 'Your AI keys stay on your Mac.' },
  {
    claim: 'no-aplos-server',
    head: 'No Aplos server',
    text: 'No Aplos server ever sees your mail, calendar or sign-in details.',
  },
];

export function PrivacySection() {
  return (
    <section className="row row--quiet" id="privacy" aria-labelledby="privacy-title">
      <div className="side">
        <span className="side-label side-label--top">AI and privacy</span>
      </div>
      <div className="row-main">
        <h2 id="privacy-title" className="row-title">
          Your model, your keys, your Mac.
        </h2>
        <dl className="quiet-list">
          {PRIVACY.map(item => (
            <div className="quiet-row" key={item.head}>
              <dt>{item.head}</dt>
              <dd data-claim={item.claim}>{item.text}</dd>
            </div>
          ))}
        </dl>
        <p className="row-more">
          <a href="../../privacy/">Read the privacy page</a>
        </p>
      </div>
    </section>
  );
}
