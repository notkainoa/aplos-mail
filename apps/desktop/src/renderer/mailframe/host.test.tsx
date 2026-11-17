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
/** An engine frame token: 32 lowercase hex digits. */
const TOKEN = '0123456789abcdef0123456789abcdef';

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

  test('200,000 dots after a URL take under 100 ms', () => {
    for (const tail of ['', 'x', 'x ', ').']) {
      const body = `See https://maple.example/${'.'.repeat(200_000)}${tail} ok`;
      const start = performance.now();
      textSegments(body);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 100, `tail ${JSON.stringify(tail)}: ${elapsed.toFixed(0)} ms`);
    }
  });

  test('a URL candidate over 2,000 characters stays text', () => {
    const long = `https://maple.example/${'a'.repeat(2_000)}`;
    assert.deepEqual(
      textSegments(`${long} end`).map(s => s.kind),
      ['text'],
    );
    const trimmed = textSegments(`https://maple.example/a${'.'.repeat(5_000)}`);
    assert.equal(trimmed[0]?.kind, 'link');
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
    const { event, calls } = keyEvent({ key: 'j' });
    assert.equal(
      relayKey(event, k => (seen.push(k), true)),
      true,
    );
    assert.deepEqual(seen, [{ key: 'j', shift: false, alt: false }]);
    assert.deepEqual(calls, { prevented: 1, stopped: 1 });
  });

  test('only the sealed frame short list is relayed: J/K, arrows, Page Up/Down, Home, End, Esc', () => {
    const relayed = (key: string, over: Partial<RelayableKeyEvent> = {}) => {
      const seen: MailFrameKey[] = [];
      relayKey(keyEvent({ key, ...over }).event, k => void seen.push(k));
      return seen.length;
    };
    for (const key of ['j', 'k', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])
      assert.equal(relayed(key), 1, key);
    assert.equal(relayed('Escape'), 1);
    assert.equal(relayed('J', { shiftKey: true }), 1);
    assert.equal(relayed('K', { shiftKey: true }), 1);
    for (const key of ['r', 'R', 'e', 'E', ' ', 'l', 'z', 's', 'a', '#', '/', 'Enter', 'Tab']) {
      assert.equal(relayed(key), 0, key);
      assert.equal(relayed(key, { shiftKey: true }), 0, `shift ${key}`);
    }
  });

  test('a tap of R in the frame cannot start or leave a hold: no keydown or keyup reaches the shell', () => {
    // The shell's hold (R, Space) starts only from a keydown on the window; the relay is the frame's only way there.
    const shell: MailFrameKey[] = [];
    for (const key of ['r', 'r', 'R']) {
      const down = keyEvent({ key, shiftKey: key === 'R' });
      assert.equal(
        relayKey(down.event, k => (shell.push(k), true)),
        false,
      );
      assert.deepEqual(down.calls, { prevented: 0, stopped: 0 });
    }
    const space = keyEvent({ key: ' ' });
    relayKey(space.event, k => void shell.push(k));
    assert.deepEqual(shell, []);
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
      relayKey(keyEvent({ key: 'j', ...over }).event, () => void called++);
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
  test('DNS prefetch is off and the inner CSP comes first in head, allowing no network when blocked', () => {
    const { srcdoc } = frameDocument('<p>x</p>', 'block', undefined);
    assert.equal(
      frameCsp('block'),
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
    );
    assert.ok(
      srcdoc.startsWith(
        '<!doctype html><html><head><meta charset="utf-8">' +
          '<meta http-equiv="x-dns-prefetch-control" content="off">' +
          `<meta http-equiv="Content-Security-Policy" content="${frameCsp('block')}">`,
      ),
    );
    assert.match(frameCsp('load'), /img-src data: https:;/);
  });

  test('sandboxes: srcdoc never allows scripts; allow-same-origin only on the srcdoc frame', () => {
    const tokens = (sandbox: string) => sandbox.split(/\s+/).filter(Boolean);
    for (const sandbox of [SRCDOC_SANDBOX, URL_SANDBOX]) {
      assert.doesNotMatch(sandbox, /allow-forms|allow-top-navigation|allow-modals/);
      const both = tokens(sandbox).filter(t => t === 'allow-scripts' || t === 'allow-same-origin');
      assert.ok(both.length < 2, `never both: ${sandbox}`);
    }
    assert.deepEqual(tokens(SRCDOC_SANDBOX), ['allow-same-origin']);
    assert.ok(!tokens(URL_SANDBOX).includes('allow-same-origin'));
    const url: FrameSource = {
      kind: 'url',
      key: 'u',
      url: `aplos-mail://m/${TOKEN}/`,
      token: TOKEN,
      blocked: 0,
    };
    const html = renderToStaticMarkup(<MailFrameView source={url} onReady={noop} onKey={noop} />);
    assert.doesNotMatch(html, /allow-same-origin/);
  });

  test('a sealed frame starts on the app’s colour scheme, so a plain letter can report its dark surface', () => {
    const url: FrameSource = {
      kind: 'url',
      key: 'u',
      url: `aplos-mail://m/${TOKEN}/`,
      token: TOKEN,
      blocked: 0,
    };
    const html = renderToStaticMarkup(<MailFrameView source={url} onReady={noop} onKey={noop} />);
    assert.match(html, /color-scheme:normal/);
    assert.doesNotMatch(html, /color-scheme:light/);
  });

  test('host styles sit in the aplos layer, declared first, with !important measuring rules', () => {
    const { srcdoc } = frameDocument('<style>p{color:red}</style><p>x</p>', 'block', undefined);
    const firstStyle = srcdoc.indexOf('<style>');
    assert.ok(srcdoc.startsWith('<style>@layer aplos;@layer aplos{', firstStyle));
    assert.ok(firstStyle < srcdoc.indexOf('</head>'));
    assert.match(srcdoc, /html,body\{[^}]*height:auto!important[^}]*\}/);
    assert.match(srcdoc, /overflow:hidden!important/);
  });

  test('find marks carry a per-instance attribute the email cannot predict', () => {
    const one = frameDocument('<p>lunch</p>', 'block', 'lunch').srcdoc;
    const two = frameDocument('<p>lunch</p>', 'block', 'lunch').srcdoc;
    const attribute = (doc: string) =>
      /<mark (data-find-[0-9a-f]{12})>lunch<\/mark>/.exec(doc)?.[1];
    assert.ok(attribute(one), one);
    assert.notEqual(attribute(one), attribute(two));
    assert.ok(one.includes(`mark[${attribute(one)}]{all:unset!important;`));
  });

  test('notices render outside the frame, where email CSS cannot reach them', () => {
    const giant = `<style>p{display:none}</style><table>${'<tr><td>x</td></tr>'.repeat(5_001)}</table>`;
    const built = frameDocument(giant, 'block', undefined);
    assert.ok(!built.srcdoc.includes('layout was too large'));
    const source: FrameSource = { kind: 'srcdoc', key: 'g', html: giant, imagePolicy: 'block' };
    const html = renderToStaticMarkup(
      <MailFrameView source={source} onReady={noop} onKey={noop} />,
    );
    const notice = html.indexOf('<p class="aplos-mailframe__notice">');
    assert.ok(notice !== -1 && notice < html.indexOf('<iframe'), html.slice(0, 300));
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
      true,
    );
    assert.equal(source?.kind, 'srcdoc');
    const { srcdoc } = frameDocument(
      source?.kind === 'srcdoc' ? source.html : '',
      'block',
      undefined,
    );
    const csp = srcdoc.match(/<meta http-equiv="Content-Security-Policy"/g) ?? [];
    assert.equal(csp.length, 1, 'only the host CSP meta');
    assert.match(srcdoc, /<p>Hi Sam<\/p>/);
  });

  test('outside a Vite dev build a srcdoc answer is refused (the same-origin frame is dev only)', async () => {
    const { isDevBuild, sourceOfFrame } = await import('./useFrameSource');
    assert.equal(isDevBuild(), false, 'node has no import.meta.env');
    const frame = { url: 'aplos-mail://m/mf-1-abc', srcdoc: '<p>x</p>', trackersRemoved: 0 };
    assert.equal(sourceOfFrame('m1|block|', frame, 'block', undefined), null);
    assert.equal(sourceOfFrame('m1|block|', frame, 'block', undefined, false), null);
  });

  test('a URL-only frame (the real engine) becomes a url source with its token', async () => {
    const { sourceOfFrame } = await import('./useFrameSource');
    const url = `aplos-mail://m/${TOKEN}/`;
    const source = sourceOfFrame('m1|block|', { url, trackersRemoved: 3 }, 'block', undefined);
    assert.deepEqual(source, {
      kind: 'url',
      key: `m1|block||${url}`,
      url,
      token: TOKEN,
      blocked: 3,
    });
  });

  test('a URL outside the engine grammar is refused at once (no token, so no report could match)', async () => {
    const { sourceOfFrame } = await import('./useFrameSource');
    for (const url of [
      'aplos-mail://m/AbCdEfGh12345678',
      `aplos-mail://m/${TOKEN.toUpperCase()}/`,
      `aplos-mail://m/${TOKEN}/cid/0`,
      `https://m/${TOKEN}/`,
    ]) {
      assert.equal(
        sourceOfFrame('m1|block|', { url, trackersRemoved: 0 }, 'block', undefined),
        null,
        url,
      );
    }
  });
});
