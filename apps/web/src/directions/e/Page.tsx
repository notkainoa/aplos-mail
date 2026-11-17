import { Logo } from '../../shared/brand';
import { Hero } from './Hero';
import {
  AskSection,
  CalendarSection,
  HomeSection,
  PrivacySection,
  ShortcutSection,
} from './Sections';

function Bar() {
  return (
    <header className="bar">
      <a className="bar-brand" href="../../">
        <Logo size={28} />
        <span>Aplos Mail</span>
      </a>
      <nav className="bar-nav" aria-label="Site">
        <a className="bar-link" href="../../privacy/">
          Privacy
        </a>
        <a className="cta cta--small" href="../../download/">
          How to get it
        </a>
      </nav>
    </header>
  );
}

function Close() {
  return (
    <section className="close" aria-labelledby="close-title">
      <h2 id="close-title" className="close-title">
        Finish your inbox, one key at a time.
      </h2>
      <p className="close-text" data-claim="invited-testers-builds">
        There is no public download. Builds are shared directly with invited testers.
      </p>
      <p className="close-fine">
        <span data-claim="gmail-invited-testers">
          Gmail and Google Calendar are available to invited testers.
        </span>{' '}
        <span data-claim="mac-chips macos-13">
          For Macs with Apple silicon or Intel, on macOS 13 or later.
        </span>
      </p>
      <a className="cta" href="../../download/">
        How to get it
      </a>
    </section>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="foot-brand">
        <Logo size={20} />
        <span data-claim="mac-only">Independent software for Mac.</span>
      </div>
      <nav className="foot-nav" aria-label="Footer">
        <a href="../../download/">Download</a>
        <a href="../../privacy/">Privacy</a>
      </nav>
    </footer>
  );
}

export function Page() {
  return (
    <div className="site">
      <Bar />
      <main>
        <Hero />
        <div className="rows">
          <HomeSection />
          <CalendarSection />
          <AskSection />
          <ShortcutSection />
          <PrivacySection />
        </div>
        <Close />
      </main>
      <Footer />
    </div>
  );
}
