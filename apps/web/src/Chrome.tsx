import { Logo } from './brand';

// The header and footer every page shares. `home` is the path back to the site root from the current page.

type Page = 'download' | 'privacy';

const current = (page: Page | undefined, link: Page) => (page === link ? 'page' : undefined);

export function Header({ home, page }: { home: string; page?: Page }) {
  return (
    <header className="nav">
      <a className="brand" href={home} aria-label="Aplos Mail, home">
        <Logo size={28} />
        <span aria-hidden="true">Aplos Mail</span>
      </a>
      <nav className="nav-links" aria-label="Site">
        <a className="text-link" href={`${home}privacy/`} aria-current={current(page, 'privacy')}>
          Privacy
        </a>
        <a
          className="text-link text-link-strong"
          href={`${home}download/`}
          aria-current={current(page, 'download')}
        >
          How to get it
        </a>
      </nav>
    </header>
  );
}

// The footer: the links on one quiet line, then the name set across the full width as the page's signature.
export function Footer({ home }: { home: string }) {
  return (
    <footer className="footer">
      <div className="footer-row">
        <div className="footer-brand">
          <Logo size={24} />
          <p data-claim="mac-only">Independent software for Mac.</p>
        </div>
        <nav className="footer-links" aria-label="Footer">
          <a className="text-link" href={`${home}privacy/`}>
            Privacy
          </a>
          <a className="text-link" href={`${home}terms/`}>
            Terms
          </a>
          <a className="text-link" href={`${home}download/`}>
            How to get it
          </a>
        </nav>
      </div>
      <p className="footer-mark" aria-hidden="true">
        Aplos Mail
      </p>
    </footer>
  );
}
