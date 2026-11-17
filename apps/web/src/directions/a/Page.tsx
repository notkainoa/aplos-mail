import type { ReactNode } from 'react';
import { AppShot, Logo } from '../../shared/brand';
import { AskMock, HomeMock, KeyList, ProviderMock } from './Mocks';

const DOWNLOAD = '../../download/';
const PRIVACY = '../../privacy/';

function Brand() {
  return (
    <a className="brand" href="../../">
      <Logo size={28} />
      <span>Aplos Mail</span>
    </a>
  );
}

function Nav() {
  return (
    <header className="nav">
      <Brand />
      <nav className="nav-links" aria-label="Site">
        <a className="text-link" href={PRIVACY}>
          Privacy
        </a>
        <a className="button-quiet" href={DOWNLOAD}>
          How to get it
        </a>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <h1 id="hero-title">Finish your inbox, one email at a time.</h1>
        <p className="hero-sub" data-claim="gmail-google-calendar home-focus">
          Aplos Mail is a Mac app for Gmail and Google Calendar. It puts the email that needs you in
          focus, then brings the next.
        </p>
        <div className="hero-cta">
          <a className="button button-large" href={DOWNLOAD}>
            How to get it
          </a>
          <p className="hero-note" data-claim="mac-chips macos-13">
            For Macs with Apple silicon or Intel, on macOS 13 or later.
          </p>
        </div>
      </div>
      <div className="window">
        <AppShot
          name="home"
          eager
          alt="Aplos Mail's Home on All accounts: Jordan Park's email in focus with Reply, Later and Done, the rest of Do now below it, and Low importance folded into one line."
        />
      </div>
    </section>
  );
}

type PaneProps = {
  id: string;
  label: string;
  title: string;
  children: ReactNode;
  aside: ReactNode;
  flip?: boolean;
  wide?: boolean;
};

function Pane({ id, label, title, children, aside, flip, wide }: PaneProps) {
  const layout = wide ? 'pane-wide' : flip ? 'pane-split pane-flip' : 'pane-split';
  return (
    <section className={`pane ${layout}`} aria-labelledby={id}>
      <div className="pane-copy">
        <p className="pane-label">{label}</p>
        <h2 id={id}>{title}</h2>
        {children}
      </div>
      <div className="pane-aside">{aside}</div>
    </section>
  );
}

function HomePane() {
  return (
    <Pane
      id="home"
      label="Home"
      title="One email in focus, the rest can wait."
      aside={<HomeMock />}
    >
      <p data-claim="home-focus">
        Home puts the email that needs you at the top. Reply, Later or Done, and the next one takes
        its place.
      </p>
      <p data-claim="summaries-with-ai">
        Once you turn on AI, each email gets a short summary of what it says and what it needs from
        you.
      </p>
    </Pane>
  );
}

function CalendarPane() {
  return (
    <Pane
      id="calendar"
      label="Calendar"
      title="Your calendar sits next to your mail."
      wide
      aside={
        <div className="window window-in-pane">
          <AppShot
            name="calendar"
            alt="Aplos Mail's calendar week for November 15 to 21, with events from two Google accounts."
          />
        </div>
      }
    >
      <div className="pane-columns">
        <p data-claim="google-calendar-views">
          Your Google calendars share one day, week and month view.
        </p>
        <p data-claim="plans-confirm">
          When an email mentions a plan, Aplos can propose the event, and adds it only after you
          confirm.
        </p>
        <p data-claim="several-accounts">Connect several Google accounts and see them together.</p>
      </div>
    </Pane>
  );
}

function AskPane() {
  return (
    <Pane id="ask" label="Ask" title="Ask about your mail or calendar." flip aside={<AskMock />}>
      <p data-claim="ask-dictate">Type a question, or hold A and say it.</p>
      <p data-claim="ask-cites">
        Ask reads your mail and calendar, and shows the messages its answer came from.
      </p>
      <p data-claim="ask-never-sends">
        It can draft a reply for you to review. It never sends on its own.
      </p>
    </Pane>
  );
}

function KeysPane() {
  return (
    <Pane id="keys" label="Keyboard" title="Made for the keyboard." aside={<KeyList />}>
      <p data-claim="keyboard-first">
        Your hands stay on the keyboard from the first email to the last.
      </p>
    </Pane>
  );
}

function AiPane() {
  return (
    <Pane
      id="ai"
      label="AI and privacy"
      title="Your provider, your keys, your Mac."
      flip
      aside={<ProviderMock />}
    >
      <p data-claim="groq-default provider-per-feature">
        Every AI feature runs on Groq by default. In Settings you can pick a provider for each
        feature, and a feature&rsquo;s text goes only to that provider.
      </p>
      <p data-claim="ai-providers">
        Choose from Groq, OpenAI, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio or your
        own server. Voice uses Groq or OpenAI.
      </p>
      <p data-claim="keys-on-mac local-models no-aplos-server">
        Your AI keys stay on your Mac. Ollama and LM Studio run on it too, so what you send them
        stays there. No Aplos server ever sees your mail, calendar or sign‑in details.
      </p>
    </Pane>
  );
}

function Close() {
  return (
    <section className="pane close" aria-labelledby="close-title">
      <Logo size={56} />
      <h2 id="close-title">Shared with invited testers.</h2>
      <p data-claim="invited-testers-builds gmail-invited-testers">
        There is no public download. Builds are shared directly with invited testers, and Gmail and
        Google Calendar are available to invited testers.
      </p>
      <a className="button button-large" href={DOWNLOAD}>
        How to get it
      </a>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-brand">
        <Logo size={20} />
        <p data-claim="mac-only">Independent software for Mac.</p>
      </div>
      <nav className="footer-links" aria-label="Footer">
        <a className="text-link" href={DOWNLOAD}>
          Download
        </a>
        <a className="text-link" href={PRIVACY}>
          Privacy
        </a>
      </nav>
    </footer>
  );
}

/** Direction A, "Paper desk": the site laid out like the app, white panes on the grey shell. */
export function Page() {
  return (
    <div className="page">
      <Nav />
      <main>
        <Hero />
        <div className="panes">
          <HomePane />
          <CalendarPane />
          <AskPane />
          <KeysPane />
          <AiPane />
          <Close />
        </div>
      </main>
      <Footer />
    </div>
  );
}
