import { useEffect, useRef } from 'react';
import { reducedMotion } from './motion';

export type SwipeSide = 'left' | 'right';
type Options = {
  enabled: boolean;
  /** The element that follows the gesture. It receives `--swipe-x` (px), `--swipe-p` (0–1 toward the threshold),
   *  `--swipe-f` (signed share of its width) and the `data-swipe*` attributes CSS styles from. */
  host: React.RefObject<HTMLElement | null>;
  /** Names the action each side triggers; exposed as `data-swipe-action`. */
  actionFor: (side: SwipeSide) => string;
  onCommit: (side: SwipeSide, offset: number, width: number) => void;
  /** Whether a pointer drag may start on this element. Trackpad swipes are always allowed. */
  canStart?: (target: HTMLElement, pointerType: string) => boolean;
  /** Called when a gesture starts and once the element is back at rest, e.g. to render the revealed action. */
  onActive?: (active: boolean) => void;
};

const slop = 8;
const threshold = (width: number) => Math.max(80, Math.min(180, width * 0.32));
const momentumGap = 120;

/**
 * Horizontal drag and two-finger trackpad swipe with live feedback. The offset is written straight to the DOM so
 * a gesture never re-renders React; React-managed classes stay untouched because state lives in data attributes.
 * A release past the threshold, or a quick flick in one direction, commits; anything else springs back.
 */
