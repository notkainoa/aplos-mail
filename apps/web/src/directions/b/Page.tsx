import type { ReactNode } from 'react';
import { AppShot, Logo } from '../../shared/brand';
import { AskMock, CalendarMock, HeroCard, HomeMock, KeyGrid } from './Mocks';

const download = '../../download/';
const privacy = '../../privacy/';

function Cta({ id }: { id?: string }) {
  return (
    <a className="b-cta" href={download} id={id}>
      How to get it
    </a>
  );
}

function Nav() {
  return (
    <header className="b-nav b-wrap">
      <a className="b-brand" href="../../">
        <Logo size={28} />
        <span>Aplos Mail</span>
      </a>
      <nav className="b-nav-links" aria-label="Site">
        <a href={privacy}>Privacy</a>
        <a className="b-nav-get" href={download}>
          How to get it
        </a>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section className="b-band b-hero">
      <Nav />
      <div className="b-hero-body b-wrap">
        <div className="b-hero-logo">
          <Logo size={80} alt="Aplos Mail" />
        </div>
        <h1 data-claim="home-focus">Finish your inbox, one email at a time.</h1>
        <p className="b-hero-sub" data-claim="gmail-google-calendar keyboard-first">
          Aplos Mail is a Mac app for Gmail and Google Calendar, built to be used from the keyboard.
        </p>
        <div className="b-hero-cta">
          <Cta />
          <p className="b-hero-note" data-claim="invited-testers-builds">
            No public download. Builds are shared with invited testers.
          </p>
        </div>
      </div>
    </section>
  );
}

function Crop({ name, alt, eager }: { name: 'home' | 'calendar'; alt: string; eager?: boolean }) {
  return (
    <div className={`b-frame b-crop b-crop-${name}`}>
      <AppShot name={name} alt={alt} eager={eager} />
    </div>
  );
}

function HeroShot() {
  return (
    <div className="b-wrap b-hero-shot">
      <HeroCard />
      <Crop
        name="home"
        eager
        alt="Aplos Mail's Home: Jordan Park's email in focus with Reply, Later and Done, and five more emails below"
      />
    </div>
  );
}

function Tag({ children }: { children: string }) {
  return <p className="b-tag">{children}</p>;
}

function featureClass(flip?: boolean, stack?: boolean) {
  if (stack) return 'b-feature b-wrap is-stack';
  return flip ? 'b-feature b-wrap is-flip' : 'b-feature b-wrap';
}

function Line({ children }: { children: string }) {
  return <span className="b-line">{children}</span>;
}

function Feature({
  id,
  tag,
  title,
  flip,
  stack,
  aside,
  children,
}: {
  id: string;
  tag: string;
  title: ReactNode;
  flip?: boolean;
  stack?: boolean;
  aside: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={featureClass(flip, stack)} aria-labelledby={id}>
      <div className="b-feature-text">
        <Tag>{tag}</Tag>
        <h2 id={id}>{title}</h2>
        {stack ? <div className="b-copy">{children}</div> : children}
      </div>
      <div className="b-feature-aside">{aside}</div>
    </section>
  );
}

function Home() {
  return (
    <Feature
      id="b-home"
      tag="Home"
      title={
        <>
          <Line>One email in focus.</Line>
          <Line>The rest can wait.</Line>
        </>
      }
      aside={<HomeMock />}
    >
      <p data-claim="home-focus">
        Home puts the email that needs you in focus. Reply, send it to Later or mark it Done, and
        the next one takes its place.
      </p>
      <p data-claim="summaries-with-ai">
        Once AI is on, each email gets a short summary of what it says and what it needs from you.
      </p>
    </Feature>
  );
}

function Calendar() {
  return (
    <Feature
      id="b-cal"
      tag="Calendar"
      title={
        <>
          <Line>Your mail and calendar,</Line>
          <Line>in one app.</Line>
        </>
      }
      stack
      aside={
        <>
          <div className="b-desk-only">
            <Crop
              name="calendar"
              alt="Aplos Mail's Calendar: a week from Sunday 15 to Saturday 21 November, with a design critique and a dentist visit on Thursday"
            />
          </div>
          <div className="b-narrow-only">
            <CalendarMock />
          </div>
        </>
      }
    >
      <p data-claim="google-calendar-views">
        Your Google calendars share one day, week and month view.
      </p>
      <p data-claim="plans-confirm">
        When an email mentions a plan, Aplos can propose the event. It goes on your calendar only
        after you confirm.
      </p>
      <p data-claim="several-accounts">
        Connect several Google accounts at once and see them together.
      </p>
    </Feature>
  );
}

