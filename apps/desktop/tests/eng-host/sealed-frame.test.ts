import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { REPORTER_SOURCE } from '@aplos/mail-html/frame';
import {
  MAIL_KEYS,
  MAIL_KEY_CHANNEL,
  mailKeyEvent,
  mailKeyOfInput,
  parseMailKeyMessage,
  type RelayableInput,
} from '../../src/shared/mail-keys';
import { FALLBACK_KEYS } from '../../src/renderer/mailframe/keys';
import type { WebContents } from 'electron';
import { isMailDocumentUrl, isShownMailDocumentUrl } from '../../src/host/protocol/relay';
import { attachSealedFrameRelays } from '../../src/host/protocol/frame-relays';
import {
  relayMailKey,
  type RelayContents,
  type RelayFrame,
} from '../../src/host/protocol/frame-keys';
import {
  MAX_FRAME_LINK,
  classifyFrameLink,
  isMailFrameLink,
  routeFrameLink,
  type FrameLinkSinks,
} from '../../src/host/protocol/frame-links';

// html-5's main side for the sealed mail frame (lane eng-host): the key relay and its message, link routing. The
// hidden-Electron half (real Chromium frames, real preload, process isolation) is sealed-frame.e2e.ts.

const nodeRequire = createRequire(import.meta.url);
const src = fileURLToPath(new URL('../../src/', import.meta.url));
const read = (file: string) => readFileSync(join(src, file), 'utf8');
const TOKEN = 'ab'.repeat(16);
const DOC = `aplos-mail://m/${TOKEN}/`;

function input(key: string, over: Partial<RelayableInput> = {}): RelayableInput {
  return {
    type: 'keyDown',
    key,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    isComposing: false,
    isAutoRepeat: false,
    ...over,
  };
}

