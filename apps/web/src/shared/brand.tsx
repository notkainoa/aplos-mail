import logo from '../../brand/aplos-mail.svg';

const shots = import.meta.glob('../assets/app/*.webp', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** The Aplos Mail logo, flat, built from brand/aplos-mail.icon. Decorative unless given alt text. */
export function Logo({ size, alt = '' }: { size: number; alt?: string }) {
  return <img className="logo" src={logo} width={size} height={size} alt={alt} />;
}

export type AppScreen = 'home' | 'later' | 'calendar';

/** A screenshot of the current app on its demo data (1240 × 760 window), matching the visitor's appearance. */
export function AppShot({ name, alt, eager }: { name: AppScreen; alt: string; eager?: boolean }) {
  return (
    <picture className="app-shot">
      <source srcSet={shots[`../assets/app/${name}.webp`]} media="(prefers-color-scheme: dark)" />
      <img
        src={shots[`../assets/app/${name}-light.webp`]}
        alt={alt}
        width={1240}
        height={760}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
      />
    </picture>
  );
}
