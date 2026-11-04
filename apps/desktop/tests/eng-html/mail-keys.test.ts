import test from 'node:test';
import assert from 'node:assert/strict';
import {
  focusedSubframeUrl,
  installMailKeys,
  relayedKey,
  type FocusedFrame,
  type KeyContents,
  type KeyInput,
} from '../../src/main/mail-keys';

// main/mail-keys.ts: which key main hands from a focused sealed mail frame to the app (J, K, Escape only), and the
// install on a window's webContents. The same relay runs in a real Chromium in relay.e2e.ts.

const DOC = `aplos-mail://m/${'ab'.repeat(16)}/`;
const APP = 'file:///app/dist/renderer/index.html';

function press(key: string, extra: Partial<KeyInput> = {}): KeyInput {
  return {
    type: 'keyDown',
    key,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    isAutoRepeat: false,
    isComposing: false,
    ...extra,
  };
}

test('relays exactly J, K (either case) and Escape, keydown, from a mail document', () => {
  const relayed: [KeyInput, { key: string; shift: boolean; alt: false }][] = [
    [press('j'), { key: 'j', shift: false, alt: false }],
    [press('k'), { key: 'k', shift: false, alt: false }],
    [press('J', { shift: true }), { key: 'J', shift: true, alt: false }],
    [press('K', { shift: true }), { key: 'K', shift: true, alt: false }],
    [press('J'), { key: 'J', shift: false, alt: false }],
    [press('Escape'), { key: 'Escape', shift: false, alt: false }],
    [press('Escape', { shift: true }), { key: 'Escape', shift: true, alt: false }],
  ];
  for (const [input, key] of relayed) assert.deepEqual(relayedKey(input, DOC), key, input.key);
});

test('never relays another key: R, E, Space, scrolling keys, letters, Enter, Tab', () => {
  const kept = [
    'r',
    'R',
    'e',
    'E',
    ' ',
    'Space',
    'ArrowDown',
    'ArrowUp',
    'ArrowLeft',
    'ArrowRight',
    'PageUp',
    'PageDown',
    'Home',
    'End',
    'Enter',
    'Tab',
    'Backspace',
    'a',
    'o',
    'x',
    'l',
    'jj',
    'Esc',
    'escape',
    'KeyJ',
    '',
  ];
  for (const key of kept) assert.equal(relayedKey(press(key), DOC), null, JSON.stringify(key));
});

test('never relays with Control, Command or Option held, repeated, composing, or not exactly false', () => {
  const refused: Partial<KeyInput>[] = [
    { control: true },
    { meta: true },
    { alt: true },
    { control: true, shift: true },
    { isAutoRepeat: true },
    { isComposing: true },
    { control: undefined as unknown as boolean },
    { meta: 1 as unknown as boolean },
    { isAutoRepeat: undefined as unknown as boolean },
  ];
  for (const extra of refused)
    for (const key of ['j', 'K', 'Escape'])
      assert.equal(relayedKey(press(key, extra), DOC), null, `${key} ${JSON.stringify(extra)}`);
});

test('never relays a keyUp or any other input type', () => {
  for (const type of ['keyUp', 'char', 'rawKeyDown', 'mouseDown', ''])
    for (const key of ['j', 'Escape'])
      assert.equal(relayedKey(press(key, { type }), DOC), null, `${type} ${key}`);
});

test('only from the exact issued mail document: not the app page, a sub-resource or a near miss', () => {
  const frames = [
    APP,
    undefined,
    null,
    '',
    `aplos-mail://m/${'ab'.repeat(16)}`,
    `${DOC}cid/0`,
    `${DOC}img/0`,
    `${DOC}?x`,
    `aplos-mail://m/${'AB'.repeat(16)}/`,
    `aplos-mail://x/${'ab'.repeat(16)}/`,
    `https://m/${'ab'.repeat(16)}/`,
    'about:blank',
    'about:srcdoc',
    42,
  ];
  for (const url of frames) assert.equal(relayedKey(press('j'), url), null, String(url));
});

test('the focused frame counts only as a subframe; a disposed frame gives nothing', () => {
  const top: FocusedFrame = { url: DOC, parent: null };
  const sub: FocusedFrame = { url: DOC, parent: { url: APP } };
  assert.equal(focusedSubframeUrl({ focusedFrame: sub }), DOC);
  assert.equal(
    focusedSubframeUrl({ focusedFrame: top }),
    undefined,
    'a mail document as top frame',
  );
  assert.equal(focusedSubframeUrl({ focusedFrame: null }), undefined);
  const disposed = {
    get focusedFrame(): FocusedFrame {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed');
    },
  };
  assert.equal(focusedSubframeUrl(disposed), undefined);
});

function fakeContents(frame: FocusedFrame | null) {
  const sent: unknown[][] = [];
  let listener: ((event: { preventDefault(): void }, input: KeyInput) => void) | undefined;
  const contents: KeyContents & { focusedFrame: FocusedFrame | null } = {
    focusedFrame: frame,
    on: (_name, fn) => {
      listener = fn;
    },
    send: (...args) => void sent.push(args),
  };
  const fire = (input: KeyInput) => {
    let prevented = 0;
    listener?.({ preventDefault: () => void prevented++ }, input);
    return prevented;
  };
  return { contents, sent, fire };
}

test('installed on a window: a relayed key is cancelled in the frame and sent once as aplos:event', () => {
  const fake = fakeContents({ url: DOC, parent: {} });
  installMailKeys(fake.contents);
  assert.equal(fake.fire(press('J', { shift: true })), 1);
  assert.deepEqual(fake.sent, [
    ['aplos:event', { type: 'mail-frame-key', payload: { key: 'J', shift: true, alt: false } }],
  ]);
  assert.equal(fake.fire(press('j', { type: 'keyUp' })), 0, 'the keyUp is not cancelled or sent');
  assert.equal(fake.fire(press('r')), 0);
  assert.equal(fake.fire(press('ArrowDown')), 0, 'scrolling keys stay in the frame');
  assert.equal(fake.sent.length, 1);
});

test('installed on a window: with the app page focused nothing is cancelled or sent', () => {
  const fake = fakeContents({ url: APP, parent: null });
  installMailKeys(fake.contents);
  for (const key of ['j', 'k', 'Escape']) assert.equal(fake.fire(press(key)), 0);
  fake.contents.focusedFrame = null;
  assert.equal(fake.fire(press('j')), 0);
  assert.deepEqual(fake.sent, []);
});
