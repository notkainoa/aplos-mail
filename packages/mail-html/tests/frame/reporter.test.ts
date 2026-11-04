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
    assert.ok(REPORTER_SOURCE.length < 4_096, `${REPORTER_SOURCE.length} bytes`);
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
  /** The root element's box height (the content), and the frame-sized scroll height the old code read. */
  box?: number;
  rootScroll?: number;
  bodyScroll?: number;
  resizeObserver?: 'ok' | 'throws' | 'missing';
  marks?: number;
  bodyPaint?: string;
  rootPaint?: string;
}

class FakeTarget {
  kind = 'window';
  constructor(readonly listeners: Record<string, (() => void)[]>) {}
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[`${this.kind}:${type}`] ??= []).push(fn);
  }
}

class FakeElement {
  constructor(
    readonly scroll: number,
    readonly box: number,
    readonly paint: string,
  ) {}
  get scrollHeight(): number {
    return this.scroll;
  }
  getBoundingClientRect(): { height: number } {
    return { height: this.box };
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
  querySelectorAll(selector: string): { length: number } {
    assert.equal(selector, 'mark.aplos-find');
    return { length: this.markCount };
  }
}

/** A window with just enough DOM for the script: members live on prototypes, as in a browser. */
function fakeWindow(options: FakeOptions = {}) {
  const posted: Posted[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const observers: (() => void)[] = [];
  const root = new FakeElement(
    options.rootScroll ?? 900,
    options.box ?? 500,
    options.rootPaint ?? 'rgba(0, 0, 0, 0)',
  );
  const body = new FakeElement(
    options.bodyScroll ?? 300,
    0,
    options.bodyPaint ?? 'rgb(255, 255, 255)',
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
      return { observe: () => undefined };
    };
  }
  const fire = (name: string) => listeners[name]?.forEach(fn => fn());
  return { window, document, root, body, posted, listeners, observers, fire };
}

function run(fake: ReturnType<typeof fakeWindow>): void {
  runInNewContext(REPORTER_SOURCE, { window: fake.window });
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

  it('reports again on every listed event', () => {
    const fake = fakeWindow();
    run(fake);
    fake.document.readyStateValue = 'complete';
    for (const name of [
      'document:DOMContentLoaded',
      'document:toggle',
      'window:load',
      'window:resize',
    ])
      fake.fire(name);
    fake.observers.forEach(callback => callback());
    fake.document.fontsDone?.();
    assert.equal(fake.posted.length, 7);
    assert.equal(fake.posted.at(-1)?.message.ready, true);
  });

  it('measures the content, never the root scroll height (which is at least the frame)', () => {
    // A frame sized 900 for a letter that is now 120 tall: the old reading said 900 for ever.
    const fake = fakeWindow({ box: 120, rootScroll: 900, bodyScroll: 90 });
    run(fake);
    assert.equal(fake.posted[0].message.h, 120);
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
    for (const bodyPaint of ['rgba(0, 0, 0, 0)', 'transparent', '', 'rgba(12, 34, 56, 0)']) {
      assert.equal(report({ bodyPaint, rootPaint: root }), root, bodyPaint);
    }
  });

  it('prefers the body over a root colour, and keeps a half-clear body', () => {
    const rootPaint = 'rgb(9, 9, 9)';
    assert.equal(report({ bodyPaint: 'rgb(1, 2, 3)', rootPaint }), 'rgb(1, 2, 3)');
    assert.equal(report({ bodyPaint: 'rgba(1, 2, 3, 0.5)', rootPaint }), 'rgba(1, 2, 3, 0.5)');
    assert.equal(report({ bodyPaint: 'rgb(1, 2, 30)', rootPaint }), 'rgb(1, 2, 30)');
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
