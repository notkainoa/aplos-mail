import type { ReactNode } from 'react';
import { Ask } from './Ask';
import { HomeShot, Logo } from './brand';
import { Footer, Header } from './Chrome';
import { KeyList, ProviderPicker } from './Live';
import { CalendarDayMock, CalendarWeekMock, SuggestionCards } from './Mocks';
import { Triage } from './Triage';
import { useReveal } from './reveal';

const DOWNLOAD = './download/';

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy" data-reveal>
        <h1 id="hero-title">Finish your inbox, one email at a time.</h1>
        <p className="hero-sub" data-claim="gmail-google-calendar home-focus keyboard-first">
          Aplos Mail is a keyboard-first Mac app for Gmail and Google Calendar. It puts the email
          that needs you in focus, then brings the next.
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
      <figure className="window" data-reveal data-claim="home-focus several-accounts">
        <div className="window-frame">
          <TrafficLights />
          <HomeShot alt="Aplos Mail's Home on All accounts: Jordan Park's email in focus with Reply, Later and Done, and the rest of Do now below it." />
        </div>
        <figcaption data-claim="mac-only">Home in the Mac app, on its demo mail.</figcaption>
      </figure>
    </section>
  );
}

// The window's close, minimise and zoom buttons. macOS draws them outside the page, so a screenshot of the page lacks them.
function TrafficLights() {
  return (
    <span className="traffic-lights" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

type SectionProps = {
  id: string;
  title: string;
  children: ReactNode;
  aside: ReactNode;
  layout?: 'split' | 'flip' | 'wide';
};

/** One feature: the words and the thing they describe, straight on the page. */
function Section({ id, title, children, aside, layout = 'split' }: SectionProps) {
  const wide = layout === 'wide';
  return (
    <section className={`feature feature-${layout}`} id={id} aria-labelledby={`${id}-title`}>
      <div className="feature-copy" data-reveal={wide ? undefined : true}>
        <h2 id={`${id}-title`} data-reveal={wide ? true : undefined}>
          {title}
        </h2>
        <div className="feature-text" data-reveal={wide ? true : undefined}>
          {children}
        </div>
      </div>
      <div className="feature-aside" data-reveal>
        {aside}
      </div>
    </section>
  );
}

function HomeSection() {
  return (
    <Section id="home" title="Read the point, then decide." aside={<Triage />}>
      <p data-claim="summaries-with-ai home-focus">
        Once AI is on, the email in focus carries a short summary of what it says and needs. Reply,
        set it aside for Later or mark it Done, and the next one takes its place.
      </p>
      <p className="note">
        This is a working copy of Home.{' '}
        <span className="pointer-only">Click it and try the keys.</span>
        <span className="touch-only">Tap the card, then use the buttons, or swipe it.</span>
      </p>
    </Section>
  );
}

function SuggestedSection() {
  return (
    <Section
      id="next-step"
      title="One suggested step, one key."
      layout="wide"
      aside={
        <>
          <SuggestionCards />
          <p className="note" data-claim="suggested-action">
            For links, attachments and plans, Space opens the email.
          </p>
        </>
      }
    >
      <p data-claim="suggested-action">
        Once AI is on, Aplos reads each email and suggests one next step: reply, open a link or
        attachment, a plan for your calendar, or just Done. The main button names it with its own
        icon, and Space starts it.
      </p>
      <p data-claim="suggested-action">
        A reply opens, Done clears the email, and the rest open the email. Nothing is sent or added
        to your calendar on its own.
      </p>
      <p data-claim="suggested-action-ai-off">
        With AI off, the button is Reply on Do now and Done on Important updates.
      </p>
    </Section>
  );
}

function CalendarSection() {
  return (
    <Section
      id="calendar"
      title="Your calendar sits next to your mail."
      layout="wide"
      aside={
        <>
          <CalendarWeekMock />
          <CalendarDayMock />
        </>
      }
    >
      <p data-claim="google-calendar-views">
        Your Google calendars share one day, week and month view.
      </p>
      <p data-claim="plans-confirm">
        When an email mentions a plan, Aplos can propose the event, and adds it only after you
        confirm.
      </p>
      <p data-claim="several-accounts">Connect several Google accounts and see them together.</p>
    </Section>
  );
}

function AskSection() {
  return (
    <Section id="ask" title="Ask about your mail or calendar." layout="flip" aside={<Ask />}>
      <p data-claim="ask-dictate">
        Type a question, or hold <kbd className="kbd">A</kbd> to dictate it.
      </p>
      <p data-claim="ask-cites">
        Ask reads your mail and calendar, and shows the messages its answer came from.
      </p>
      <p data-claim="ask-never-sends">
        It can draft a reply for you to review. It never sends on its own.
      </p>
      <p className="note">Pick a question to see another answer.</p>
    </Section>
  );
}

function KeysSection() {
  return (
    <Section id="keys" title="Made for the keyboard." aside={<KeyList />}>
      <p data-claim="keyboard-first">
        Your hands stay on the keyboard from the first email to the last.
      </p>
      <p className="note pointer-only">Press a key to see its cap press.</p>
    </Section>
  );
}

function AiSection() {
  return (
    <Section
      id="ai"
      title="Your provider, your keys, your Mac."
      layout="flip"
      aside={<ProviderPicker />}
    >
      <p data-claim="keys-on-mac local-models no-aplos-server">
        No Aplos server ever sees your mail, calendar or sign&#8209;in details. Your keys stay on
        your Mac. Ollama and LM Studio run on your Mac at their default addresses.
      </p>
      <p data-claim="groq-default provider-per-feature ai-routers">
        Groq is the default for every AI feature, and in Settings you pick a provider for each one.
        A feature’s text goes only to the provider you picked. OpenRouter and OpenCode Go pass each
        request on to the company that runs the chosen model.
      </p>
      <p data-claim="ai-consent no-training-providers ai-daily-limit">
        Background AI starts only after you agree, and it stops at a daily limit you can change.
        Gemini gets mail only when you mark its key as paid, because Google may use what a free key
        sends to improve its products.
      </p>
    </Section>
  );
}

function Close() {
  return (
    <section className="close" aria-labelledby="close-title">
      <div className="close-inner" data-reveal>
        <div className="close-copy">
          <h2 id="close-title">See it on your Mac.</h2>
          <p data-claim="gmail-invited-testers">
            Aplos Mail works with Gmail and Google Calendar, available to invited testers.
          </p>
          <p className="close-spec" data-claim="mac-chips macos-13">
            For Macs with Apple silicon or Intel, on macOS 13 or later.
          </p>
          <a className="button button-on-brand button-large" href={DOWNLOAD}>
            How to get it
          </a>
        </div>
        <Logo size={120} />
      </div>
    </section>
  );
}

export function Landing() {
  useReveal();
  return (
    <div className="site">
      <div className="page">
        <Header home="./" />
      </div>
      <main>
        <div className="page">
          <Hero />
          <HomeSection />
          <SuggestedSection />
          <CalendarSection />
          <AskSection />
          <KeysSection />
          <AiSection />
        </div>
        <Close />
      </main>
      <div className="page">
        <Footer home="./" />
      </div>
    </div>
  );
}
