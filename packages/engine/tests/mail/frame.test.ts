import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { ContractError } from '@aplos/contract/contract-error';
import {
  frameHeaders,
  MAX_TOKENS_PER_WINDOW,
  notFound,
  REPORTER_SOURCE,
  reporterHash,
  reporterTag,
  UNFETCHED_TTL_MS,
} from '@aplos/mail-html/frame';
import { cacheKey } from '../../src/mail/render';
import { frameOf, IDS, mailWorld, PNG, serve, text, type World } from './harness';

// `Mail/frame` end to end: render, issue for the calling window, serve through `Mail/serve` as main's relay would.

const gone = (e: unknown) => e instanceof ContractError && e.type === 'notFound';

async function withWorld(fn: (w: World) => Promise<void>) {
  const world = await mailWorld();
  try {
    await fn(world);
  } finally {
    await world.cleanup();
  }
}

describe('Mail/frame', () => {
  it('returns a token URL that Mail/serve serves: document, then cid/<n>, with the hashed reporter', () =>
    withWorld(async w => {
      const frame = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.match(frame.url, /^aplos-mail:\/\/m\/[0-9a-f]{32}\/$/);
      assert.equal(frame.bodyKind, 'html');
      assert.equal(frame.hasRemoteImages, true);
      assert.equal(frame.quotedCount, 1);
      assert.equal(frame.srcdoc, undefined, 'the real engine never sets srcdoc');
      assert.equal(frame.expiresAt, w.clock.now() + UNFETCHED_TTL_MS);
      assert.deepEqual(await serve(w, frame.url, 'cid/0', w.ids.windowA), notFound());
      const doc = await serve(w, frame.url, '', w.ids.windowA);
      assert.equal(doc.status, 200);
      const hash = createHash('sha256').update(REPORTER_SOURCE, 'utf8').digest('base64');
      assert.equal(hash, await reporterHash());
      assert.deepEqual(doc.headers, frameHeaders(hash));
      assert.ok(doc.headers['content-security-policy'].includes(`'sha256-${hash}'`));
      const html = text(doc.body);
      assert.equal(html.split(reporterTag()).length, 2, 'exactly one reporter');
      assert.ok(html.endsWith(`${reporterTag()}</body></html>`), 'last in the body');
      assert.match(html, /src="cid\/0"/);
      assert.doesNotMatch(html, /img\.example/, 'a blocked remote image is not in the document');
      const inline = await serve(w, frame.url, 'cid/0', w.ids.windowA);
      assert.equal(inline.status, 200);
      assert.equal(inline.headers['content-type'], 'image/png');
      assert.deepEqual([...inline.body], [...PNG]);
      assert.deepEqual(w.calls.parts, ['acct-1 r1 part-1']);
      assert.equal((await serve(w, frame.url, 'img/0', w.ids.windowA)).status, 404, 'blocked');
      assert.equal((await serve(w, frame.url, '', w.ids.windowA)).status, 404, 'single render');
    }));

  it('serves allowed images through the proxy when the owner loads them', () =>
    withWorld(async w => {
      const frame = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'load' });
      const html = text((await serve(w, frame.url, '', w.ids.windowA)).body);
      assert.match(html, /src="img\/0"/);
      const image = await serve(w, frame.url, 'img/0', w.ids.windowA);
      assert.equal(image.status, 200);
      assert.equal(image.headers['content-type'], 'image/png');
      const token = frame.url.slice(15, -1);
      assert.deepEqual(w.calls.images, [`${token} https://img.example/a.png`]);
    }));

  it('keeps the reporter out of the cache and adds it on every issue', () =>
    withWorld(async w => {
      const a = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      const b = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.equal(w.renders.length, 1, 'the second frame is a cache hit');
      assert.notEqual(a.url, b.url, 'a fresh token every time');
      const request = { messageId: IDS.rich, policy: 'block' as const, quotesOpen: false };
      const key = cacheKey(request, w.refOf(IDS.rich), 'v1');
      const cached = w.engine.services.mailFrames.cache.get(key);
      assert.ok(cached && cached.result.bodyKind === 'html');
      assert.doesNotMatch(cached.result.document, /<script/);
      for (const url of [a.url, b.url]) {
        const html = text((await serve(w, url, '', w.ids.windowA)).body);
        assert.equal(html.split(reporterTag()).length, 2, url);
      }
    }));

  it('answers plain-text mail with bodyKind text and no token', () =>
    withWorld(async w => {
      const frame = await frameOf(w.windowA, { messageId: IDS.plain, imagePolicy: 'load' });
      assert.equal(frame.bodyKind, 'text');
      assert.equal(frame.url, '');
      assert.equal(frame.quotedCount, 1);
      assert.equal(w.engine.services.mailFrames.tokens.liveCount(w.ids.windowA), 0);
    }));

  it('fetches a body that is not stored, once, on the interactive lane', () =>
    withWorld(async w => {
      const frame = await frameOf(w.windowA, { messageId: IDS.remote, imagePolicy: 'block' });
      assert.equal(frame.bodyKind, 'html');
      assert.deepEqual(w.calls.opened, ['acct-1 t3 interactive']);
      await frameOf(w.windowA, { messageId: IDS.remote, imagePolicy: 'block', findQuery: 'old' });
      assert.equal(w.calls.opened.length, 1, 'stored now');
      await assert.rejects(
        frameOf(w.windowA, { messageId: 'acct-1:nope', imagePolicy: 'block' }),
        gone,
      );
    }));

  it('re-renders old mail after a sanitizer version bump, with no provider call', () =>
    withWorld(async w => {
      await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      w.html.version = 'v2';
      await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.equal(w.renders.length, 2);
      assert.deepEqual(w.calls.opened, []);
    }));

  it('opens quoted history when asked, keyed apart in the cache', () =>
    withWorld(async w => {
      const open = await frameOf(w.windowA, {
        messageId: IDS.rich,
        imagePolicy: 'block',
        quotesOpen: true,
      });
      const html = text((await serve(w, open.url, '', w.ids.windowA)).body);
      assert.match(html, /<details class="aplos-quote" open>/);
      await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.equal(w.renders.length, 2);
      assert.deepEqual(
        w.renders.map(r => r.quotesOpen),
        [true, false],
      );
    }));
});

