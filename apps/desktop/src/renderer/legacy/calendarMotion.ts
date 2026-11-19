import { useEffect, useLayoutEffect, useRef } from 'react';
import { duration, reducedMotion } from './ui/motion';

/**
 * Motion for the calendar: period swipes on the trackpad, slides between periods, pinch zoom of the hour
 * height and FLIP reflow of events. Everything moves with transform and opacity only, and every animation
 * can be taken over midway by the next one.
 */

/** A motion token from tokens.css, for Web Animations (which cannot read CSS variables). */
const tokenCache = new Map<string, string>();
export function easing(
  name: 'ease' | 'ease-out-strong' | 'ease-spring' | 'ease-release' | 'ease-in',
) {
  let value = tokenCache.get(name);
  if (!value) {
    value =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--' + name)
        .trim() || 'ease-out';
    tokenCache.set(name, value);
  }
  return value;
}

/** How far a swipe must travel before letting go moves to the next period. */
export const swipeThreshold = (width: number) => Math.max(60, Math.min(160, width * 0.22));

/**
 * What a released swipe does: 1 for the next period, -1 for the previous one, 0 to spring back.
 * `offset` follows the fingers (content moved left is negative, which shows what comes next).
 * Past the threshold it always moves; a quick flick in the same direction moves from a third of it.
 * Velocity is in px/ms and only counts when it agrees with the offset.
 */
export function swipeDecision(offset: number, velocity: number, width: number): -1 | 0 | 1 {
  const limit = swipeThreshold(width);
  const flick =
    Math.abs(velocity) > 0.45 &&
    Math.abs(offset) > limit / 3 &&
    Math.sign(velocity) === Math.sign(offset);
  if (Math.abs(offset) < limit && !flick) return 0;
  return offset < 0 ? 1 : -1;
}

/** The grid follows the fingers one to one up to the threshold, then with growing resistance. */
export function resist(offset: number, width: number) {
  const limit = swipeThreshold(width);
  const over = Math.abs(offset) - limit;
  if (over <= 0) return offset;
  return Math.sign(offset) * (limit + over / (1 + over / (width * 0.35)));
}

/** Pixels per hour after a pinch step, kept between a full day at a glance and quarter hours you can read. */
export const hourLimits = { min: 28, max: 112 };
export function zoomHour(hour: number, deltaY: number) {
  return (
    Math.round(
      Math.max(hourLimits.min, Math.min(hourLimits.max, hour * Math.exp(-deltaY * 0.01))) * 10,
    ) / 10
  );
}

/** The scroll position that keeps the time under the pointer in place when the hour height changes. */
export function zoomScroll({
  scrollTop,
  pointerY,
  bodyTop,
  from,
  to,
}: {
  scrollTop: number;
  pointerY: number;
  bodyTop: number;
  from: number;
  to: number;
}) {
  const hours = (scrollTop + pointerY - bodyTop) / from;
  // Over the day header there is no time under the pointer; the grid just scales from the top.
  if (hours < 0) return (scrollTop * to) / from;
  return Math.max(0, bodyTop + hours * to - pointerY);
}

/** Where the time grid should open: the current time, or the first plan if it comes sooner, with a little room above. */
export function openingHour(nowHour: number | undefined, firstHour: number | undefined) {
  const target = nowHour === undefined ? (firstHour ?? 8) : Math.min(nowHour, firstHour ?? nowHour);
  return Math.max(0, target - 0.75);
}

export type Box = { x: number; y: number; w: number; h: number };
const sameBox = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.w - b.w) < 0.5 &&
  Math.abs(a.h - b.h) < 0.5;

/** The translation and scale an element is drawn with right now, including a running animation. */
function drawn(el: HTMLElement) {
  const m = new DOMMatrixReadOnly(
    getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform,
  );
  return { x: m.m41, y: m.m42, sx: m.a || 1, sy: m.d || 1 };
}

/**
 * FLIP: the element already sits at `last`; it is drawn from `first` and eases into place. An animation that is
 * still running is taken over from where it is drawn now, so quick successive changes never jump.
 */
