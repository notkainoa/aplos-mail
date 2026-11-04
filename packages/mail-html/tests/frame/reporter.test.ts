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
// nothing, which the tests catch). The fake DOM keeps its state behind prototype accessors, as
// Chromium does, so a test can shadow them with own properties the way DOM clobbering would.
// The same script runs in a real Chromium in apps/desktop/tests/eng-html/reporter.e2e.ts.

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

  it('is small, ASCII, and cannot end its own script element', () => {
    // Small enough to review whole: 2,048 before the clobbering-proof captures, 3,072 now.
    assert.ok(REPORTER_SOURCE.length < 3_072, `${REPORTER_SOURCE.length} bytes`);
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
      'setTimeout',
      'setInterval',
      'textContent',
      'innerText',
      'Worker',
    ];
    for (const word of denied) assert.equal(REPORTER_SOURCE.includes(word), false, word);
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
  height?: number;
  resizeObserver?: 'ok' | 'throws' | 'missing';
  marks?: number;
  background?: string;
  rootBackground?: string;
}

interface FakeElement {
  name: string;
  height: number;
  background: string;
}

type Listener = () => void;

/**
 * A window with just enough DOM for the script, recording posts and listeners. As in a browser, the
 * document's state sits behind accessors and methods on `Document.prototype`, `Element.prototype`
 * and `EventTarget.prototype`; `document` and `window` themselves carry none of them.
 */
function fakeWindow(options: FakeOptions = {}) {
  const posted: Posted[] = [];
  const listeners: Record<string, Listener[]> = {};
  const observers: Listener[] = [];
  const observed: unknown[] = [];
  let fontsDone: Listener | undefined;
  const root: FakeElement = {
    name: 'html',
    height: options.height ?? 500,
    background: options.rootBackground ?? 'rgba(0, 0, 0, 0)',
  };
  const body: FakeElement = {
    name: 'body',
    height: 300,
    background: options.background ?? 'rgb(255, 255, 255)',
  };
  const page = { root, body, readyState: 'interactive', marks: options.marks ?? 0 };

  function EventTarget() {}
  EventTarget.prototype.addEventListener = function (this: object, type: string, fn: Listener) {
    const prefix = this === document ? 'document:' : this === window ? 'window:' : 'other:';
    (listeners[prefix + type] ??= []).push(fn);
  };
  function Element() {}
  Element.prototype.getBoundingClientRect = function (this: FakeElement) {
    return { height: this.height, width: 0 };
  };
  Object.setPrototypeOf(root, Element.prototype);
  Object.setPrototypeOf(body, Element.prototype);
  function Document() {}
  Object.setPrototypeOf(Document.prototype, EventTarget.prototype);
  const getters: Record<string, () => unknown> = {
    documentElement: () => page.root,
    body: () => page.body,
    readyState: () => page.readyState,
    fonts: () => ({ ready: { then: (ok: Listener) => (fontsDone = ok) } }),
  };
  for (const [name, get] of Object.entries(getters))
    Object.defineProperty(Document.prototype, name, { get, configurable: true });
  Document.prototype.querySelectorAll = function (selector: string) {
    assert.equal(selector, 'mark.aplos-find');
    return { length: page.marks };
  };
  const document: Record<string, unknown> = Object.create(Document.prototype);
  const window: Record<string, unknown> = {
    document,
    Math,
    Object,
    isFinite,
    Document,
    Element,
    EventTarget,
    innerWidth: options.innerWidth ?? 640,
    location: { pathname: options.pathname ?? `/${TOKEN}/` },
    parent: {
      postMessage: (message: Record<string, unknown>, target: string) => {
        posted.push({ message, target });
      },
    },
    getComputedStyle: (element: FakeElement) => ({ backgroundColor: element.background }),
  };
  if (options.resizeObserver !== 'missing') {
    window.ResizeObserver = function (callback: Listener) {
      if (options.resizeObserver === 'throws') throw new Error('no observer');
      observers.push(callback);
      return { observe: (target: unknown) => void observed.push(target) };
    };
  }
  const fire = (name: string) => listeners[name]?.forEach(fn => fn());
  return {
    window,
    document,
    page,
    root,
    body,
    prototypes: { Document, Element, EventTarget },
    posted,
    listeners,
    observers,
    observed,
    fire,
    fonts: () => fontsDone?.(),
  };
}

type Fake = ReturnType<typeof fakeWindow>;

function run(fake: Fake): void {
  runInNewContext(REPORTER_SOURCE, { window: fake.window });
}

function lastMessage(fake: Fake): Record<string, unknown> | undefined {
  return fake.posted.at(-1)?.message;
}