function Ask() {
  return (
    <Feature
      id="b-ask"
      tag="Ask"
      title={
        <>
          <Line>Ask about your</Line>
          <Line>mail or calendar.</Line>
        </>
      }
      aside={<AskMock />}
    >
      <p data-claim="ask-dictate">Type a question, or hold A and say it.</p>
      <p data-claim="ask-cites">
        Ask reads your mail and calendar, and cites the messages it used.
      </p>
      <p data-claim="ask-never-sends">
        It can draft a reply for you to review. It never sends on its own.
      </p>
    </Feature>
  );
}

function Keyboard() {
  return (
    <Feature
      id="b-keys"
      tag="Keyboard"
      title={
        <>
          <Line>Work through mail</Line>
          <Line>from the keyboard.</Line>
        </>
      }
      flip
      aside={<KeyGrid />}
    >
      <p data-claim="keyboard-first">
        Space does the main thing for the email in front of you. The left arrow sends it to Later,
        the right arrow marks it Done, and Z undoes the last move.
      </p>
    </Feature>
  );
}

const providers = [
  { name: 'Groq', note: 'Default' },
  { name: 'OpenAI', note: '' },
  { name: 'Claude', note: '' },
  { name: 'Gemini', note: '' },
  { name: 'OpenRouter', note: '' },
  { name: 'OpenCode Go', note: '' },
  { name: 'Ollama', note: 'On your Mac' },
  { name: 'LM Studio', note: 'On your Mac' },
  { name: 'Your own server', note: '' },
];

function Providers() {
  return (
    <ul className="b-providers" data-claim="ai-providers groq-default local-models">
      {providers.map(p => (
        <li key={p.name}>
          <span>{p.name}</span>
          {p.note ? <span className="b-provider-note">{p.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function Privacy() {
  return (
    <section className="b-privacy" aria-labelledby="b-ai">
      <div className="b-wrap b-privacy-grid">
        <div className="b-privacy-text">
          <Tag>AI and privacy</Tag>
          <h2 id="b-ai">
            <Line>Pick a provider</Line>
            <Line>for each feature.</Line>
          </h2>
          <p data-claim="groq-default">Every AI feature runs on Groq by default.</p>
          <p data-claim="provider-per-feature ai-routers">
            You pick the provider for each feature in Settings. A feature's text goes only to its
            provider. OpenRouter and OpenCode Go pass each request on to the company that runs the
            chosen model.
          </p>
        </div>
        <div className="b-privacy-side">
          <Providers />
          <dl className="b-facts">
            <div data-claim="local-models">
              <dt>Run it locally</dt>
              <dd>Ollama and LM Studio run on your Mac, so text sent to them stays there.</dd>
            </div>
            <div data-claim="keys-on-mac">
              <dt>Your keys</dt>
              <dd>Your AI keys stay on your Mac.</dd>
            </div>
            <div data-claim="no-aplos-server">
              <dt>No middleman</dt>
              <dd>No Aplos server ever sees your mail, calendar or sign-in details.</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="b-footer b-wrap">
      <a className="b-brand" href="../../">
        <Logo size={22} />
        <span>Aplos Mail</span>
      </a>
      <p data-claim="mac-only">Independent software for Mac.</p>
      <nav className="b-footer-links" aria-label="Footer">
        <a href={download}>How to get it</a>
        <a href={privacy}>Privacy</a>
      </nav>
    </footer>
  );
}

function Close() {
  return (
    <section className="b-band b-close" aria-labelledby="b-close">
      <div className="b-wrap b-close-body">
        <h2 id="b-close">Start at the top. Finish at Done.</h2>
        <p data-claim="gmail-invited-testers invited-testers-builds">
          Aplos Mail works with Gmail and Google Calendar, available to invited testers.
        </p>
        <Cta />
        <p className="b-close-note" data-claim="mac-chips macos-13">
          For Macs with Apple silicon or Intel, on macOS 13 or later.
        </p>
      </div>
      <Footer />
    </section>
  );
}

/** Direction B, "Evergreen": a brand-green hero and close, a calm neutral page between. */
export function Page() {
  return (
    <>
      <a className="b-skip" href="#b-main">
        Skip to content
      </a>
      <Hero />
      <main id="b-main">
        <HeroShot />
        <Home />
        <Keyboard />
        <Calendar />
        <Ask />
        <Privacy />
      </main>
      <Close />
    </>
  );
}
