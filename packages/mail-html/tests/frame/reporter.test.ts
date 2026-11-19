import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { frameHeaders } from '../../src/frame/headers';
import {
  REPORTER_SOURCE,
  reporterHash,
  reporterTag,
  sha256Base64,
  withReporter,
} from '../../src/frame/reporter';

// The frame's one script. CI guard: the shipped file, the embedded copy, the hash and the CSP
// must agree byte for byte. Then the script runs against a hand-rolled fake DOM in a fresh
// context that holds `window` and nothing else, so a bare-name global read throws (and posts
// nothing, which the tests catch).

const ASSET = join(import.meta.dirname, '../../assets/reporter.js');
const TOKEN = '0123456789abcdef0123456789abcdef';

describe('reporter: the shipped file and its hash', () => {
  it('embeds the shipped file byte for byte', () => {
    const shipped = readFileSync(ASSET);
    assert.deepEqual(new Uint8Array(shipped), new TextEncoder().encode(REPORTER_SOURCE));
  });

  it('hashes the shipped bytes, and the CSP carries that hash', async () => {
    const fromFile = createHash('sha256').update(readFileSync(ASSET)).digest('base64');
    assert.equal(await reporterHash(), fromFile);
    assert.ok(frameHeaders(fromFile)['content-security-policy'].includes(`'sha256-${fromFile}'`));
    assert.ok(frameHeaders(await reporterHash())['content-security-policy'].includes(fromFile));
  });

  it('computes SHA-256 correctly (known vectors)', async () => {
    assert.equal(await sha256Base64(''), '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
    assert.equal(await sha256Base64('abc'), 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });

  it('is tiny, ASCII, and cannot end its own script element', () => {
    assert.ok(REPORTER_SOURCE.length < 8_192, `${REPORTER_SOURCE.length} bytes`);
    assert.match(REPORTER_SOURCE, /^[\x20-\x7e\n]*$/);
    assert.equal(/<\/script|<!--/i.test(REPORTER_SOURCE), false);
  });

  it('uses nothing on the denylist', () => {
    const denied = [
      'eval',
      'Function(',
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'cookie',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'XMLHttpRequest',
      'fetch(',
      'import(',
      'import ',
      'export ',
      'require(',
      'WebSocket',
      'sendBeacon',
      'location.href',
      'location.assign',
      'location.replace',
      'window.open',
      '.open(',
      'top.',
      'parent.location',
      'opener',
      'setInterval',
      'textContent',
      'innerText',
      'Worker',
    ];
    for (const word of denied) assert.equal(REPORTER_SOURCE.includes(word), false, word);
  });

  it('reads setTimeout only as a member captured from the window, never as a bare global', () => {
    const uses = REPORTER_SOURCE.match(/setTimeout/g)?.length ?? 0;
    const captured = REPORTER_SOURCE.match(/w\.setTimeout/g)?.length ?? 0;
    assert.ok(uses > 0 && uses === captured, `${uses} uses, ${captured} through w.setTimeout`);
    assert.equal(/setInterval/.test(REPORTER_SOURCE), false);
  });

  it('is placed last in the body, hashed text exactly between the tags', () => {
    const doc = '<html><body><p>x</p></body></html>';
    assert.equal(
      withReporter(doc),
      `<html><body><p>x</p><script>${REPORTER_SOURCE}</script></body></html>`,
    );
    assert.equal(withReporter('<p>x</p>'), `<p>x</p>${reporterTag()}`);
  });
});

interface Posted {
  message: Record<string, unknown>;
  target: string;
}

interface FakeOptions {
  innerWidth?: number;
  pathname?: string;
  /** The root element's box height (the content), and the frame-sized scroll height the old code read. */
  box?: number;
  rootScroll?: number;
  bodyScroll?: number;
  /** The body's top edge in the viewport, and how far the frame is scrolled. */
  bodyTop?: number;
  scrollY?: number;
  resizeObserver?: 'ok' | 'throws' | 'missing';
  /** A page has a clock, animation frames and timers; `false` is a page without them. */
  frames?: boolean;
  marks?: number;
  bodyPaint?: string;
  rootPaint?: string;
  /** The root carries `data-aplos-plain`. */
  plain?: boolean;
}

const captured: Record<string, boolean> = {};

class FakeTarget {
  kind = 'window';
  constructor(readonly listeners: Record<string, (() => void)[]>) {}
  addEventListener(type: string, fn: () => void, capture?: boolean): void {
    (this.listeners[`${this.kind}:${type}`] ??= []).push(fn);
    captured[`${this.kind}:${type}`] = capture === true;
  }
}

class FakeElement {
  constructor(
    readonly scroll: number,
    public box: number,
    public paint: string,
    readonly top = 0,
  ) {}
  get scrollHeight(): number {
    return this.scroll;
  }
  getBoundingClientRect(): { height: number; top: number } {
    return { height: this.box, top: this.top };
  }
  /** The sanitiser's plain marker on the root (plain.ts). */
  marked = false;
  hasAttribute(name: string): boolean {
    return name === 'data-aplos-plain' && this.marked;
  }
}

class FakeDocument extends FakeTarget {
  readyStateValue = 'interactive';
  fontsDone: (() => void) | undefined;
  constructor(
    listeners: Record<string, (() => void)[]>,
    readonly rootElement: FakeElement,
    readonly bodyElement: FakeElement,
    readonly markCount: number,
  ) {
    super(listeners);
    this.kind = 'document';
  }
  get documentElement(): FakeElement {
    return this.rootElement;
  }
  get body(): FakeElement {
    return this.bodyElement;
  }
  get readyState(): string {
    return this.readyStateValue;
  }
  get fonts() {
    return { ready: { then: (ok: () => void) => (this.fontsDone = ok) } };
  }
  queries = 0;
  querySelectorAll(selector: string): { length: number } {
    assert.equal(selector, 'mark.aplos-find');
    this.queries += 1;
    return { length: this.markCount };
  }
}

/** A window with just enough DOM for the script: members live on prototypes, as in a browser. */
function fakeWindow(options: FakeOptions = {}) {
  const posted: Posted[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const observers: (() => void)[] = [];
  const observed: unknown[] = [];
  const root = new FakeElement(
    options.rootScroll ?? 900,
    options.box ?? 500,
    options.rootPaint ?? 'rgba(0, 0, 0, 0)',
  );
  root.marked = options.plain === true;
  const body = new FakeElement(
    options.bodyScroll ?? 300,
    0,
    options.bodyPaint ?? 'rgb(255, 255, 255)',
    options.bodyTop ?? 0,
  );
  const document = new FakeDocument(listeners, root, body, options.marks ?? 0);
  const window = Object.assign(new FakeTarget(listeners), {
    document,
    Object,
    Math,
    isFinite,
    Document: FakeDocument,
    Element: FakeElement,
    EventTarget: FakeTarget,
    innerWidth: options.innerWidth ?? 640,
    scrollY: options.scrollY ?? 0,
    location: { pathname: options.pathname ?? `/${TOKEN}/` },
    parent: {
      postMessage: (message: Record<string, unknown>, target: string) => {
        posted.push({ message, target });
      },
    },
    getComputedStyle: (element: FakeElement) => ({ backgroundColor: element.paint }),
    ResizeObserver: undefined as unknown,
  });
  if (options.resizeObserver !== 'missing') {
    window.ResizeObserver = function (callback: () => void) {
      if (options.resizeObserver === 'throws') throw new Error('no observer');
      observers.push(callback);
      return { observe: (element: unknown) => observed.push(element) };
    };
  }
  const clock = { now: 0 };
  const queue: (() => void)[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  if (options.frames !== false) {
    Object.assign(window, {
      performance: { now: () => clock.now },
      requestAnimationFrame: (callback: () => void) => queue.push(callback),
      setTimeout: (run: () => void, ms: number) => timers.push({ run, ms }),
    });
  }
  const runFrame = () => queue.splice(0).forEach(callback => callback());
  const runTimers = () => timers.splice(0).forEach(timer => timer.run());
  const fireOnly = (name: string) => listeners[name]?.forEach(fn => fn());
  /** An event, then the next animation frame (what a page on screen does). */
  const fire = (name: string) => {
    fireOnly(name);
    runFrame();
  };
  return {
    window,
    document,
    root,
    body,
    posted,
    listeners,
    observers,
    observed,
    fire,
    fireOnly,
    clock,
    queue,
    timers,
    runFrame,
    runTimers,
  };
}

function run(fake: ReturnType<typeof fakeWindow>, source = REPORTER_SOURCE): void {
  runInNewContext(source, { window: fake.window });
}

describe('reporter: behaviour in a fake DOM', () => {
  it('posts exactly the seven keys at body end', () => {
    const fake = fakeWindow({ marks: 3 });
    run(fake);
    assert.equal(fake.posted.length, 1);
    assert.deepEqual(Object.keys(fake.posted[0].message), [
      'token',
      'h',
      'w',
      'bg',
      'ready',
      'marks',
      'plain',
    ]);
    assert.deepEqual(
      { ...fake.posted[0].message },
      {
        token: TOKEN,
        h: 500,
        w: 640,
        bg: 'rgb(255, 255, 255)',
        ready: false,
        marks: 3,
        plain: false,
      },
    );
    assert.equal(fake.posted[0].target, '*');
  });

  it('reports plain only when the root carries the sanitiser’s marker, and never from the background colour', () => {
    const marked = fakeWindow({ plain: true });
    run(marked);
    assert.equal(marked.posted[0].message.plain, true);
    // A mail can paint any body colour, the host's sentinel included: the colour is no signal.
    for (const bodyPaint of ['rgb(33, 34, 37)', 'rgb(255, 255, 254)']) {
      const forged = fakeWindow({ bodyPaint });
      run(forged);
      assert.equal(forged.posted[0].message.plain, false, bodyPaint);
    }
  });

  it('reports again on every listed event, when something changed', () => {
    const fake = fakeWindow();
    run(fake);
    fake.document.readyStateValue = 'complete';
    let expected = 1;
    const change = () => {
      fake.root.box += 1;
      expected += 1;
    };
    for (const name of [
      'document:DOMContentLoaded',
      'document:toggle',
      'document:animationend',
      'document:animationcancel',
      'document:transitionend',
      'window:load',
      'window:error',
      'window:resize',
    ]) {
      change();
      fake.fire(name);
      assert.equal(fake.posted.length, expected, name);
    }
    change();
    fake.observers.forEach(callback => callback());
    fake.runFrame();
    change();
    fake.document.fontsDone?.();
    fake.runFrame();
    assert.equal(fake.posted.length, expected);
    assert.equal(fake.posted.at(-1)?.message.ready, true);
  });

  it('listens in the capture phase for the events that do not bubble', () => {
    const fake = fakeWindow();
    run(fake);
    for (const name of [
      'window:load',
      'window:error',
      'document:toggle',
      'document:animationend',
      'document:animationcancel',
      'document:transitionend',
    ]) {
      assert.equal(fake.listeners[name]?.length, 1, name);
      assert.equal(captured[name], true, `${name} in the capture phase`);
    }
  });

  it('measures nothing inside an event: it asks for a look on the next frame', () => {
    const fake = fakeWindow({ marks: 2 });
    run(fake);
    assert.equal(fake.document.queries, 1, 'the marks are counted once, at the start');
    fake.root.box += 100;
    for (const name of Object.keys(fake.listeners)) fake.fireOnly(name);
    assert.equal(fake.posted.length, 1, 'no report inside an event');
    fake.runFrame();
    assert.equal(fake.posted.length, 2);
    assert.equal(fake.posted[1].message.marks, 2);
    for (let step = 0; step < 50; step++) {
      fake.root.box += 1;
      fake.fire('window:resize');
    }
    assert.equal(fake.document.queries, 1, 'no query over the letter in all those frames');
  });

  it('watches the root and the body for a change of size', () => {
    const fake = fakeWindow();
    run(fake);
    assert.deepEqual(fake.observed, [fake.root, fake.body]);
  });

  it('posts nothing when nothing changed', () => {
    const fake = fakeWindow();
    run(fake);
    for (const name of Object.keys(fake.listeners)) fake.fire(name);
    fake.observers.forEach(callback => callback());
    fake.document.fontsDone?.();
    fake.runFrame();
    assert.equal(fake.posted.length, 1);
  });

  it('does not post for a change of colour alone, but the next report carries the new colour', () => {
    const fake = fakeWindow();
    run(fake);
    fake.body.paint = 'rgb(1, 2, 3)';
    fake.fire('window:resize');
    assert.equal(fake.posted.length, 1, 'a colour animation costs nothing');
    fake.root.box += 1;
    fake.fire('window:resize');
    assert.equal(fake.posted.length, 2);
    assert.equal(fake.posted[1].message.bg, 'rgb(1, 2, 3)');
  });

  it('posts at most 20 times a second, then the last state in the next second', () => {
    const fake = fakeWindow();
    run(fake);
    for (let step = 1; step <= 40; step++) {
      fake.root.box = 400 + step;
      fake.fire('window:resize');
    }
    assert.equal(fake.posted.length, 20, 'the first report and 19 more');
    assert.equal(fake.queue.length, 1, 'one frame is waiting to post the rest');
    fake.clock.now = 1001;
    fake.runFrame();
    assert.equal(fake.posted.length, 21);
    assert.equal(fake.posted.at(-1)?.message.h, 440);
  });

  it('still posts the held-back state when the quiet period has passed', () => {
    const fake = fakeWindow();
    run(fake);
    for (let step = 1; step <= 40; step++) {
      fake.root.box = 400 + step;
      fake.fire('window:resize');
    }
    fake.clock.now = 9000; // far past the last change
    fake.runFrame();
    assert.equal(fake.posted.at(-1)?.message.h, 440, 'the loop kept going for the held state');
  });

  it('posts the held-back state from a timer when animation frames never come (off screen)', () => {
    const fake = fakeWindow();
    run(fake);
    assert.equal(fake.timers[0]?.ms, 250, 'a timer is asked for beside the frame');
    for (let step = 1; step <= 40; step++) {
      fake.root.box = 400 + step;
      fake.fireOnly('window:resize');
      fake.runTimers();
    }
    assert.equal(fake.posted.length, 20, 'limited, with no frame having run');
    fake.clock.now = 1001;
    fake.runTimers();
    assert.equal(fake.posted.length, 21);
    assert.equal(fake.posted.at(-1)?.message.h, 440);
  });

  it('runs a look once: whichever of the frame and the timer comes first, the other does nothing', () => {
    const fake = fakeWindow();
    run(fake);
    fake.root.box += 50;
    fake.fireOnly('window:resize');
    fake.runTimers();
    assert.equal(fake.posted.length, 2);
    const waiting = fake.queue.length;
    fake.runFrame(); // the first call's frame, now stale, and the new look's frame
    assert.equal(fake.posted.length, 2, 'nothing more to report');
    assert.ok(waiting >= 1);
  });

  it('a stale frame or timer from an earlier look does nothing once a newer look is asked for', () => {
    const fake = fakeWindow();
    run(fake);
    fake.root.box += 50;
    fake.fireOnly('window:resize'); // look 1: a frame and a timer
    fake.runTimers(); // look 1 runs by its timer and asks for look 2
    assert.equal(fake.posted.length, 2);
    fake.root.box += 10;
    const [staleFrame, newFrame] = fake.queue;
    staleFrame(); // look 1's frame arrives late
    assert.equal(fake.posted.length, 2, 'it is ignored');
    newFrame();
    assert.equal(fake.posted.length, 3, 'look 2 sees the change');
  });

  it('a report that changes only readiness does not extend the watch', () => {
    const fake = fakeWindow();
    run(fake);
    fake.clock.now = 3200;
    fake.runFrame(); // quiet for 3 s: the watch ends
    assert.equal(fake.queue.length, 0);
    fake.document.readyStateValue = 'complete';
    fake.fireOnly('document:animationend'); // calm: the look is asked for on the timer alone
    fake.runTimers();
    assert.equal(fake.posted.length, 2, 'the readiness is posted');
    assert.equal(fake.posted[1].message.ready, true);
    assert.equal(fake.queue.length, 0, 'but no new size, so the watch is not extended');
  });

  it('looks at every frame for 3 s after a change, then stops', () => {
    const fake = fakeWindow();
    run(fake);
    assert.equal(fake.queue.length, 1, 'watching from the first report');
    fake.clock.now = 1500;
    fake.root.box = 900; // a post-load animation moved something, no event fired
    fake.runFrame();
    assert.equal(fake.posted.length, 2);
    assert.equal(fake.posted[1].message.h, 900);
    fake.clock.now = 4400; // 2.9 s after that change
    fake.runFrame();
    assert.equal(fake.queue.length, 1, 'still watching');
    fake.clock.now = 4501; // 3 s still, nothing changed
    fake.runFrame();
    assert.equal(fake.queue.length, 0, 'quiet: no more frames');
    assert.equal(fake.posted.length, 2);
  });

  it('lets an animation event re-arm the watch only when it finds a new size', () => {
    const fake = fakeWindow();
    run(fake);
    fake.clock.now = 4000;
    fake.runFrame(); // the first look ends the watch: nothing changed for 3 s
    fake.runFrame();
    assert.equal(fake.queue.length, 0);
    fake.runTimers(); // the startup generation's timer is spent
    for (let step = 0; step < 5; step++) {
      fake.clock.now += 1000;
      fake.fireOnly('document:animationend');
      // Once the last look found nothing, an event asks for the timer only, not a frame.
      assert.equal(fake.queue.length, 0, 'no frame look while calm');
      assert.equal(fake.timers.length, 1, 'one timer look is asked for');
      fake.runTimers();
      assert.equal(fake.timers.length, 0, 'it found nothing, so the watch is not re-armed');
    }
    fake.fireOnly('document:animationend');
    fake.root.box += 300;
    fake.runTimers();
    assert.equal(fake.queue.length, 1, 'a new size keeps the watch going');
    fake.clock.now += 1000;
    fake.fireOnly('window:load'); // a load always re-arms
    fake.runFrame();
    fake.clock.now += 2500;
    fake.runFrame();
    assert.equal(fake.queue.length, 1, '3 s after the load the watch is still on');
  });

  it('stops for good after 2,000 reports, the last carrying the state of that moment', () => {
    const fake = fakeWindow();
    run(fake);
    for (let step = 1; step <= 2_500; step++) {
      fake.root.box = 400 + step;
      fake.clock.now += 100; // under the 20 a second limit
      fake.fire('window:resize');
    }
    assert.equal(fake.posted.length, 2_000);
    assert.equal(fake.posted[0].message.h, 500, 'the first report was delivered');
    assert.equal(
      fake.posted.at(-1)?.message.h,
      400 + 1_999,
      'the last carries the state at the cap',
    );
    assert.equal(fake.queue.length, 0, 'no frame is asked for any more');
    // Post-cap events do not even schedule a look: `live` gates `watch`.
    const frames = fake.queue.length;
    const timers = fake.timers.length;
    fake.fire('window:load');
    fake.observers.forEach(callback => callback());
    assert.equal(fake.queue.length, frames, 'no frame after the cap');
    assert.equal(fake.timers.length, timers, 'no timer after the cap');
    assert.equal(fake.posted.length, 2_000);
  });

  it('lets the resize observer ask for a look, but never extend the watch on its own', () => {
    const fake = fakeWindow();
    run(fake);
    fake.clock.now = 4_000;
    fake.runFrame(); // the watch ends after 3 quiet seconds
    fake.runFrame();
    assert.equal(fake.queue.length, 0);
    fake.runTimers(); // the startup generation's timer is spent
    // A sub-pixel wiggle fires the observer for ever at zero post cost. While the last look found
    // nothing the events are served by the timer alone, so a storm costs about 4 looks a second,
    // never a forced layout per frame for as long as the letter is read.
    for (let step = 0; step < 10; step++) {
      fake.clock.now += 250;
      fake.observers.forEach(callback => callback());
      assert.equal(fake.queue.length, 0, 'no frame look while calm');
      assert.equal(fake.timers.length, 1, 'one timer look per observer event');
      fake.runTimers();
      assert.equal(fake.timers.length, 0, 'nothing new: the watch stays off');
    }
    assert.equal(fake.posted.length, 1, 'all those looks never posted');
    // A real size change through the observer re-arms the watch through the posted shape.
    fake.root.box += 300;
    fake.observers.forEach(callback => callback());
    fake.runTimers();
    assert.equal(fake.posted.length, 2);
    assert.equal(fake.queue.length, 1, 'the watch is on again after a real change');
  });

  it('bounds the looks themselves: a storm of them dies at the LOOKS cap', () => {
    const fake = fakeWindow();
    const source = REPORTER_SOURCE.replace('const LOOKS = 100000;', 'const LOOKS = 40;');
    run(fake, source);
    fake.clock.now = 4_000;
    fake.runFrame();
    // 40 looks of a wiggle that never posts (seen counts the startup look and each step's), then
    // the reporter stops for good: live gates watch, so later events schedule nothing at all.
    for (let step = 0; step < 100; step++) {
      fake.clock.now += 250;
      fake.observers.forEach(callback => callback());
      fake.runFrame();
      fake.runTimers();
    }
    const frames = fake.queue.length;
    const timers = fake.timers.length;
    fake.observers.forEach(callback => callback());
    fake.fire('window:load');
    assert.equal(fake.queue.length, frames, 'no frame after the looks cap');
    assert.equal(fake.timers.length, timers, 'no timer after the looks cap');
    assert.equal(fake.posted.length, 1, 'the storm never posted');
  });

  it('a change of frame width does not count toward the lifetime cap', () => {
    const fake = fakeWindow();
    const source = REPORTER_SOURCE.replace('const LIFETIME = 2000;', 'const LIFETIME = 5;');
    run(fake, source);
    // Five posts at one width would hit the cap, but every new host-set width restarts the
    // budget. The startup report is the first at width 640, so that width gets three more.
    for (let round = 0; round < 5; round++) {
      for (let step = 0; step < (round === 0 ? 3 : 4); step++) {
        fake.root.box += 1;
        fake.clock.now += 100;
        fake.fire('window:resize');
      }
      fake.window.innerWidth += 10; // the host moves the frame; the letter cannot game it
    }
    assert.equal(fake.posted.length, 20, 'five widths in, and still alive');
    // And the cap still bites for the height alone: this last width gets five posts, not six.
    for (let step = 0; step < 6; step++) {
      fake.root.box += 1;
      fake.clock.now += 100;
      fake.fire('window:resize');
    }
    assert.equal(fake.posted.length, 25, 'the fifth post at one width is the last');
  });

  it('without a clock the rate limiter steps aside and every look can post', () => {
    const fake = fakeWindow();
    delete (fake.window as { performance?: unknown }).performance;
    run(fake);
    assert.equal(fake.posted.length, 1);
    for (let step = 0; step < 30; step++) {
      fake.root.box += 1;
      fake.fireOnly('window:resize');
      fake.runFrame();
      fake.runTimers();
    }
    // -Infinity never satisfies the per-second window, so `sent` always resets: 30 changes post.
    assert.equal(fake.posted.length, 31);
    assert.equal(fake.queue.length, 0, 'and a look still never re-arms');
  });

  it('keeps no frame running in a page without frames, timers or a clock', () => {
    const fake = fakeWindow({ frames: false });
    run(fake);
    assert.equal(fake.posted.length, 1);
    assert.equal(fake.queue.length, 0);
    assert.equal(fake.timers.length, 0);
    fake.fire('window:load');
    assert.equal(fake.posted.length, 1);
  });

  it('measures the content, never the root scroll height (which is at least the frame)', () => {
    // A frame sized 900 for a letter that is now 120 tall: the old reading said 900 for ever.
    const fake = fakeWindow({ box: 120, rootScroll: 900, bodyScroll: 90 });
    run(fake);
    assert.equal(fake.posted[0].message.h, 120);
  });

  it('adds the body top and the scroll offset to the body scroll height', () => {
    // A body that starts 40 px down, in a frame scrolled 25 px: its content ends at 40 + 25 + 400.
    const fake = fakeWindow({ box: 120, bodyScroll: 400, bodyTop: 40, scrollY: 25 });
    run(fake);
    assert.equal(fake.posted[0].message.h, 465);
    const above = fakeWindow({ box: 120, bodyScroll: 400, bodyTop: -300 });
    run(above);
    assert.equal(above.posted[0].message.h, 120, 'a body above the viewport never lowers the root');
  });

  it('rounds the body term up and ignores a scroll offset that is not a number', () => {
    const fake = fakeWindow({ box: 10, bodyScroll: 100.2, bodyTop: 0.4 });
    run(fake);
    assert.equal(fake.posted[0].message.h, 101);
    const odd = fakeWindow({ box: 10, bodyScroll: 100 });
    Object.assign(odd.window, { scrollY: 'x' });
    run(odd);
    assert.equal(odd.posted[0].message.h, 100);
  });

  it('counts content that spills past the root box', () => {
    const fake = fakeWindow({ box: 120, bodyScroll: 400 });
    run(fake);
    assert.equal(fake.posted[0].message.h, 400);
  });

  it('rounds a fractional height up, so the last line is never cut', () => {
    const fake = fakeWindow({ box: 120.2, bodyScroll: 10 });
    run(fake);
    assert.equal(fake.posted[0].message.h, 121);
  });

  it('posts nothing while innerWidth is 0', () => {
    const fake = fakeWindow({ innerWidth: 0 });
    run(fake);
    fake.fire('window:load');
    assert.equal(fake.posted.length, 0);
    fake.window.innerWidth = 320;
    fake.fire('window:resize');
    assert.equal(fake.posted.length, 1);
  });

  it('clamps height, width, marks and background', () => {
    const fake = fakeWindow({ box: 1e12, marks: 1e9, bodyPaint: 'x'.repeat(500) });
    fake.window.innerWidth = 1e9;
    run(fake);
    const message = fake.posted[0].message;
    assert.equal(message.h, 1_000_000);
    assert.equal(message.w, 100_000);
    assert.equal(message.marks, 100_000);
    assert.equal((message.bg as string).length, 64);
  });

  it('turns a non-finite height into 0', () => {
    for (const box of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const fake = fakeWindow({ box, bodyScroll: Number.NaN });
      run(fake);
      assert.equal(fake.posted[0].message.h, 0);
    }
  });

  it('takes the token from the frame path, and stays quiet on any other path', () => {
    for (const pathname of ['/', `/${TOKEN.toUpperCase()}/`, `/x${TOKEN}/`, '/cid/0']) {
      const fake = fakeWindow({ pathname });
      run(fake);
      fake.fire('window:load');
      assert.equal(fake.posted.length, 0, pathname);
    }
  });

  it('posts nothing and does not throw when ResizeObserver throws', () => {
    const fake = fakeWindow({ resizeObserver: 'throws' });
    assert.doesNotThrow(() => run(fake));
    fake.fire('window:load');
    fake.fire('window:resize');
    assert.equal(fake.posted.length, 0);
  });

  it('still reports where ResizeObserver does not exist', () => {
    const fake = fakeWindow({ resizeObserver: 'missing' });
    run(fake);
    assert.equal(fake.posted.length, 1);
  });

  it('posts nothing more, and does not throw, when reading the page throws', () => {
    const fake = fakeWindow();
    run(fake);
    fake.window.getComputedStyle = () => {
      throw new Error('boom');
    };
    assert.doesNotThrow(() => fake.fire('window:resize'));
    assert.equal(fake.posted.length, 1, 'only the first report');
  });

  it('reads no global by bare name (only `window` exists in its context)', () => {
    const fake = fakeWindow();
    assert.doesNotThrow(() => run(fake));
    assert.equal(fake.posted.length, 1);
  });

  it('reads no JS built-in by bare name either (a vm context has those, so check the text)', () => {
    const builtIns =
      /(?<![.\w])(Math|isFinite|isNaN|String|Number|JSON|Object|Array|Promise|parseInt|parseFloat|globalThis|self|frames)\b/;
    assert.equal(builtIns.exec(REPORTER_SOURCE)?.[0], undefined);
  });
});

describe('reporter: the paper colour', () => {
  const report = (options: FakeOptions) => {
    const fake = fakeWindow(options);
    run(fake);
    return fake.posted[0].message.bg;
  };

  it('falls back to the root when the body has none', () => {
    const root = 'rgb(240, 240, 232)';
    const clear = [
      'rgba(0, 0, 0, 0)',
      'transparent',
      '',
      'rgba(12, 34, 56, 0)',
      'oklch(0.5 0.2 30 / 0)',
      'color(srgb 1 0 0 / 0)',
      'color(srgb 1 0 0 / 0%)',
      'color(srgb 1 0 0 / 0.0)',
      'lab(50 20 30 /0)',
    ];
    for (const bodyPaint of clear) {
      assert.equal(report({ bodyPaint, rootPaint: root }), root, bodyPaint);
    }
  });

  it('prefers the body over a root colour, and keeps a half-clear body', () => {
    const rootPaint = 'rgb(9, 9, 9)';
    assert.equal(report({ bodyPaint: 'rgb(1, 2, 3)', rootPaint }), 'rgb(1, 2, 3)');
    assert.equal(report({ bodyPaint: 'rgba(1, 2, 3, 0.5)', rootPaint }), 'rgba(1, 2, 3, 0.5)');
    assert.equal(report({ bodyPaint: 'rgb(1, 2, 30)', rootPaint }), 'rgb(1, 2, 30)');
    // Opaque colours that happen to end in a 0 channel are colours, not see-through.
    for (const bodyPaint of [
      'rgb(255, 255, 0)',
      'rgb(0, 0, 0)',
      'oklch(0.5 0.2 30 / 0.5)',
      'color(srgb 1 0 0 / 10%)',
      'color(srgb 1 0 0 / 0.05)',
      'color(srgb 1 0 0)',
    ]) {
      assert.equal(report({ bodyPaint, rootPaint }), bodyPaint, bodyPaint);
    }
  });

  it('reports the body when neither has a colour', () => {
    assert.equal(report({ bodyPaint: 'rgba(0, 0, 0, 0)' }), 'rgba(0, 0, 0, 0)');
  });
});

describe('reporter: DOM clobbering (a named element shadows a member of document or window)', () => {
  // A decoy on every member the script could read by name, as `<img name=body>` and the like would
  // put on `document`, and as `<a id=addEventListener>` puts on `window`. The script must have
  // taken the real ones from the prototypes before the mail could matter.
  function clobbered(options: FakeOptions) {
    const fake = fakeWindow(options);
    const decoy = new FakeElement(7777, 7777, 'rgb(6, 6, 6)');
    const boom = () => {
      throw new Error('clobbered');
    };
    const shadow = (target: object, names: string[], value: unknown) => {
      for (const name of names) Object.defineProperty(target, name, { value });
    };
    shadow(fake.document, ['body', 'documentElement', 'readyState', 'fonts', 'children'], decoy);
    shadow(fake.document, ['addEventListener', 'querySelectorAll', 'getElementById'], boom);
    shadow(fake.window, ['addEventListener'], boom);
    return fake;
  }

  it('reports the same values and listens through the prototype', () => {
    const plain = fakeWindow({ box: 321, marks: 2 });
    run(plain);
    const shadowed = clobbered({ box: 321, marks: 2 });
    run(shadowed);
    assert.deepEqual({ ...shadowed.posted[0].message }, { ...plain.posted[0].message });
    assert.equal(shadowed.posted[0].message.h, 321);
    assert.equal(shadowed.posted[0].message.marks, 2);
    for (const name of ['document:toggle', 'document:DOMContentLoaded', 'window:load']) {
      assert.equal(shadowed.listeners[name]?.length, 1, name);
    }
  });
});