describe('reporter: behaviour in a fake DOM', () => {
  it('posts exactly the six keys at body end', () => {
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
      },
    );
    assert.equal(fake.posted[0].target, '*');
  });

  it('reports again on every listed event, and observes the root', () => {
    const fake = fakeWindow();
    run(fake);
    fake.page.readyState = 'complete';
    for (const name of [
      'document:DOMContentLoaded',
      'document:toggle',
      'window:load',
      'window:resize',
    ])
      fake.fire(name);
    fake.observers.forEach(callback => callback());
    fake.fonts();
    assert.equal(fake.posted.length, 7);
    assert.equal(lastMessage(fake)?.ready, true);
    assert.deepEqual(fake.observed, [fake.root]);
    assert.equal(fake.listeners['other:load'], undefined);
  });

  it('measures the root’s box, rounded up, so a letter can shrink (a closed <details>)', () => {
    const fake = fakeWindow({ height: 1200.2 });
    run(fake);
    assert.equal(lastMessage(fake)?.h, 1201);
    fake.root.height = 340;
    fake.fire('document:toggle');
    assert.equal(lastMessage(fake)?.h, 340, 'smaller than before');
    fake.body.height = 90_000;
    fake.fire('window:resize');
    assert.equal(lastMessage(fake)?.h, 340, 'the body’s own box is not what is measured');
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
    const fake = fakeWindow({ height: 1e12, marks: 1e9, background: 'x'.repeat(500) });
    fake.window.innerWidth = 1e9;
    run(fake);
    const message = fake.posted[0].message;
    assert.equal(message.h, 1_000_000);
    assert.equal(message.w, 100_000);
    assert.equal(message.marks, 100_000);
    assert.equal((message.bg as string).length, 64);
  });

  it('posts nothing while the root has no box (a height of 0, non-finite or negative), then reports', () => {
    for (const height of [0, 0.0, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const fake = fakeWindow({ height });
      run(fake);
      fake.fire('document:DOMContentLoaded');
      assert.equal(fake.posted.length, 0, String(height));
      fake.root.height = 0.4;
      fake.observers.forEach(callback => callback());
      assert.equal(lastMessage(fake)?.h, 1, 'the first layout reports, rounded up');
    }
  });

  it('posts nothing when the document has no root element', () => {
    const fake = fakeWindow();
    (fake.page as { root: unknown }).root = null;
    run(fake);
    fake.fire('window:load');
    assert.equal(fake.posted.length, 0);
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

  it('still reports where ResizeObserver or document.fonts does not exist', () => {
    const fake = fakeWindow({ resizeObserver: 'missing' });
    run(fake);
    assert.equal(fake.posted.length, 1);
    const noFonts = fakeWindow();
    delete (noFonts.prototypes.Document.prototype as Record<string, unknown>).fonts;
    run(noFonts);
    assert.equal(noFonts.posted.length, 1);
  });

  it('posts nothing when reading the page throws', () => {
    const fake = fakeWindow();
    run(fake);
    Object.defineProperty(fake.body, 'background', {
      get() {
        throw new Error('boom');
      },
    });
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

describe('reporter: the paper tint', () => {
  const cases: [string, string, string][] = [
    // [body, root, reported]
    ['rgb(255, 255, 255)', 'rgb(1, 2, 3)', 'rgb(255, 255, 255)'],
    ['rgba(0, 0, 0, 0)', 'rgb(18, 52, 86)', 'rgb(18, 52, 86)'],
    ['transparent', 'rgb(18, 52, 86)', 'rgb(18, 52, 86)'],
    ['rgba(255, 0, 0, 0)', 'rgb(18, 52, 86)', 'rgb(18, 52, 86)'],
    ['color(srgb 1 0 0 / 0)', 'rgb(18, 52, 86)', 'rgb(18, 52, 86)'],
    ['', 'rgb(18, 52, 86)', 'rgb(18, 52, 86)'],
    ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'],
    ['rgba(0, 0, 0, 0)', 'transparent', 'rgba(0, 0, 0, 0)'],
    ['rgb(1, 2, 0)', 'rgb(18, 52, 86)', 'rgb(1, 2, 0)'],
    ['rgba(0, 0, 0, 0.5)', 'rgb(18, 52, 86)', 'rgba(0, 0, 0, 0.5)'],
    ['oklch(0.5 0.1 0)', 'rgb(18, 52, 86)', 'oklch(0.5 0.1 0)'],
  ];
  for (const [background, rootBackground, reported] of cases) {
    it(`body ${background || '(none)'}, root ${rootBackground} -> ${reported}`, () => {
      const fake = fakeWindow({ background, rootBackground });
      run(fake);
      assert.equal(fake.posted[0].message.bg, reported);
    });
  }

  it('cuts the root’s colour to 64 characters too', () => {
    const fake = fakeWindow({
      background: 'transparent',
      rootBackground: `rgb(${'9'.repeat(200)})`,
    });
    run(fake);
    assert.equal((fake.posted[0].message.bg as string).length, 64);
  });

  it('falls back to the root when there is no body', () => {
    const fake = fakeWindow({ rootBackground: 'rgb(18, 52, 86)' });
    (fake.page as { body: unknown }).body = null;
    run(fake);
    assert.equal(fake.posted[0].message.bg, 'rgb(18, 52, 86)');
  });
});

describe('reporter: DOM clobbering', () => {
  /** What markup like `<img name=body>` or `<form name=addEventListener>` makes of document and window. */
  function clobber(fake: Fake): void {
    const decoy = { name: 'img', height: 7, background: 'rgb(9, 9, 9)' };
    const names = [
      'documentElement',
      'body',
      'readyState',
      'fonts',
      'querySelectorAll',
      'addEventListener',
      'getBoundingClientRect',
    ];
    for (const name of names) Object.defineProperty(fake.document, name, { value: decoy });
    fake.window.addEventListener = decoy;
  }

  it('reports the real values through the captured built-ins, not the shadowing names', () => {
    const fake = fakeWindow({ height: 640, marks: 2, background: 'rgb(250, 250, 250)' });
    clobber(fake);
    run(fake);
    assert.deepEqual(
      { ...lastMessage(fake) },
      { token: TOKEN, h: 640, w: 640, bg: 'rgb(250, 250, 250)', ready: false, marks: 2 },
    );
    fake.page.readyState = 'complete';
    fake.fire('window:load');
    fake.fire('document:toggle');
    assert.equal(fake.posted.length, 3, 'its listeners went to the real EventTarget method');
    assert.equal(lastMessage(fake)?.ready, true);
  });

  it('captures once: a built-in replaced after it started is not used', () => {
    const fake = fakeWindow({ height: 640 });
    run(fake);
    fake.prototypes.Element.prototype.getBoundingClientRect = () => ({ height: 3 });
    Object.defineProperty(fake.prototypes.Document.prototype, 'documentElement', {
      get: () => ({ height: 5 }),
    });
    fake.window.getComputedStyle = () => ({ backgroundColor: 'rgb(6, 6, 6)' });
    fake.fire('window:resize');
    assert.equal(lastMessage(fake)?.h, 640);
    assert.equal(lastMessage(fake)?.bg, 'rgb(255, 255, 255)');
  });

  // Each built-in the reporter needs, removed or replaced by a non-function: it posts nothing.
  const required: [string, (fake: Fake) => void][] = [
    ['Document.prototype.documentElement', f => drop(f.prototypes.Document, 'documentElement')],
    ['Document.prototype.body', f => drop(f.prototypes.Document, 'body')],
    ['Document.prototype.readyState', f => drop(f.prototypes.Document, 'readyState')],
    ['Document.prototype.querySelectorAll', f => drop(f.prototypes.Document, 'querySelectorAll')],
    [
      'Element.prototype.getBoundingClientRect',
      f => drop(f.prototypes.Element, 'getBoundingClientRect'),
    ],
    [
      'EventTarget.prototype.addEventListener',
      f => drop(f.prototypes.EventTarget, 'addEventListener'),
    ],
    ['a getter that is not a function', f => replaceGetter(f.prototypes.Document, 'body')],
    ['window.getComputedStyle', f => void (f.window.getComputedStyle = { name: 'img' })],
    ['window.Document', f => void delete f.window.Document],
    ['window.Element', f => void delete f.window.Element],
    ['window.EventTarget', f => void delete f.window.EventTarget],
    ['window.Object', f => void delete f.window.Object],
  ];
  for (const [name, remove] of required) {
    it(`fails closed without ${name}`, () => {
      const fake = fakeWindow();
      remove(fake);
      assert.doesNotThrow(() => run(fake));
      fake.fire('window:load');
      fake.fire('document:DOMContentLoaded');
      assert.equal(fake.posted.length, 0);
    });
  }
});

function drop(type: { prototype: object }, name: string): void {
  delete (type.prototype as Record<string, unknown>)[name];
}

function replaceGetter(type: { prototype: object }, name: string): void {
  Object.defineProperty(type.prototype, name, { value: 'not a getter', configurable: true });
}