export function flip(
  el: HTMLElement,
  first: Box,
  last: Box,
  { spring = false, visual = false }: { spring?: boolean; visual?: boolean } = {},
) {
  let from = first;
  const running = el.getAnimations().filter(a => a.id === 'flip');
  if (running.length && !visual) {
    const t = drawn(el);
    from = { x: first.x + t.x, y: first.y + t.y, w: first.w * t.sx, h: first.h * t.sy };
  }
  for (const a of running) a.cancel();
  if (sameBox(from, last) || reducedMotion()) return;
  const sx = last.w ? from.w / last.w : 1,
    sy = last.h ? from.h / last.h : 1;
  const animation = el.animate(
    [
      {
        transformOrigin: '0 0',
        transform: `translate(${from.x - last.x}px,${from.y - last.y}px) scale(${sx},${sy})`,
      },
      { transformOrigin: '0 0', transform: 'none' },
    ],
    {
      duration: spring ? 260 : duration.slow + 40,
      easing: easing(spring ? 'ease-spring' : 'ease-out-strong'),
    },
  );
  animation.id = 'flip';
}

/** New plans fade in where they land; nothing else about them moves. */
export function fadeIn(el: HTMLElement) {
  if (reducedMotion()) return;
  el.animate(
    [
      { opacity: 0, transform: 'scale(.96)' },
      { opacity: 1, transform: 'none' },
    ],
    { duration: duration.base, easing: easing('ease-out-strong') },
  ).id = 'flip';
}

/** Slides the period tracks in from the side the user travelled toward (or from where a swipe left them). */
export function slideIn(tracks: HTMLElement[], direction: number, from?: number) {
  for (const el of tracks) {
    for (const a of el.getAnimations()) if (a.id === 'slide' || a.id === 'settle') a.cancel();
    el.style.removeProperty('transform');
    el.style.removeProperty('opacity');
    if (reducedMotion() || !direction) continue;
    const start = from ?? direction * Math.min(48, el.offsetWidth * 0.08);
    el.animate(
      [
        { transform: `translateX(${start}px)`, opacity: from === undefined ? 0 : 0.4 },
        { transform: 'none', opacity: 1 },
      ],
      {
        duration: from === undefined ? duration.slow + 20 : duration.slow + 80,
        easing: easing(from === undefined ? 'ease-out-strong' : 'ease-release'),
      },
    ).id = 'slide';
  }
}

type SwipeOptions = {
  host: React.RefObject<HTMLElement | null>;
  /** The elements that follow the fingers (the day heads, all-day bars and columns, but not the hour labels). */
  tracks: () => HTMLElement[];
  enabled: boolean;
  /** A released swipe that went far enough: 1 next, -1 previous. `offset` is where the tracks were left. */
  onCommit: (direction: 1 | -1, offset: number) => void;
  /** ⌘/ctrl + wheel, which is also what a trackpad pinch sends. */
  onZoom?: (deltaY: number, clientY: number) => void;
};

const quiet = 120;

/**
 * Two-finger horizontal swipes page through periods. The tracks follow the fingers live; when the wheel goes
 * quiet the swipe settles into the next period or springs back, by distance and speed. A gesture locks to the
 * axis it started on, so vertical scrolling never pages, and a committed swipe swallows the momentum after it.
 * Horizontal wheel events are taken (preventDefault), so the browser never reads them as back/forward.
 */
