import logo from '../brand/aplos-mail.svg';
import homeWideLight from './assets/app/home-wide-light.webp';
import homeWideDark from './assets/app/home-wide-dark.webp';
import homeMainLight from './assets/app/home-main-light.webp';
import homeMainDark from './assets/app/home-main-dark.webp';

/** The Aplos Mail logo, flat, built from brand/aplos-mail.icon. Decorative unless given alt text. */
export function Logo({ size, alt = '' }: { size: number; alt?: string }) {
  return <img className="logo" src={logo} width={size} height={size} alt={alt} />;
}

const NARROW = '(max-width: 640px)';
const DARK = '(prefers-color-scheme: dark)';

/**
 * Home in the real app on its demo data (scripts/capture-screenshots.mjs): the top of the window on wide screens,
 * the main pane's focus card and first rows on phones, each in the visitor's appearance.
 */
export function HomeShot({ alt }: { alt: string }) {
  return (
    <picture className="shot">
      <source srcSet={homeMainDark} media={`${NARROW} and ${DARK}`} width={840} height={830} />
      <source srcSet={homeMainLight} media={NARROW} width={840} height={830} />
      <source srcSet={homeWideDark} media={DARK} />
      <img
        src={homeWideLight}
        alt={alt}
        width={2480}
        height={1100}
        loading="eager"
        decoding="async"
      />
    </picture>
  );
}
