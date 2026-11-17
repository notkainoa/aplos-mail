import homeWideLight from './home-wide-light.webp';
import homeWideDark from './home-wide-dark.webp';
import homeCardLight from './home-card-light.webp';
import homeCardDark from './home-card-dark.webp';
import calWideLight from './cal-wide-light.webp';
import calWideDark from './cal-wide-dark.webp';
import calThuLight from './cal-thu-light.webp';
import calThuDark from './cal-thu-dark.webp';

type Size = { width: number; height: number };

type CropProps = {
  alt: string;
  eager?: boolean;
  wide: { light: string; dark: string } & Size;
  narrow: { light: string; dark: string } & Size;
};

const NARROW = '(max-width: 640px)';
const DARK = '(prefers-color-scheme: dark)';

/** A crop of the real app window: a wide one, and a tighter one for phones. Light and dark pairs. */
function Crop({ alt, eager, wide, narrow }: CropProps) {
  return (
    <picture className="crop">
      <source srcSet={narrow.dark} media={`${NARROW} and ${DARK}`} />
      <source srcSet={narrow.light} media={NARROW} />
      <source srcSet={wide.dark} media={DARK} />
      <img
        src={wide.light}
        alt={alt}
        width={wide.width}
        height={wide.height}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
      />
    </picture>
  );
}

export function HomeCrop({ alt }: { alt: string }) {
  return (
    <Crop
      alt={alt}
      eager
      wide={{ light: homeWideLight, dark: homeWideDark, width: 2480, height: 1100 }}
      narrow={{ light: homeCardLight, dark: homeCardDark, width: 1490, height: 420 }}
    />
  );
}

export function CalendarCrop({ alt }: { alt: string }) {
  return (
    <Crop
      alt={alt}
      wide={{ light: calWideLight, dark: calWideDark, width: 1950, height: 530 }}
      narrow={{ light: calThuLight, dark: calThuDark, width: 1030, height: 420 }}
    />
  );
}
