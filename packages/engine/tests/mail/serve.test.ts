import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContractError } from '@aplos/contract/contract-error';
import { notFound } from '@aplos/mail-html/frame';
import { READING_DOCTYPE } from '@aplos/mail-html';
import { IMAGE_PROXY_LIMITS } from '../../src/ports';
import { EXE, frameOf, HTML, IDS, mailWorld, PNG, serve, SVG, text, type World } from './harness';

// `Mail/serve`: main's relay only, the window id it passes or the 404, and bytes typed by sniffing alone.

async function withWorld(fn: (w: World) => Promise<void>) {
  const world = await mailWorld();
  try {
    await fn(world);
  } finally {
    await world.cleanup();
  }
}

async function servedFrame(w: World, imagePolicy: 'block' | 'load' = 'load') {
  const frame = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy });
  assert.equal((await serve(w, frame.url, '', w.ids.windowA)).status, 200);
  return frame;
}

describe('Mail/serve', () => {
  it('fails closed without a window id: absent or empty is the 404, and nothing is spent', () =>
    withWorld(async w => {
      const frame = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.deepEqual(await serve(w, frame.url, ''), notFound(), 'absent');
      assert.deepEqual(await serve(w, frame.url, '', ''), notFound(), 'empty');
      assert.equal((await serve(w, frame.url, '', w.ids.windowA)).status, 200, 'still unspent');
    }));

  it('serves the document in standards mode: <!DOCTYPE html> first, then the reporter last', () =>
    withWorld(async w => {
      const frame = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      const served = await serve(w, frame.url, '', w.ids.windowA);
      const document = text(served.body);
      assert.ok(document.startsWith(`${READING_DOCTYPE}<html>`), document.slice(0, 40));
      assert.equal(document.match(/<!doctype/gi)?.length, 1);
      assert.ok(/<script>[^]*<\/script><\/body><\/html>$/.test(document), 'the reporter is last');
    }));

  it('never throws, for any token or path', () =>
    withWorld(async w => {
      const cases = [
        { token: '', path: '' },
        { token: 'x'.repeat(64), path: '../../etc/passwd' },
        { token: 'f'.repeat(32), path: 'cid/0', windowId: 'c1' },
        { token: 'f'.repeat(32), path: '%2e%2e/cid/0', windowId: 'c1' },
      ];
      for (const args of cases) assert.deepEqual(await w.main.call('Mail/serve', args), notFound());
    }));

  it('is refused to a window caller by the dispatch scope check', () =>
    withWorld(async w => {
      const frame = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      const args = { token: frame.url.slice(15, -1), path: '', windowId: w.ids.windowA };
      await assert.rejects(
        w.windowA.call('Mail/serve', args),
        (e: unknown) => e instanceof ContractError && e.type === 'forbidden',
      );
      assert.equal((await serve(w, frame.url, '', w.ids.windowA)).status, 200, 'not spent');
    }));

  it('serves PNG and refuses SVG, HTML and an executable, whatever mime is claimed', () =>
    withWorld(async w => {
      const frame = await servedFrame(w);
      assert.equal((await serve(w, frame.url, 'cid/0', w.ids.windowA)).status, 200);
      for (const bytes of [SVG, HTML, EXE]) {
        w.parts.set('part-1', bytes);
        assert.deepEqual(await serve(w, frame.url, 'cid/0', w.ids.windowA), notFound(), 'cid');
        w.setImage({ kind: 'image', mime: 'image/png', bytes });
        assert.deepEqual(await serve(w, frame.url, 'img/0', w.ids.windowA), notFound(), 'img');
      }
      w.setImage({ kind: 'image', mime: 'image/gif', bytes: PNG });
      const image = await serve(w, frame.url, 'img/0', w.ids.windowA);
      assert.equal(image.headers['content-type'], 'image/png', 'sniffed, not the claim');
    }));

  it('answers a proxy refusal or a missing part with the 404', () =>
    withWorld(async w => {
      const frame = await servedFrame(w);
      w.setImage({ kind: 'refused', reason: 'address' });
      assert.deepEqual(await serve(w, frame.url, 'img/0', w.ids.windowA), notFound());
      w.parts.delete('part-1');
      assert.deepEqual(await serve(w, frame.url, 'cid/0', w.ids.windowA), notFound());
      assert.deepEqual(await serve(w, frame.url, 'cid/1', w.ids.windowA), notFound(), 'unissued');
    }));

  it('refuses a proxied image over the proxy’s byte cap, even if the proxy hands it over', () =>
    withWorld(async w => {
      const frame = await servedFrame(w);
      const big = new Uint8Array(IMAGE_PROXY_LIMITS.maxBytes + 1);
      big.set(PNG);
      w.setImage({ kind: 'image', mime: 'image/png', bytes: big });
      // Compared by status: a failing deepEqual of two 10 MB arrays would take a minute to print.
      assert.equal((await serve(w, frame.url, 'img/0', w.ids.windowA)).status, 404);
      const exact = new Uint8Array(IMAGE_PROXY_LIMITS.maxBytes);
      exact.set(PNG);
      w.setImage({ kind: 'image', mime: 'image/png', bytes: exact });
      assert.equal((await serve(w, frame.url, 'img/0', w.ids.windowA)).status, 200, 'at the cap');
    }));

  it('gives a proxy that never answers the proxy’s time limit, then the 404', () =>
    withWorld(async w => {
      const frame = await servedFrame(w);
      w.setImageFn(() => new Promise(() => undefined));
      const pending = serve(w, frame.url, 'img/0', w.ids.windowA);
      await new Promise(resolve => setImmediate(resolve));
      w.clock.advance(IMAGE_PROXY_LIMITS.timeoutMs - 1);
      await new Promise(resolve => setImmediate(resolve));
      w.clock.advance(1);
      assert.deepEqual(await pending, notFound());
    }));

  it('refuses an inline part over the byte cap', () =>
    withWorld(async w => {
      const frame = await servedFrame(w);
      const big = new Uint8Array(10_000_001);
      big.set(PNG);
      w.parts.set('part-1', big);
      assert.deepEqual(await serve(w, frame.url, 'cid/0', w.ids.windowA), notFound());
    }));
});