export function useSwipe({ enabled, host, actionFor, onCommit, canStart, onActive }: Options) {
  const latest = useRef({ actionFor, onCommit, canStart, onActive, enabled });
  latest.current = { actionFor, onCommit, canStart, onActive, enabled };
  const g = useRef({
    mode: 'idle' as 'idle' | 'pending' | 'drag' | 'wheel' | 'fling',
    pointer: -1,
    sx: 0,
    sy: 0,
    x: 0,
    width: 0,
    limit: 0,
    samples: [] as [number, number][],
    wheelTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    lockUntil: 0,
    verticalUntil: 0,
    settleTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    suppressClick: false,
    detach: undefined as undefined | (() => void),
  });

  function el() {
    return host.current;
  }
  function paint(x: number) {
    const node = el();
    if (!node) return;
    const s = g.current;
    s.x = x;
    node.style.setProperty('--swipe-x', `${x.toFixed(1)}px`);
    node.style.setProperty('--swipe-p', Math.min(1, Math.abs(x) / s.limit).toFixed(3));
    node.style.setProperty('--swipe-f', (x / Math.max(1, s.width)).toFixed(4));
    // Attribute writes invalidate selectors (including `:has()` elsewhere), so only touch them when they change.
    const side = x === 0 ? undefined : x > 0 ? 'right' : 'left';
    if (node.dataset.swipe !== side) {
      if (side) {
        node.dataset.swipe = side;
        node.dataset.swipeAction = latest.current.actionFor(side);
      } else {
        delete node.dataset.swipe;
        delete node.dataset.swipeAction;
      }
    }
    const armed = Math.abs(x) >= s.limit;
    if (node.hasAttribute('data-armed') !== armed) node.toggleAttribute('data-armed', armed);
  }
  function begin(mode: 'drag' | 'wheel') {
    const node = el();
    if (!node) return false;
    const s = g.current;
    clearTimeout(s.settleTimer);
    s.mode = mode;
    s.width = node.offsetWidth;
    s.limit = threshold(s.width);
    s.samples = [];
    node.dataset.swipeState = 'drag';
    latest.current.onActive?.(true);
    return true;
  }
  function clear() {
    const node = el();
    const s = g.current;
    s.mode = 'idle';
    if (node) {
      for (const name of ['--swipe-x', '--swipe-p', '--swipe-f']) node.style.removeProperty(name);
      delete node.dataset.swipe;
      delete node.dataset.swipeAction;
      delete node.dataset.swipeState;
      node.removeAttribute('data-armed');
    }
    latest.current.onActive?.(false);
  }
  function settle() {
    const node = el();
    const s = g.current;
    s.detach?.();
    if (!node || reducedMotion() || s.x === 0) {
      clear();
      return;
    }
    // Keep the side and action attributes so the revealed action stays put while the element slides back over it.
    s.mode = 'idle';
    s.x = 0;
    node.dataset.swipeState = 'settle';
    node.removeAttribute('data-armed');
    for (const name of ['--swipe-x', '--swipe-p', '--swipe-f'])
      node.style.setProperty(name, name === '--swipe-x' ? '0px' : '0');
    clearTimeout(s.settleTimer);
    s.settleTimer = setTimeout(clear, 240);
  }
  function track(x: number) {
    const s = g.current;
    const now = performance.now();
    s.samples.push([now, x]);
    while (s.samples.length > 2 && now - s.samples[0][0] > 100) s.samples.shift();
    paint(Math.max(-s.width, Math.min(s.width, x)));
  }
  function release() {
    const s = g.current;
    s.detach?.();
    const node = el();
    if (!node) {
      clear();
      return false;
    }
    const [t0, x0] = s.samples[0] ?? [0, s.x];
    const [t1, x1] = s.samples.at(-1) ?? [0, s.x];
    // Velocity only counts if the pointer was still moving; a pause before letting go means the user is deciding.
    const velocity = t1 > t0 && performance.now() - t1 < 80 ? (x1 - x0) / (t1 - t0) : 0;
    const flick =
      Math.abs(velocity) > 0.6 &&
      Math.abs(s.x) > s.limit * 0.3 &&
      Math.sign(velocity) === Math.sign(s.x);
    if (Math.abs(s.x) < s.limit && !flick) {
      settle();
      return false;
    }
    const side: SwipeSide = s.x > 0 ? 'right' : 'left';
    const offset = s.x,
      width = s.width;
    s.mode = 'fling';
    node.dataset.swipeState = 'fling';
    node.setAttribute('data-armed', '');
    node.style.setProperty('--swipe-x', `${Math.sign(offset) * (width + 48)}px`);
    latest.current.onCommit(side, offset, width);
    // Usually the element leaves the list right away; if it is still here (the action failed, or the view keeps it), bring it back.
    clearTimeout(s.settleTimer);
    s.settleTimer = setTimeout(() => {
      if (el()?.isConnected && g.current.mode === 'fling') {
        g.current.x = Math.sign(offset) * (width + 48);
        settle();
      }
    }, 900);
    return true;
  }

  function onPointerDown(e: React.PointerEvent<HTMLElement>) {
    const s = g.current;
    if (
      !latest.current.enabled ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      s.mode !== 'idle'
    )
      return;
    const target = e.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (latest.current.canStart && !latest.current.canStart(target, e.pointerType)) return;
    s.mode = 'pending';
    s.pointer = e.pointerId;
    s.sx = e.clientX;
    s.sy = e.clientY;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== s.pointer) return;
      const dx = ev.clientX - s.sx,
        dy = ev.clientY - s.sy;
      if (s.mode === 'pending') {
        if (Math.abs(dy) >= slop && Math.abs(dy) > Math.abs(dx)) {
          s.detach?.();
          s.mode = 'idle';
          return;
        }
        if (Math.abs(dx) < slop || Math.abs(dx) < Math.abs(dy) * 1.3) return;
        if (!begin('drag')) {
          s.detach?.();
          return;
        }
        s.sx += Math.sign(dx) * slop;
        try {
          el()?.setPointerCapture(s.pointer);
        } catch {
          /* The pointer may already be gone. */
        }
        getSelection()?.removeAllRanges();
      }
      if (s.mode === 'drag') {
        ev.preventDefault();
        track(ev.clientX - s.sx);
      }
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== s.pointer) return;
      if (s.mode === 'drag') {
        s.suppressClick = true;
        setTimeout(() => {
          s.suppressClick = false;
        }, 0);
        if (ev.type === 'pointercancel') settle();
        else release();
      } else {
        s.detach?.();
        if (s.mode === 'pending') s.mode = 'idle';
      }
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && s.mode === 'drag') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        s.suppressClick = true;
        setTimeout(() => {
          s.suppressClick = false;
        }, 0);
        settle();
      }
    };
    addEventListener('pointermove', move, { passive: false });
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
    addEventListener('keydown', key, true);
    s.detach = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      removeEventListener('keydown', key, true);
      s.detach = undefined;
    };
  }

  /** Wide content such as a newsletter table scrolls sideways; let it scroll until it reaches its edge. */
  function scrollsSideways(target: EventTarget | null, dx: number) {
    const root = el();
    for (
      let node = target as HTMLElement | null;
      node && node !== root;
      node = node.parentElement
    ) {
      if (node.scrollWidth <= node.clientWidth + 1) continue;
      const overflow = getComputedStyle(node).overflowX;
      if (overflow !== 'auto' && overflow !== 'scroll') continue;
      if (dx > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0)
        return true;
    }
    return false;
  }

  function onWheel(e: React.WheelEvent<HTMLElement>) {
    const s = g.current;
    const now = performance.now();
    if (!latest.current.enabled || e.ctrlKey) return;
    const scale = e.deltaMode === 1 ? 16 : 1;
    const dx = e.deltaX * scale,
      dy = e.deltaY * scale;
    // After a swipe ends, the trackpad keeps sending momentum; ignore it until it goes quiet.
    if (now < s.lockUntil) {
      s.lockUntil = now + momentumGap * 2;
      return;
    }
    if (s.mode === 'idle') {
      if (now < s.verticalUntil || Math.abs(dx) <= Math.abs(dy) * 1.5 || Math.abs(dx) < 1) {
        if (Math.abs(dy) >= Math.abs(dx)) s.verticalUntil = now + momentumGap;
        return;
      }
      if (scrollsSideways(e.target, dx)) {
        s.verticalUntil = now + momentumGap;
        return;
      }
      if (!begin('wheel')) return;
      s.sx = 0;
    }
    if (s.mode !== 'wheel') return;
    // Natural scrolling: fingers moving right send a negative deltaX, and the element should follow the fingers.
    s.sx -= dx;
    track(s.sx);
    clearTimeout(s.wheelTimer);
    // Only a commit swallows the momentum that follows. A swipe that springs back stays open to input, so pausing
    // mid-swipe and carrying on works.
    const finish = () => {
      if (release()) s.lockUntil = performance.now() + momentumGap * 2;
    };
    // A trackpad has no "finger lifted" event; past 1.4× the threshold commit right away instead of waiting for momentum to fade.
    if (Math.abs(s.x) >= s.limit * 1.4) {
      finish();
      return;
    }
    s.wheelTimer = setTimeout(finish, momentumGap);
  }

  function onClickCapture(e: React.MouseEvent) {
    if (g.current.suppressClick || g.current.mode === 'fling') {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  useEffect(
    () => () => {
      const s = g.current;
      s.detach?.();
      clearTimeout(s.wheelTimer);
      clearTimeout(s.settleTimer);
    },
    [],
  );
  useEffect(() => {
    if (!enabled && g.current.mode !== 'idle' && g.current.mode !== 'fling') settle();
  }, [enabled]);
  return { onPointerDown, onWheel, onClickCapture };
}
