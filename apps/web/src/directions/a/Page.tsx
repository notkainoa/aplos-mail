import type { ReactNode } from 'react';
import { Logo } from '../../shared/brand';
import { CalendarCrop, HomeCrop } from './Crop';
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
        <Logo size={72} />
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
        <HomeCrop alt="Aplos Mail's Home on All accounts: Jordan Park's email in focus with Reply, Later and Done, and the rest of Do now below it." />
      </div>
    </section>
  );
}

/** One editorial line in the app's own voice, on the shell between hero and panes. */
function Voice() {
  return (
    <figure className="voice">
      <blockquote>Jordan wants your pick between two layouts by tomorrow.</blockquote>
      <figcaption data-claim="summaries-with-ai">
        A summary in Aplos Mail, once you turn on AI.
      </figcaption>
    </figure>
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
  asideClass?: string;
};

function Pane({ id, label, title, children, aside, flip, wide, asideClass }: PaneProps) {
  const layout = wide ? 'pane-wide' : flip ? 'pane-split pane-flip' : 'pane-split';
  return (
    <section className={`pane ${layout}`} aria-labelledby={id}>
      <div className="pane-copy">
        <p className="pane-label">{label}</p>
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
      label="Home"
      title="One email in focus, the rest can wait."
      asideClass="aside-home"
      aside={<HomeMock />}
    >
      <p data-claim="home-focus">
        Home puts the email that needs you at the top. Reply, Later or Done, and the next one takes
        its place.
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
        <figure className="window window-in-pane">
          <CalendarCrop alt="Aplos Mail's calendar week for November 15 to 21, with Design critique and Dentist on Thursday." />
          <figcaption data-claim="mac-only">Calendar in the Mac app, week view.</figcaption>
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
      <p data-claim="groq-default provider-per-feature ai-providers">
        Every AI feature runs on Groq by default. In Settings you pick a provider for each one:
        OpenAI, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio or your own server.
      </p>
      <p data-claim="provider-per-feature ai-routers">
        A feature&rsquo;s text goes only to its provider. OpenRouter and OpenCode Go pass each
        request on to the company that runs the chosen model.
      </p>
      <p data-claim="keys-on-mac local-models no-aplos-server">
        Your keys stay on your Mac, and Ollama and LM Studio run on it too. No Aplos server ever
        sees your mail, calendar or sign&#8209;in details.
      </p>
    </Pane>
  );
}

function Close() {
  return (
    <section className="close" aria-labelledby="close-title">
      <h2 id="close-title">See it on your Mac.</h2>
      <p data-claim="gmail-invited-testers">Gmail is available to invited testers.</p>
      <a className="button button-light button-large" href={DOWNLOAD}>
        How to get it
      </a>
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
          How to get it
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
        <Voice />
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
