import type { ReactNode } from 'react';
import { Logo } from '../../shared/brand';
import { HomeCrop } from './Crop';
import {
  AskMock,
  CalendarDayMock,
  CalendarWeekMock,
  HomeMock,
  KeyList,
  ProviderMock,
  summaryFocus,
} from './Mocks';

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
        <a className="text-link text-link-strong" href={DOWNLOAD}>
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
          <div className="hero-note">
            <p data-claim="invited-testers-builds">
              No public download. Builds are shared with invited testers.
            </p>
            <p data-claim="mac-chips macos-13">
              For Macs with Apple silicon or Intel, on macOS 13 or later.
            </p>
          </div>
        </div>
      </div>
      <div className="window">
        <HomeMock plain className="hero-mock" />
        <HomeCrop alt="Aplos Mail's Home on All accounts: Jordan Park's email in focus with Reply, Later and Done, and the rest of Do now below it." />
        <p className="window-note" data-claim="mac-only">
          Home in the Mac app.
        </p>
      </div>
    </section>
  );
}

type PaneProps = {
  id: string;
  title: string;
  children: ReactNode;
  aside: ReactNode;
  flip?: boolean;
  wide?: boolean;
  asideClass?: string;
};

function Pane({ id, title, children, aside, flip, wide, asideClass }: PaneProps) {
  const layout = wide ? 'pane-wide' : flip ? 'pane-split pane-flip' : 'pane-split';
  return (
    <section className={`pane ${layout}`} aria-labelledby={id}>
      <div className="pane-copy">
        <h2 id={id}>{title}</h2>
        {children}
      </div>
      <div className={`pane-aside ${asideClass ?? ''}`}>{aside}</div>
    </section>
  );
}

function HomePane() {
  return (
    <Pane
      id="home"
      title="Read the point, then decide."
      asideClass="aside-home"
      aside={
        <>
          <HomeMock focus={summaryFocus} summaryOnly />
          <p className="aside-note" data-claim="summaries-with-ai">
            A summary in Aplos Mail, once you turn on AI.
          </p>
        </>
      }
    >
      <p data-claim="summaries-with-ai home-focus">
        Once AI is on, the email in focus carries a short summary of what it says and needs. Then
        Reply, Later or Done, and the next one takes its place.
      </p>
    </Pane>
  );
}

function CalendarPane() {
  return (
    <Pane
      id="calendar"
      title="Your calendar sits next to your mail."
      wide
      aside={
        <figure className="window window-in-pane">
          <CalendarDayMock />
          <CalendarWeekMock />
          <figcaption data-claim="mac-only">Calendar in the Mac app.</figcaption>
        </figure>
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
    <Pane id="ask" title="Ask about your mail or calendar." flip aside={<AskMock />}>
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
    <Pane id="keys" title="Made for the keyboard." aside={<KeyList />}>
      <p data-claim="keyboard-first">
        Your hands stay on the keyboard from the first email to the last.
      </p>
    </Pane>
  );
}

function AiPane() {
  return (
    <Pane id="ai" title="Your provider, your keys, your Mac." flip aside={<ProviderMock />}>
      <p className="lead" data-claim="keys-on-mac local-models no-aplos-server">
        No Aplos server ever sees your mail, calendar or sign&#8209;in details. Your keys stay on
        your Mac, and Ollama and LM Studio run on it too.
      </p>
      <p data-claim="groq-default provider-per-feature ai-providers ai-routers">
        Groq is the default for every AI feature. In Settings you pick a provider for each one, such
        as OpenAI, Claude, Gemini, Ollama or your own server. A feature’s text goes only to the
        provider you picked for it; routers like OpenRouter pass it on to the model’s host.
      </p>
    </Pane>
  );
}

function Close() {
  return (
    <section className="close" aria-labelledby="close-title">
      <div className="close-copy">
        <span className="close-chip close-chip-mobile">
          <Logo size={44} />
        </span>
        <h2 id="close-title">See it on your Mac.</h2>
        <p data-claim="gmail-invited-testers">
          Aplos Mail works with Gmail and Google Calendar, available to invited testers.
        </p>
        <a className="button button-light button-large" href={DOWNLOAD}>
          How to get it
        </a>
      </div>
      <span className="close-chip">
        <Logo size={88} />
      </span>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-brand">
        <Logo size={28} />
        <p data-claim="mac-only">Independent software for Mac.</p>
      </div>
      <nav className="footer-links" aria-label="Footer">
        <a className="text-link" href={DOWNLOAD}>
          Get Aplos Mail
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
        </div>
        <Close />
      </main>
      <Footer />
    </div>
  );
}