describe('frame tokens belong to one window', () => {
  it('refuses window A’s token to window B on serve, release and toggleQuotes', () =>
    withWorld(async w => {
      const frame = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.equal((await serve(w, frame.url, '', w.ids.windowB)).status, 404);
      assert.deepEqual(await w.windowB.call('Mail/release', { url: frame.url }), { ok: true });
      await assert.rejects(
        w.windowB.call('Mail/toggleQuotes', { url: frame.url, open: true }),
        gone,
      );
      const doc = await serve(w, frame.url, '', w.ids.windowA);
      assert.equal(doc.status, 200, 'still window A’s, unspent by B');
      assert.equal((await serve(w, frame.url, 'cid/0', w.ids.windowB)).status, 404);
    }));

  it('releases only for its own window, and says nothing either way', () =>
    withWorld(async w => {
      const frame = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.deepEqual(await w.windowA.call('Mail/release', { url: frame.url.slice(0, -1) }), {
        ok: true,
      });
      assert.equal((await serve(w, frame.url, '', w.ids.windowA)).status, 404);
      for (const url of [frame.url, 'aplos-mail://m/' + 'f'.repeat(32) + '/', 'junk']) {
        assert.deepEqual(await w.windowA.call('Mail/release', { url }), { ok: true });
      }
    }));

  it('toggleQuotes replaces the token with a re-render of the same message and policy', () =>
    withWorld(async w => {
      const first = await frameOf(w.windowA, {
        messageId: IDS.rich,
        imagePolicy: 'load',
        findQuery: 'old',
      });
      const next = (await w.windowA.call('Mail/toggleQuotes', { url: first.url, open: true })) as {
        url: string;
      };
      assert.notEqual(next.url, first.url);
      assert.equal((await serve(w, first.url, '', w.ids.windowA)).status, 404, 'old token freed');
      const html = text((await serve(w, next.url, '', w.ids.windowA)).body);
      assert.match(html, /<details class="aplos-quote" open>/);
      assert.match(html, /<mark class="aplos-find">old<\/mark>/);
      assert.equal((await serve(w, next.url, 'img/0', w.ids.windowA)).status, 200, 'same policy');
      await assert.rejects(
        w.windowA.call('Mail/toggleQuotes', { url: first.url, open: false }),
        gone,
      );
    }));

  it(`evicts the oldest past ${MAX_TOKENS_PER_WINDOW} frames in a window; another window is unaffected`, () =>
    withWorld(async w => {
      const other = await frameOf(w.windowB, { messageId: IDS.rich, imagePolicy: 'block' });
      const urls: string[] = [];
      for (let i = 0; i <= MAX_TOKENS_PER_WINDOW; i++) {
        urls.push((await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' })).url);
      }
      const { tokens } = w.engine.services.mailFrames;
      assert.equal(tokens.liveCount(w.ids.windowA), MAX_TOKENS_PER_WINDOW);
      assert.equal((await serve(w, urls[0], '', w.ids.windowA)).status, 404, 'the oldest went');
      assert.equal((await serve(w, urls[1], '', w.ids.windowA)).status, 200);
      assert.equal((await serve(w, other.url, '', w.ids.windowB)).status, 200, 'B untouched');
    }));
});

describe('token lifetime', () => {
  it('expires an unfetched token after 60 s, keeps a served one for its lazy images', () =>
    withWorld(async w => {
      const late = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      const read = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.equal((await serve(w, read.url, '', w.ids.windowA)).status, 200);
      w.clock.advance(UNFETCHED_TTL_MS);
      assert.equal((await serve(w, late.url, '', w.ids.windowA)).status, 404, 'never fetched');
      w.clock.advance(6 * 60 * 60 * 1000);
      assert.equal((await serve(w, read.url, 'cid/0', w.ids.windowA)).status, 200, 'hours later');
    }));
});
