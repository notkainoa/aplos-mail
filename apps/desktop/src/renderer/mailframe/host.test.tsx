// Host pieces with no browser: find marks, plain-text links, the key relay, link handling, the frame document and
// the iframe's attributes as React renders them.
// Run: cd apps/desktop && npx tsx --test src/renderer/mailframe/host.test.tsx

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { frameCsp, frameDocument, SRCDOC_SANDBOX, URL_SANDBOX } from './document';
import { highlight } from './highlight';
import { relayKey, type RelayableKeyEvent } from './keys';
import { handleLinkClick } from './links';
import { MailFrameView } from './MailFrameView';
import { PlainText } from './PlainText';
import { textSegments } from './text';
import type { FrameSource, MailFrameKey } from './types';

const noop = () => {};

describe('highlight', () => {
  test('marks case-insensitive matches in text only, never in tags or styles', () => {
    const html = '<p title="Invoice">Your invoice</p><style>.invoice{}</style><p>INVOICE</p>';
    assert.equal(
      highlight(html, 'invoice'),
      '<p title="Invoice">Your <mark data-find>invoice</mark></p><style>.invoice{}</style><p><mark data-find>INVOICE</mark></p>',
    );
  });

  test('escapes the query and never splits an entity', () => {
    assert.equal(
      highlight('<p>a &lt;b&gt; c</p>', '<b>'),
      '<p>a <mark data-find>&lt;b&gt;</mark> c</p>',
    );
    assert.equal(highlight('<p>Tom &amp; Jerry</p>', 'amp'), '<p>Tom &amp; Jerry</p>');
    assert.equal(highlight('<p>x</p>', '"><script>'), '<p>x</p>');
  });

  test('an empty or whitespace query changes nothing', () => {
    assert.equal(highlight('<p>x</p>', '  '), '<p>x</p>');
    assert.equal(highlight('<p>x</p>', undefined), '<p>x</p>');
  });
});

describe('textSegments and PlainText', () => {
  test('detects http, https and mailto links, trims trailing punctuation', () => {
    const segments = textSegments('See https://maple.example/a?b=1. Or mailto:sam@maple.example!');
    assert.deepEqual(segments, [
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://maple.example/a?b=1', href: 'https://maple.example/a?b=1' },
      { kind: 'text', text: '. Or ' },
      { kind: 'link', text: 'mailto:sam@maple.example', href: 'mailto:sam@maple.example' },
      { kind: 'text', text: '!' },
    ]);
  });

  test('never links javascript:, data: or credentials', () => {
    const kinds = textSegments('javascript:alert(1) data:text/html,x https://u:p@x.example/').map(
      s => s.kind,
    );
    assert.deepEqual(kinds, ['text']);
  });

  test('renders escaped: markup in a plain-text body stays text', () => {
    const html = renderToStaticMarkup(<PlainText text={'<script>alert(1)</script> & <b>hi</b>'} />);
    assert.doesNotMatch(html, /<script|<b>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &lt;b&gt;hi&lt;\/b&gt;/);
  });

  test('marks find matches outside links', () => {
    const html = renderToStaticMarkup(<PlainText text="Lunch at noon, lunch?" findQuery="lunch" />);
    assert.equal((html.match(/<mark>/g) ?? []).length, 2);
  });
});

function keyEvent(over: Partial<RelayableKeyEvent> = {}) {
  const calls = { prevented: 0, stopped: 0 };
  const event: RelayableKeyEvent = {
    key: 'j',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    defaultPrevented: false,
    preventDefault: () => void calls.prevented++,
    stopPropagation: () => void calls.stopped++,
    ...over,
  };
  return { event, calls };
}

describe('relayKey', () => {
  test('relays an unmodified key once and cancels it in the frame when handled', () => {
    const seen: MailFrameKey[] = [];
    const { event, calls } = keyEvent({ key: ' ' });
    assert.equal(
      relayKey(event, k => (seen.push(k), true)),
      true,
    );
    assert.deepEqual(seen, [{ key: ' ', shift: false, alt: false }]);
    assert.deepEqual(calls, { prevented: 1, stopped: 1 });
  });

  test('an unhandled key keeps its default in the frame', () => {
    const { event, calls } = keyEvent({ key: 'ArrowDown' });
    assert.equal(
      relayKey(event, () => false),
      false,
    );
    assert.deepEqual(calls, { prevented: 0, stopped: 0 });
  });

  test('Ctrl, Cmd, IME composition and already-handled events stay in the frame', () => {
    for (const over of [
      { ctrlKey: true },
      { metaKey: true },
      { isComposing: true },
      { defaultPrevented: true },
    ]) {
      let called = 0;
      relayKey(keyEvent({ key: 'c', ...over }).event, () => void called++);
      assert.equal(called, 0, JSON.stringify(over));
    }
  });

  test('a modifier pressed alone is not relayed', () => {
    for (const key of ['Shift', 'Alt', 'Control', 'Meta', 'CapsLock', 'Dead']) {
      let called = 0;
      relayKey(keyEvent({ key, shiftKey: key === 'Shift' }).event, () => void called++);
      assert.equal(called, 0, key);
    }
  });

  test('Shift and Alt travel with the key', () => {
    const seen: MailFrameKey[] = [];
    relayKey(keyEvent({ key: 'J', shiftKey: true, altKey: true }).event, k => void seen.push(k));
    assert.deepEqual(seen, [{ key: 'J', shift: true, alt: true }]);
  });
});

