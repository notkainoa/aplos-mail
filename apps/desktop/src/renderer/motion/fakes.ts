// Test doubles for the motion runtime: a virtual clock with timers and 60 Hz
// requestAnimationFrame, visibility and reduced-motion switches, and just
// enough of an element (style, attributes, tree, rect, events) with a
// recording Element.animate. Animations finish when the clock passes their end.
import type { MotionEnv, TimerHandle } from './env';

export const FRAME_MS = 1000 / 60;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export class FakeAnimation {
  playState: 'running' | 'finished' | 'idle' = 'running';
  onfinish: (() => void) | null = null;
  oncancel: (() => void) | null = null;
  readonly endsAt: number;

  constructor(
    readonly target: FakeElement,
    readonly keyframes: readonly Keyframe[],
    readonly options: KeyframeAnimationOptions,
    readonly startedAt: number,
  ) {
    this.endsAt = startedAt + Number(options.delay ?? 0) + Number(options.duration ?? 0);
  }

  finish() {
    if (this.playState !== 'running') return;
    this.playState = 'finished';
    this.onfinish?.();
  }

  cancel() {
    if (this.playState !== 'running') return;
    this.playState = 'idle';
    this.oncancel?.();
  }
}

type Listener = () => void;

/** A CSSStyleDeclaration stand-in: every property reads '' until set, as an unset one does. */
class FakeStyle {
  [property: string]: string;
  transform = '';
  opacity = '';
  willChange = '';
  visibility = '';
}

export class FakeElement {
  readonly style = new FakeStyle();
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly fake: FakeEnv,
    readonly name = 'div',
  ) {}

  get ownerDocument() {
    return this.fake.document;
  }

  get isConnected(): boolean {
    const root = this.fake.document.documentElement;
    for (let node = this.parent; node; node = node.parent) if (node === root) return true;
    return this === root;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  appendChild(child: FakeElement) {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) return;
    const siblings = this.parent.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }

  descendants(): FakeElement[] {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }

  /** Only `[attr]` selectors. */
  querySelectorAll(selector: string): FakeElement[] {
    const attr = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    if (!attr) throw new Error(`Fake selector not supported: ${selector}`);
    return this.descendants().filter(el => el.hasAttribute(attr));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  cloneNode(deep = false): FakeElement {
    const copy = new FakeElement(this.fake, this.name);
    Object.assign(copy.style, this.style);
    for (const [k, v] of this.attributes) copy.attributes.set(k, v);
    copy.rect = { ...this.rect };
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }

  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height };
  }

  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
    const animation = new FakeAnimation(this, keyframes, options, this.fake.now);
    this.fake.animations.push(animation);
    return animation;
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  /** As the real type, for code under test. */
  get el(): HTMLElement {
    return this as unknown as HTMLElement;
  }
}

interface FakeTimer {
  readonly id: number;
  readonly due: number;
  readonly callback: () => void;
}

export class FakeEnv {
  now = 0;
  hidden = false;
  reduced = false;
  flushes = 0;
  frames = 0;
  readonly animations: FakeAnimation[] = [];
  readonly document: { documentElement: FakeElement; body: FakeElement };
  private timers: FakeTimer[] = [];
  private rafs = new Map<number, (time: number) => void>();
  private nextId = 1;
  private visibilityListeners = new Set<() => void>();

  constructor(options: { reduced?: boolean; hidden?: boolean } = {}) {
    this.reduced = options.reduced ?? false;
    this.hidden = options.hidden ?? false;
    const documentElement = new FakeElement(this, 'html');
    const body = new FakeElement(this, 'body');
    documentElement.appendChild(body);
    this.document = { documentElement, body };
  }

  readonly env: MotionEnv = {
    now: () => this.now,
    requestFrame: callback => {
      const id = this.nextId++;
      this.rafs.set(id, callback);
      return id;
    },
    cancelFrame: id => {
      this.rafs.delete(id);
    },
    setTimer: (callback, ms) => {
      const timer = { id: this.nextId++, due: this.now + Math.max(0, ms), callback };
      this.timers.push(timer);
      return timer.id as unknown as TimerHandle;
    },
    clearTimer: handle => {
      this.timers = this.timers.filter(t => t.id !== (handle as unknown as number));
    },
    isHidden: () => this.hidden,
    onVisibilityChange: listener => {
      this.visibilityListeners.add(listener);
      return () => this.visibilityListeners.delete(listener);
    },
    prefersReducedMotion: () => this.reduced,
    flushStyle: () => {
      this.flushes += 1;
    },
  };

  element(rect?: Partial<Rect>, parent: FakeElement = this.document.body): FakeElement {
    const el = new FakeElement(this);
    el.rect = { left: 0, top: 0, width: 0, height: 0, ...rect };
    parent.appendChild(el);
    return el;
  }

  setHidden(hidden: boolean) {
    this.hidden = hidden;
    for (const listener of [...this.visibilityListeners]) listener();
  }

  /** Animations still running, like document.getAnimations(). */
  running(): FakeAnimation[] {
    return this.animations.filter(a => a.playState === 'running');
  }

  pendingFrames(): number {
    return this.rafs.size;
  }

  private nextFrameAt(): number {
    return (Math.floor(this.now / FRAME_MS + 1e-9) + 1) * FRAME_MS;
  }

  /** Moves the clock forward, firing timers, animation ends and frames in time order. */
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const timerAt = Math.min(...this.timers.map(t => t.due));
      const animationAt = Math.min(...this.running().map(a => a.endsAt));
      const frameAt = this.rafs.size > 0 && !this.hidden ? this.nextFrameAt() : Infinity;
      const next = Math.min(timerAt, animationAt, frameAt);
      if (next > until + 1e-9) break;
      this.now = Math.max(this.now, next);
      if (timerAt === next) {
        const due = this.timers.filter(t => t.due <= this.now);
        this.timers = this.timers.filter(t => t.due > this.now);
        for (const timer of due) timer.callback();
      } else if (animationAt === next) {
        for (const animation of this.running())
          if (animation.endsAt <= this.now) animation.finish();
      } else {
        const callbacks = [...this.rafs.values()];
        this.rafs.clear();
        this.frames += 1;
        for (const callback of callbacks) callback(this.now);
      }
    }
    this.now = until;
  }
}

/** A small seeded PRNG (mulberry32), so fuzz runs repeat. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