export function usePeriodSwipe({ host, tracks, enabled, onCommit, onZoom }: SwipeOptions) {
  const latest = useRef({ tracks, enabled, onCommit, onZoom });
  latest.current = { tracks, enabled, onCommit, onZoom };
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const s = {
      mode: 'idle' as 'idle' | 'swipe' | 'vertical' | 'locked',
      offset: 0,
      width: 1,
      samples: [] as [number, number][],
      timer: 0 as unknown as ReturnType<typeof setTimeout>,
    };
    const paint = (x: number) => {
      const shown = resist(x, s.width);
      for (const t of latest.current.tracks()) {
        t.style.transform = `translateX(${shown.toFixed(1)}px)`;
        t.style.opacity = String(1 - Math.min(0.5, (Math.abs(shown) / s.width) * 0.9));
      }
    };
    function begin() {
      const list = latest.current.tracks();
      // Take over from a spring-back or slide that is still running, from where it is drawn.
      const t = list[0] && list[0].getAnimations().length ? drawn(list[0]).x : 0;
      for (const node of list)
        for (const a of node.getAnimations()) if (a.id === 'slide' || a.id === 'settle') a.cancel();
      s.mode = 'swipe';
      s.offset = t;
      s.width = Math.max(1, list[0]?.offsetWidth ?? host.current?.offsetWidth ?? 1);
      s.samples = [];
    }
    function settleBack() {
      const list = latest.current.tracks();
      const from = resist(s.offset, s.width);
      for (const t of list) {
        t.style.removeProperty('transform');
        t.style.removeProperty('opacity');
        if (reducedMotion() || !from) continue;
        t.animate(
          [
            {
              transform: `translateX(${from}px)`,
              opacity: 1 - Math.min(0.5, (Math.abs(from) / s.width) * 0.9),
            },
            { transform: 'none', opacity: 1 },
          ],
          { duration: duration.slow + 60, easing: easing('ease-out-strong') },
        ).id = 'settle';
      }
    }
    function release() {
      const now = performance.now();
      const [t0, x0] = s.samples[0] ?? [now, s.offset];
      const [t1, x1] = s.samples.at(-1) ?? [now, s.offset];
      const velocity = t1 > t0 && now - t1 < quiet + 40 ? (x1 - x0) / (t1 - t0) : 0;
      const direction = swipeDecision(s.offset, velocity, s.width);
      if (direction) {
        s.mode = 'locked';
        s.timer = setTimeout(() => {
          s.mode = 'idle';
        }, quiet);
        latest.current.onCommit(direction, resist(s.offset, s.width));
      } else {
        s.mode = 'idle';
        settleBack();
      }
      s.offset = 0;
    }
    function wheel(e: WheelEvent) {
      const o = latest.current;
      if (!o.enabled) return;
      if (e.ctrlKey || e.metaKey) {
        if (o.onZoom) {
          e.preventDefault();
          o.onZoom(e.deltaY * (e.deltaMode === 1 ? 16 : 1), e.clientY);
        }
        return;
      }
      const scale = e.deltaMode === 1 ? 16 : 1;
      const dx = e.deltaX * scale,
        dy = e.deltaY * scale;
      const now = performance.now();
      clearTimeout(s.timer);
      const done = () => {
        if (s.mode === 'swipe') release();
        else s.mode = 'idle';
      };
      if (s.mode === 'locked' || s.mode === 'vertical') {
        // Momentum after a page turn, or a vertical scroll still coasting: wait until the wheel goes quiet.
        if (Math.abs(dx) > Math.abs(dy)) e.preventDefault();
        s.timer = setTimeout(done, quiet);
        return;
      }
      if (s.mode === 'idle') {
        if (Math.abs(dy) >= Math.abs(dx) || Math.abs(dx) < 2) {
          if (Math.abs(dy) > 0) {
            s.mode = 'vertical';
            s.timer = setTimeout(done, quiet);
          }
          return;
        }
        begin();
      }
      if (s.mode !== 'swipe') return;
      e.preventDefault();
      // Natural scrolling: fingers moving left send a positive deltaX, and the grid moves left with them.
      s.offset -= dx;
      s.samples.push([now, s.offset]);
      while (s.samples.length > 2 && now - s.samples[0][0] > 100) s.samples.shift();
      paint(s.offset);
      s.timer = setTimeout(done, quiet);
    }
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', wheel);
      clearTimeout(s.timer);
    };
  }, [host]);
}

/** Runs `slideIn` on the tracks when the period changes, in the direction recorded just before the change. */
export function usePeriodSlide(
  key: string,
  tracks: () => HTMLElement[],
  pending: React.RefObject<{ direction: number; from?: number } | null>,
) {
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const next = pending.current;
    pending.current = null;
    slideIn(tracks(), next?.direction ?? 0, next?.from);
  }, [key]);
}
