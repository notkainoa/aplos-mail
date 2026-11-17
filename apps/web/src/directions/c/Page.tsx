import type { ReactNode } from 'react';
import { AppShot, Logo } from '../../shared/brand';
import { AskSection, CalendarSection, HomeSection, KeysSection, PrivacySection } from './Sections';

const DOWNLOAD = '../../download/';
const PRIVACY = '../../privacy/';

/** Direction C, "Letter": the homepage set like a short essay from Aplos. */
export function Page() {
  return (
    <>
      <Letterhead />
      <main className="c-main">
        <Hero />
        <Figure
          crop
          caption="Home. The email that needs you sits in focus, and the rest wait quietly below."
        >
          <AppShot
            name="home"
            eager
            alt="Aplos Mail Home: an email from Jordan Park in focus with Reply, Later and Done, and five more emails under Do now"
          />
        </Figure>
        <HomeSection />
        <KeysSection />
        <CalendarSection
          figure={
            <Figure caption="Calendar. One week, with events from two accounts side by side.">
              <AppShot
                name="calendar"
                alt="Aplos Mail Calendar: a week view of November with a design critique and a dentist appointment on Thursday"
              />
            </Figure>
          }
        />
        <AskSection />
        <PrivacySection />
        <Close />
      </main>
      <Footer />
    </>
  );
}

function Letterhead() {
  return (
    <header className="c-letterhead">
      <a className="c-mark" href="../../">
        <Logo size={28} />
        <span>Aplos Mail</span>
      </a>
      <nav className="c-nav" aria-label="Site">
        <a href={PRIVACY}>Privacy</a>
        <a className="c-nav-cta" href={DOWNLOAD}>
          How to get it
        </a>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section className="c-col c-hero" aria-labelledby="c-title">
      <h1 id="c-title" className="c-display">
        Finish your inbox, one email at a time.
      </h1>
      <p className="c-lede" data-claim="gmail-google-calendar home-focus">
        Aplos Mail is a Mac app for Gmail and Google Calendar. Home puts the email that needs you in
        focus, and Reply, Later or Done brings the next.
      </p>
      <div className="c-cta-row">
        <a className="c-button" href={DOWNLOAD}>
          How to get it
        </a>
        <p className="c-cta-note" data-claim="invited-testers-builds">
          Builds are shared directly with invited testers.
        </p>
      </div>
    </section>
  );
}

/** An app screenshot set like a figure in an article: wider than the text, hairline frame, small caption. */
export function Figure({
  caption,
  crop,
  children,
}: {
  caption: string;
  crop?: boolean;
  children: ReactNode;
}) {
  return (
    <figure className="c-figure">
      <div className={crop ? 'c-frame c-frame-crop' : 'c-frame'}>{children}</div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function Close() {
  return (
    <section className="c-col c-close" aria-labelledby="c-close-title">
      <p className="c-label">Getting it</p>
      <h2 id="c-close-title" className="c-heading">
        For now, shared by invitation.
      </h2>
      <p data-claim="invited-testers-builds">
        There is no public download. Builds are shared directly with invited testers.
      </p>
      <p data-claim="gmail-invited-testers">
        Gmail and Google Calendar are available to invited testers.
      </p>
      <p data-claim="mac-chips macos-13">
        For Macs with Apple silicon or Intel, running macOS 13 or later.
      </p>
      <div className="c-cta-row">
        <a className="c-button" href={DOWNLOAD}>
          How to get it
        </a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="c-footer">
      <div className="c-footer-inner">
        <p className="c-footer-sign">
          <Logo size={20} />
          <span data-claim="mac-only">Independent software for Mac.</span>
        </p>
        <nav className="c-footer-nav" aria-label="Footer">
          <a href={DOWNLOAD}>Download</a>
          <a href={PRIVACY}>Privacy</a>
        </nav>
      </div>
    </footer>
  );
}
