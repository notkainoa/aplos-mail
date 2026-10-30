import { useEffect, useRef, useState } from 'react';
import { Shot } from './Chrome';
import tours from './assets/shots/tours.json';

// Screenshots of the app you can click through. The capture script pressed every control in the real app and
// recorded which screen it led to, so each spot here goes where the app itself goes.
type Spot = {
  label: string;
  to?: string;
  ask?: number;
  x: number;
  y: number;
  w: number;
  h: number;
};
type TourData = { width: number; height: number; start: string; screens: Record<string, Spot[]> };
type TourId = 'hero' | 'calendar';

const names: Record<string, string> = {
  home: 'Home, with the email that needs you in focus and the Ask panel beside it',
  'home-maple': 'Home, with the Maple Library email in focus',
  'home-rowan': 'Home, with the Rowan Pottery email in focus',
  later: 'Later, with the emails set aside for later',
  'later-bookmarks': 'Later, showing bookmarked emails',
  'all-mail': 'All mail',
  drafts: 'Drafts',
  sent: 'Sent mail',
  calendar: 'the calendar week',
  'calendar-day': 'the calendar day',
  'calendar-month': 'the calendar month',
  week: 'a week in the calendar, with events from two accounts',
  day: 'one day in the calendar',
  month: 'a month in the calendar',
  'week-next': 'next week in the calendar',
  'week-prev': 'last week in the calendar',
  'event-critique': 'the details of Design critique',
  'event-retro': 'the details of Team retro',
  'event-farmers': 'the details of Farmers market',
  'event-prototype': 'the details of Prototype polish',
};
const closeLabel = 'Close the event';

export function Tour({ id, eager, focus = 0 }: { id: TourId; eager?: boolean; focus?: number }) {
  const tour = (tours as Record<TourId, TourData>)[id];
  const [want, setWant] = useState(tour.start); // the screen asked for
  const [shown, setShown] = useState(tour.start); // the screen on view; it changes once the new picture has loaded
  const [was, setWas] = useState(tour.start); // the screen it replaced, kept underneath while the new one fades in
  const [mounted, setMounted] = useState(() => new Set([tour.start]));
  const [glint, setGlint] = useState(false);
  const loaded = useRef(new Set<string>());
  const root = useRef<HTMLDivElement>(null);
  const spots = tour.screens[shown];

  const mount = (more: string[]) =>
    setMounted(m => (more.every(n => m.has(n)) ? m : new Set([...m, ...more])));
  // Only once someone reaches for the window are the screens one click away fetched.
  const warm = () => mount(spots.flatMap(s => (s.to ? [s.to] : [])));
  const show = (to: string) => {
    setWas(shown);
    setShown(to);
  };
  // A screen is ready once its picture loads, or fails to: then its alt text stands in, and the spot still works.
  const arrive = (name: string) => {
    loaded.current.add(name);
    if (name === want && name !== shown) show(name);
  };
  const go = (to: string) => {
    setWant(to);
    mount([to]);
    if (loaded.current.has(to)) show(to);
  };
  const pressed = useRef(false); // a spot was just pressed; its button goes away with the screen it was on
  const press = (spot: Spot) => {
    if (spot.to) {
      pressed.current = true;
      go(spot.to);
    } else if (spot.ask !== undefined)
      window.dispatchEvent(new CustomEvent('aplos:ask', { detail: spot.ask }));
  };
  const close = spots.find(s => s.label === closeLabel);

  useEffect(() => {
    if (want === shown) warm();
    // Keep keyboard focus in the window when the pressed spot disappears, so Tab and Escape keep working.
    if (pressed.current && (!document.activeElement || document.activeElement === document.body))
      root.current?.focus({ preventScroll: true });
    pressed.current = false;
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  // When the window first comes into view, its clickable spots light up once in turn, so it reads as something to press.
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        setGlint(true);
        window.setTimeout(() => setGlint(false), 2400);
      },
      { threshold: 0.6 },
    );
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);
  // On a phone the window is wider than the screen and scrolls sideways; start it on the part that matters.
  useEffect(() => {
    const view = root.current!;
    if (view.scrollWidth > view.clientWidth) view.scrollLeft = view.scrollWidth * focus;
  }, [focus]);

  return (
    <div
      className={`tour${glint ? ' is-glint' : ''}`}
      data-claim="several-accounts"
      ref={root}
      tabIndex={-1}
      onPointerEnter={warm}
      onFocus={warm}
      onPointerDown={warm}
      onKeyDown={event => {
        if (event.key === 'Escape' && close) {
          event.stopPropagation();
          press(close);
        }
      }}
    >
      <div
        className="tour-stage"
        style={{ aspectRatio: `${tour.width} / ${tour.height}` }}
        onClick={event => {
          if (close && !(event.target as Element).closest('.spot')) press(close);
        }}
      >
        {[...mounted].map(name => (
          <div
            key={name}
            className={`tour-frame${name === shown ? ' is-on' : name === was ? ' is-was' : ''}`}
            aria-hidden={name !== shown}
          >
            <Shot
              name={`${id}-${name}`}
              alt={`Aplos Mail showing ${names[name] ?? name}.`}
              width={tour.width}
              height={tour.height}
              eager={eager || name !== tour.start}
              onLoad={() => arrive(name)}
              onError={() => arrive(name)}
            />
          </div>
        ))}
        {spots.map((spot, i) => (
          <button
            key={`${shown}-${spot.label}`}
            type="button"
            className="spot"
            aria-label={spot.ask !== undefined ? `Ask “${spot.label}”` : spot.label}
            style={
              {
                left: `${spot.x}%`,
                top: `${spot.y}%`,
                width: `${spot.w}%`,
                height: `${spot.h}%`,
                '--i': i,
              } as React.CSSProperties
            }
            onClick={() => press(spot)}
          />
        ))}
      </div>
      <p className="sr" aria-live="polite">
        {shown === tour.start ? '' : `Showing ${names[shown] ?? shown}.`}
      </p>
    </div>
  );
}
