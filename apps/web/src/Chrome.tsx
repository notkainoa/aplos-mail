import { Logo } from './brand';

// The header and footer every page shares. `home` is the path back to the site root from the current page.

export function Header({ home }: { home: string }) {
  return (
    <header className="nav">
      <a className="brand" href={home} aria-label="Aplos Mail, home">
        <Logo size={28} />
        <span aria-hidden="true">Aplos Mail</span>
      </a>
      <nav className="nav-links" aria-label="Site">
        <a className="text-link" href={`${home}privacy/`}>
          Privacy
        </a>
        <a className="text-link text-link-strong" href={`${home}download/`}>
          How to get it
        </a>
      </nav>
    </header>
  );
}

export function Footer({ home }: { home: string }) {
  return (
    <footer className="footer">
      <div className="footer-brand">
        <Logo size={24} />
        <p data-claim="mac-only">Independent software for Mac.</p>
      </div>
      <nav className="footer-links" aria-label="Footer">
        <a className="text-link" href={`${home}privacy/`}>
          Privacy
        </a>
        <a className="text-link" href={`${home}download/`}>
          How to get it
        </a>
      </nav>
    </footer>
  );
}
