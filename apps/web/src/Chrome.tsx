import icon from '../../desktop/assets/icon-64.png';
import { Rise } from './Live';

export function Header({ home }: { home: string }) {
  return (
    <header className="bar">
      <a className="wordmark" href={home} aria-label="Aplos Mail, home">
        <img src={icon} width="30" height="30" alt="" />
        <span>Aplos Mail</span>
      </a>
      <nav aria-label="Main">
        <a href={`${home}#home`}>Inbox</a>
        <a href={`${home}#calendar`}>Calendar</a>
        <a href={`${home}#ai`}>AI</a>
        <a href={`${home}privacy/`}>Privacy</a>
      </nav>
      <a className="button button-small" href={`${home}download/`}>
        Download
      </a>
    </header>
  );
}

export function Footer({ home }: { home: string }) {
  return (
    <footer className="foot">
      <div className="foot-inner">
        <a className="foot-name" href={home} data-reveal>
          <Rise text="Aplos Mail" by="letter" step={35} />
        </a>
        <nav aria-label="Footer">
          <a href={`${home}download/`}>Download</a>
          <a href={`${home}privacy/`}>Privacy</a>
        </nav>
        <p data-claim="mac-only">Independent software for Mac.</p>
      </div>
    </footer>
  );
}

const shots = import.meta.glob('./assets/shots/*.webp', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

// Each screenshot exists in the app's light and dark appearance; the page shows the one that matches the visitor's.
export function Shot({
  name,
  alt,
  width,
  height,
  eager,
  onLoad,
  onError,
}: {
  name: string;
  alt: string;
  width: number;
  height: number;
  eager?: boolean;
  onLoad?: () => void;
  onError?: () => void;
}) {
  return (
    <picture className="shot">
      <source srcSet={shots[`./assets/shots/${name}.webp`]} media="(prefers-color-scheme: dark)" />
      <img
        src={shots[`./assets/shots/${name}-light.webp`]}
        alt={alt}
        width={width}
        height={height}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        onLoad={onLoad}
        onError={onError}
      />
    </picture>
  );
}