describe('handleLinkClick', () => {
  const click = (href: string | null, button = 0) => {
    let prevented = 0;
    const anchor = { getAttribute: () => href };
    const target = { closest: (s: string) => (s === 'a' ? anchor : null) };
    const opened: string[] = [];
    const result = handleLinkClick(
      { target, button, preventDefault: () => void prevented++ },
      u => void opened.push(u),
    );
    return { prevented, opened, result };
  };

  test('a safe link is cancelled in the frame and opened outside', () => {
    assert.deepEqual(click('https://maple.example/x'), {
      prevented: 1,
      opened: ['https://maple.example/x'],
      result: 'https://maple.example/x',
    });
  });

  test('an unsafe or empty link is cancelled and never opened', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', '/relative', null]) {
      const { prevented, opened } = click(href);
      assert.equal(prevented, 1, String(href));
      assert.deepEqual(opened, []);
    }
  });

  test('a click outside any link is left alone', () => {
    let prevented = 0;
    handleLinkClick({ target: { closest: () => null }, preventDefault: () => void prevented++ });
    assert.equal(prevented, 0);
  });
});

describe('frame document', () => {
  test('the inner CSP is the first thing in head and allows no network when blocked', () => {
    const { srcdoc } = frameDocument('<p>x</p>', 'block', undefined);
    assert.equal(
      frameCsp('block'),
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
    );
    assert.ok(
      srcdoc.startsWith(
        `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp('block')}">`,
      ),
    );
    assert.match(frameCsp('load'), /img-src data: https:;/);
  });

  test('sandboxes: srcdoc has no scripts, the sealed frame is never same-origin', () => {
    assert.equal(SRCDOC_SANDBOX, 'allow-same-origin');
    assert.doesNotMatch(
      URL_SANDBOX,
      /allow-same-origin|allow-forms|allow-top-navigation|allow-modals/,
    );
  });

  test('the view mounts the pending srcdoc frame hidden, scriptless, with the CSP inside', () => {
    const source: FrameSource = {
      kind: 'srcdoc',
      key: 'm1',
      html: '<p>Hi</p><script>x()</script>',
      imagePolicy: 'block',
    };
    const html = renderToStaticMarkup(
      <MailFrameView source={source} onReady={noop} onKey={noop} />,
    );
    assert.match(html, /<iframe[^>]* sandbox="allow-same-origin"/);
    assert.doesNotMatch(html, /allow-scripts/);
    assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/);
    assert.match(html, /visibility:hidden/);
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /&lt;script/);
  });
});

describe('sourceOfFrame', () => {
  test("the stand-in's srcdoc becomes a srcdoc source the host re-sanitises", async () => {
    const { sourceOfFrame } = await import('./useFrameSource');
    const standIn =
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><body><p>Hi Sam</p></body>';
    const source = sourceOfFrame(
      'm1|block|',
      { url: 'aplos-mail://m/mf-1-abc', srcdoc: standIn, trackersRemoved: 0 },
      'block',
      undefined,
    );
    assert.equal(source.kind, 'srcdoc');
    const { srcdoc } = frameDocument(
      source.kind === 'srcdoc' ? source.html : '',
      'block',
      undefined,
    );
    assert.equal((srcdoc.match(/<meta http-equiv/g) ?? []).length, 1, 'only the host CSP meta');
    assert.match(srcdoc, /<p>Hi Sam<\/p>/);
  });

  test('a URL-only frame (the real engine) becomes a url source with its token', async () => {
    const { sourceOfFrame } = await import('./useFrameSource');
    const source = sourceOfFrame(
      'm1|block|',
      { url: 'aplos-mail://m/AbCdEfGh12345678', trackersRemoved: 3 },
      'block',
      undefined,
    );
    assert.deepEqual(source, {
      kind: 'url',
      key: 'm1|block||aplos-mail://m/AbCdEfGh12345678',
      url: 'aplos-mail://m/AbCdEfGh12345678',
      token: 'AbCdEfGh12345678',
      blocked: 3,
    });
  });
});