test('the key list is exactly the short list, and the renderer’s srcdoc relay reads the same one', () => {
  assert.deepEqual(
    [...MAIL_KEYS],
    ['j', 'k', 'J', 'K', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Escape'],
  );
  assert.deepEqual([...FALLBACK_KEYS], [...MAIL_KEYS], 'one source of truth, not a copy');
});

test('every listed key is relayed unmodified; Shift only makes J and K', () => {
  for (const key of MAIL_KEYS) assert.equal(mailKeyOfInput(input(key)), key, key);
  assert.equal(mailKeyOfInput(input('J', { shift: true })), 'J');
  assert.equal(mailKeyOfInput(input('K', { shift: true })), 'K');
});

test('modifier combinations are not relayed', () => {
  for (const key of MAIL_KEYS)
    for (const mod of ['control', 'alt', 'meta'] as const)
      assert.equal(mailKeyOfInput(input(key, { [mod]: true })), null, `${mod}+${key}`);
  for (const key of MAIL_KEYS.filter(k => k !== 'J' && k !== 'K'))
    assert.equal(mailKeyOfInput(input(key, { shift: true })), null, `shift+${key}`);
});

test('nothing destructive or outside the list is relayed, nor key-ups, repeats or composition', () => {
  for (const key of [
    'e',
    'E',
    'r',
    'R',
    ' ',
    'Enter',
    'Delete',
    'Backspace',
    'Tab',
    'a',
    'o',
    'ArrowLeft',
  ])
    assert.equal(mailKeyOfInput(input(key)), null, JSON.stringify(key));
  assert.equal(mailKeyOfInput(input('j', { type: 'keyUp' })), null);
  assert.equal(mailKeyOfInput(input('j', { type: 'char' })), null);
  assert.equal(mailKeyOfInput(input('ArrowDown', { isAutoRepeat: true })), null);
  assert.equal(mailKeyOfInput(input('j', { isComposing: true })), null);
});

function frame(url: string, parent: unknown): RelayFrame {
  return { url, parent };
}
function fakeContents(focused: (main: object) => RelayFrame | null) {
  const mainFrame = { url: 'file:///app/renderer/index.html' };
  const sent: unknown[][] = [];
  const state = { destroyed: false };
  const contents: RelayContents = {
    isDestroyed: () => state.destroyed,
    mainFrame,
    get focusedFrame() {
      return focused(mainFrame);
    },
    send: (channel, message) => void sent.push([channel, message]),
  };
  return { contents, sent, state, mainFrame };
}

test('a listed key from the sealed frame goes to the embedding window once, as one narrow message', () => {
  const { contents, sent } = fakeContents(main => frame(DOC, main));
  assert.equal(relayMailKey(contents, input('j')), true);
  assert.deepEqual(sent, [[MAIL_KEY_CHANNEL, { key: 'j' }]]);
  assert.equal(MAIL_KEY_CHANNEL, 'aplos:mail-key');
});

test('a key from the app page itself, or from any other frame, is not relayed as a mail key', () => {
  const page = fakeContents(main => main as RelayFrame);
  assert.equal(relayMailKey(page.contents, input('j')), false);
  const none = fakeContents(() => null);
  assert.equal(relayMailKey(none.contents, input('j')), false);
  // The development srcdoc frame has its own listener (renderer/mailframe/keys.ts): main must stay out of it.
  const srcdoc = fakeContents(main => frame('about:srcdoc', main));
  assert.equal(relayMailKey(srcdoc.contents, input('j')), false);
  const web = fakeContents(main => frame('https://example.invalid/', main));
  assert.equal(relayMailKey(web.contents, input('j')), false);
  const subResource = fakeContents(main => frame(`${DOC}cid/0`, main));
  assert.equal(relayMailKey(subResource.contents, input('j')), false);
  const grandchild = fakeContents(main => frame(DOC, frame('about:blank', main)));
  assert.equal(relayMailKey(grandchild.contents, input('j')), false);
  const orphan = fakeContents(() => frame(DOC, undefined));
  assert.equal(relayMailKey(orphan.contents, input('j')), false);
  for (const probe of [page, none, srcdoc, web, subResource, grandchild, orphan])
    assert.deepEqual(probe.sent, []);
});

test('the relay applies the key filter, and a destroyed or throwing window sends nothing', () => {
  const { contents, sent, state } = fakeContents(main => frame(DOC, main));
  for (const key of ['e', 'r', ' ', 'Enter', 'Delete'])
    assert.equal(relayMailKey(contents, input(key)), false, key);
  assert.equal(relayMailKey(contents, input('j', { control: true })), false);
  state.destroyed = true;
  assert.equal(relayMailKey(contents, input('j')), false);
  assert.deepEqual(sent, []);
  const throwing = fakeContents(() => {
    throw new Error('frame disposed');
  });
  assert.equal(relayMailKey(throwing.contents, input('j')), false);
});

test('the message is validated: only { key: <listed> } passes', () => {
  assert.deepEqual(parseMailKeyMessage({ key: 'Escape' }), { key: 'Escape' });
  const getter = {};
  Object.defineProperty(getter, 'key', { get: () => 'j', enumerable: true });
  const inherited = Object.create({ key: 'j' });
  const symbol = { key: 'j', [Symbol('x')]: 1 };
  const forged: unknown[] = [
    { key: 'e' },
    { key: 'Enter' },
    { key: ' ' },
    { key: 'Delete' },
    { key: 'j', extra: 1 },
    { key: 'j', shift: true },
    { key: 'J ' },
    { key: ['j'] },
    { key: { toString: () => 'j' } },
    { key: 1 },
    {},
    { Key: 'j' },
    ['j'],
    'j',
    null,
    undefined,
    42,
    getter,
    inherited,
    symbol,
    new Map([['key', 'j']]),
  ];
  for (const message of forged) {
    assert.equal(parseMailKeyMessage(message), null, String(JSON.stringify(message)));
    assert.equal(mailKeyEvent(message), null);
  }
  assert.deepEqual(mailKeyEvent({ key: 'k' }), { type: 'mail-key', payload: { key: 'k' } });
});

type Handler = (event: unknown, message: unknown) => void;

async function loadPreload() {
  const result = await build({
    entryPoints: [join(src, 'main/preload.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    write: false,
    logLevel: 'silent',
  });
  const handlers = new Map<string, Handler>();
  const exposed = new Map<string, unknown>();
  const electron = {
    contextBridge: { exposeInMainWorld: (key: string, api: unknown) => void exposed.set(key, api) },
    ipcRenderer: {
      on: (channel: string, handler: Handler) => void handlers.set(channel, handler),
      invoke: async () => undefined,
    },
  };
  const module = { exports: {} };
  const requireFake = (id: string) => (id === 'electron' ? electron : nodeRequire(id));
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    requireFake,
    module,
    module.exports,
  );
  return { handlers, exposed };
}

test('preload validates again: a forged message on the channel is dropped, a good one is delivered once', async () => {
  const { handlers, exposed } = await loadPreload();
  const handler = handlers.get(MAIL_KEY_CHANNEL);
  assert.ok(handler, 'preload listens on the mail-key channel');
  const bridge = exposed.get('aplos') as {
    subscribe(listener: (event: unknown) => void): () => void;
  };
  const events: unknown[] = [];
  bridge.subscribe(event => events.push(event));
  for (const forged of [{ key: 'e' }, { key: 'Enter' }, { key: 'j', x: 1 }, 'j', null, [], {}])
    handler({}, forged);
  assert.deepEqual(events, [], 'nothing forged reaches the page');
  handler({}, { key: 'Escape' });
  assert.deepEqual(events, [{ type: 'mail-key', payload: { key: 'Escape' } }]);
});

test('preload does not queue a key nobody is listening for', async () => {
  const { handlers, exposed } = await loadPreload();
  const handler = handlers.get(MAIL_KEY_CHANNEL)!;
  handler({}, { key: 'j' });
  const events: unknown[] = [];
  (exposed.get('aplos') as { subscribe(l: (e: unknown) => void): () => void }).subscribe(e =>
    events.push(e),
  );
  assert.deepEqual(events, []);
});

function sinks() {
  const calls: string[][] = [];
  const out: FrameLinkSinks = {
    openMail: url => void calls.push(['mail', url]),
    openWeb: url => void calls.push(['web', url]),
  };
  return { out, calls };
}

test('mailto goes to Compose through handleLink’s path with the parsed URL; http and https to the browser', () => {
  const { out, calls } = sinks();
  assert.equal(routeFrameLink('mailto:ada@example.invalid?subject=Hi%20there', out), 'mail');
  assert.equal(routeFrameLink('MAILTO:ada@example.invalid', out), 'mail');
  assert.equal(routeFrameLink('https://example.invalid/a?b=c', out), 'web');
  assert.equal(routeFrameLink('http://example.invalid', out), 'web');
  assert.deepEqual(calls, [
    ['mail', 'mailto:ada@example.invalid?subject=Hi%20there'],
    ['mail', 'mailto:ada@example.invalid'],
    ['web', 'https://example.invalid/a?b=c'],
    ['web', 'http://example.invalid/'],
  ]);
});

test('javascript:, data:, file:, blob:, tel:, ftp:, aplos-mail:, aplos: and the unparsable are denied', () => {
  const { out, calls } = sinks();
  const denied = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>1</script>',
    'file:///etc/passwd',
    'blob:https://example.invalid/uuid',
    'tel:+15551234',
    'ftp://example.invalid/x',
    `${DOC}`,
    'aplos://compose?to=a@b.invalid',
    'about:blank',
    'sms:+1555',
    'https://user:pw@example.invalid/',
    'https://',
    '',
    '//example.invalid/x',
    'not a url',
    42,
    null,
    undefined,
    {},
  ];
  for (const url of denied) assert.equal(routeFrameLink(url, out), 'deny', String(url));
  assert.deepEqual(calls, []);
});

test('links are length capped and a mailto cannot inject headers', () => {
  const { out, calls } = sinks();
  // The cap is handleLink's and external's own 10,000 characters, pinned as a number so the constant cannot drift.
  assert.equal(MAX_FRAME_LINK, 10_000);
  assert.equal(routeFrameLink(`https://example.invalid/${'a'.repeat(10_000)}`, out), 'deny');
  assert.equal(routeFrameLink(`mailto:${'a'.repeat(10_000)}@b.invalid`, out), 'deny');
  assert.equal(routeFrameLink(`https://example.invalid/${'a'.repeat(9_900)}`, out), 'web');
  // Short as typed, long once parsed (each brace becomes %7B): the parsed form is what travels, so it is capped too.
  assert.equal(routeFrameLink(`https://example.invalid/${'{'.repeat(4_000)}`, out), 'deny');
  // CR/LF in the recipient or in a header-like parameter would become headers in a draft.
  for (const bad of [
    'mailto:a@b.invalid%0d%0aBcc:evil@c.invalid',
    'mailto:a@b.invalid?subject=Hi%0d%0aBcc:evil@c.invalid',
    'mailto:a@b.invalid?bcc=x@y.invalid%0a',
    'mailto:a@b.invalid?cc=%00',
    'mailto:%zz@b.invalid',
  ])
    assert.equal(classifyFrameLink(bad).kind, 'deny', bad);
  // A body may hold line breaks, and the parameters pass through unchanged (handleLink's own behaviour).
  const body = 'mailto:a@b.invalid?body=line%20one%0D%0Aline%20two&bcc=c@d.invalid';
  assert.deepEqual(classifyFrameLink(body), { kind: 'mail', url: body });
  assert.equal(calls.length, 1);
});

test('a refused subframe navigation counts as a letter’s link only when the mail frame itself started it', () => {
  const mail = { url: DOC };
  assert.equal(
    isMailFrameLink({
      url: 'mailto:a@b.invalid',
      isMainFrame: false,
      frame: mail,
      initiator: mail,
    }),
    true,
  );
  assert.equal(
    isMailFrameLink({
      url: 'https://x.invalid/',
      isMainFrame: false,
      frame: mail,
      initiator: null,
    }),
    true,
  );
  assert.equal(
    isMailFrameLink({ url: 'https://x.invalid/', isMainFrame: false, frame: mail }),
    true,
  );
  const app = { url: 'file:///app/renderer/index.html' };
  assert.equal(
    isMailFrameLink({ url: 'https://x.invalid/', isMainFrame: false, frame: mail, initiator: app }),
    false,
  );
  assert.equal(
    isMailFrameLink({ url: 'https://x.invalid/', isMainFrame: true, frame: mail, initiator: mail }),
    false,
  );
  assert.equal(
    isMailFrameLink({ url: 'https://x.invalid/', isMainFrame: false, frame: app, initiator: app }),
    false,
  );
  assert.equal(
    isMailFrameLink({
      url: 'https://x.invalid/',
      isMainFrame: false,
      frame: { url: 'about:srcdoc' },
    }),
    false,
  );
  assert.equal(
    isMailFrameLink({ url: 'https://x.invalid/', isMainFrame: false, frame: null }),
    false,
  );
  assert.equal(
    isMailFrameLink({
      url: 'https://x.invalid/',
      isMainFrame: false,
      frame: { url: `${DOC}cid/0` },
    }),
    false,
  );
});

type Fake = Record<string, (...args: unknown[]) => unknown>;

/** The WebContents surface `attachSealedFrameRelays` touches, recording what it registers. */
function fakeWebContents(focused: (main: object) => RelayFrame | null) {
  const base = fakeContents(focused);
  const handlers: Fake = {};
  let openHandler: ((details: { url: string }) => { action: string }) | undefined;
  const contents = {
    ...base.contents,
    get focusedFrame() {
      return focused(base.mainFrame);
    },
    on: (name: string, handler: (...args: unknown[]) => unknown) => void (handlers[name] = handler),
    setWindowOpenHandler: (handler: typeof openHandler) => void (openHandler = handler),
  };
  return { contents: contents as unknown as WebContents, handlers, open: () => openHandler!, base };
}

test('attachSealedFrameRelays: keys, mail-frame links and window.open, all through the one wiring', () => {
  const { out, calls } = sinks();
  const probe = fakeWebContents(main => frame(DOC, main));
  attachSealedFrameRelays(probe.contents, out);
  // A key from the sealed frame reaches the renderer; the app page's own key does not.
  probe.handlers['before-input-event']({}, input('k'));
  assert.deepEqual(probe.base.sent, [[MAIL_KEY_CHANNEL, { key: 'k' }]]);
  // window.open and target=_blank: always denied, routed by kind.
  for (const url of ['mailto:a@b.invalid', 'https://example.invalid/', 'javascript:alert(1)'])
    assert.deepEqual(probe.open()({ url }), { action: 'deny' });
  assert.deepEqual(calls, [
    ['mail', 'mailto:a@b.invalid'],
    ['web', 'https://example.invalid/'],
  ]);
  // The mail frame navigating itself: a mailto or web target is cancelled and routed, others are left to the lock.
  const mail = { url: DOC };
  const navigate = (url: string, extra: object = {}) => {
    const event = {
      url,
      isMainFrame: false,
      frame: mail,
      initiator: mail,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
      ...extra,
    };
    probe.handlers['will-frame-navigate'](event);
    return event.prevented;
  };
  calls.length = 0;
  assert.equal(navigate('mailto:c@d.invalid'), true);
  assert.equal(navigate('https://example.invalid/x'), true);
  assert.equal(navigate('javascript:alert(1)'), false, 'left to the navigation lock');
  assert.equal(navigate('data:text/html,x'), false);
  assert.equal(
    navigate(`aplos-mail://m/${'cd'.repeat(16)}/`),
    false,
    'a reload is not a letter’s link',
  );
  assert.equal(navigate('https://example.invalid/y', { initiator: { url: 'file:///app' } }), false);
  assert.deepEqual(calls, [
    ['mail', 'mailto:c@d.invalid'],
    ['web', 'https://example.invalid/x'],
  ]);
});

test('windows.ts wires the sealed-frame relays; double-delivery guard: one key path per frame kind', () => {
  const windows = read('main/windows.ts');
  assert.match(
    windows,
    /openMail: url => \{\s*if \(!handleOauthReturn\(url\)\) handleLink\(url\);\s*\}/,
    'mailto goes through handleLink after the oauth-return claim',
  );
  assert.match(windows, /attachSealedFrameRelays\(contents, frameLinks\);/);
  assert.doesNotMatch(windows, /openExternal/, 'no direct shell access from windows.ts');
  const relays = read('host/protocol/frame-relays.ts');
  assert.match(relays, /contents\.on\('before-input-event'/);
  assert.match(relays, /contents\.on\('will-frame-navigate'/);
  assert.match(relays, /contents\.setWindowOpenHandler\(/);
  // The reporter (sealed frame) has no key fallback, so main’s relay is the only sealed path.
  assert.doesNotMatch(REPORTER_SOURCE, /key(?:down|up|press)|['"]key['"]/i);
  // The srcdoc listener cannot overlap main’s relay: main ignores about:srcdoc (tested above) and the srcdoc listener
  // exists only in the renderer.
  assert.match(read('host/protocol/frame-keys.ts'), /isShownMailDocumentUrl\(frame\.url\)/);
});

test('a shown letter keeps its place after a fragment link: only the fragment is ignored, the grammar is not relaxed', () => {
  for (const url of [DOC, `${DOC}#m-x`, `${DOC}#`, `${DOC}#a#b`, `${DOC}#/x?y=z`])
    assert.equal(isShownMailDocumentUrl(url), true, url);
  const upper = `aplos-mail://m/${TOKEN.toUpperCase()}/`;
  for (const url of [
    `${DOC}x#y`,
    `${DOC}cid/0#y`,
    `${DOC}?q#f`,
    `${DOC}?q`,
    `aplos-mail://m/${TOKEN}#f`,
    `aplos-mail://m/#${TOKEN}/`,
    `aplos-mail://m/${TOKEN.slice(0, 10)}#${TOKEN.slice(10)}/`,
    `aplos-mail://m//#f`,
    `aplos-mail://m/${TOKEN}//#f`,
    `${upper}#f`,
    `aplos-mail://other/${TOKEN}/#f`,
    `about:srcdoc#f`,
    `#${DOC}`,
    '',
    null,
    undefined,
    42,
  ])
    assert.equal(isShownMailDocumentUrl(url), false, String(url));
  // Navigation checks stay strict: a fragment is not an issued document.
  assert.equal(isMailDocumentUrl(`${DOC}#m-x`), false);
});

test('after a fragment navigation the letter still gets its keys', () => {
  const { contents, sent } = fakeContents(main => frame(`${DOC}#m-section-2`, main));
  assert.equal(relayMailKey(contents, input('j')), true);
  assert.deepEqual(sent, [[MAIL_KEY_CHANNEL, { key: 'j' }]]);
  const lookalike = fakeContents(main => frame(`${DOC}x#m-section-2`, main));
  assert.equal(relayMailKey(lookalike.contents, input('j')), false);
});

test('after a fragment navigation a plain link click in the letter still routes', () => {
  const mail = { url: `${DOC}#m-section-2` };
  const mailto = { url: 'mailto:a@b.invalid', isMainFrame: false };
  assert.equal(isMailFrameLink({ ...mailto, frame: mail, initiator: mail }), true);
  assert.equal(isMailFrameLink({ ...mailto, frame: { url: `${DOC}x#y` }, initiator: null }), false);
  const { out, calls } = sinks();
  const probe = fakeWebContents(main => frame(`${DOC}#m-section-2`, main));
  attachSealedFrameRelays(probe.contents, out);
  const event = {
    url: 'https://example.invalid/after-toc',
    isMainFrame: false,
    frame: mail,
    initiator: mail,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  probe.handlers['will-frame-navigate'](event);
  assert.equal(event.prevented, true);
  assert.deepEqual(calls, [['web', 'https://example.invalid/after-toc']]);
});
