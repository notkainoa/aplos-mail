import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  frameCsp,
  frameHeaders,
  notFound,
  resourceHeaders,
  RASTER_TYPES,
} from '../../src/frame/headers';

// Every header of every response, compared whole: an added, dropped or edited header fails.

const HASH = 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=';

/** ARCH 10's CSP, typed out independently of headers.ts. */
const ARCH_CSP =
  "default-src 'none'; script-src 'sha256-" +
  HASH +
  "'; style-src 'unsafe-inline'; img-src aplos-mail: data:; font-src aplos-mail: data:; " +
  "media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; " +
  "form-action 'none'; sandbox allow-scripts allow-popups";

describe('frame headers', () => {
  it('builds the document header set exactly', () => {
    assert.deepEqual(frameHeaders(HASH), {
      'content-security-policy': ARCH_CSP,
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-dns-prefetch-control': 'off',
    });
  });

  it('never allows same-origin, forms, modals, top navigation or remote loads', () => {
    const csp = frameCsp(HASH);
    for (const bad of [
      'allow-same-origin',
      'allow-forms',
      'allow-modals',
      'allow-top-navigation',
      "'unsafe-eval'",
      'https:',
      'http:',
      '*',
    ]) {
      assert.equal(csp.includes(bad), false, bad);
    }
    assert.equal(csp.match(/script-src [^;]*/)?.[0], `script-src 'sha256-${HASH}'`);
  });

  it('uses lowercase names only, one of each', () => {
    for (const headers of [frameHeaders(HASH), resourceHeaders('image/png'), notFound().headers]) {
      for (const name of Object.keys(headers)) assert.equal(name, name.toLowerCase());
    }
  });

  it('refuses anything but a base64 SHA-256', () => {
    for (const bad of ['', 'abc', `${HASH}x`, HASH.replace('=', ''), `'; script-src *; '`]) {
      assert.throws(() => frameHeaders(bad), /SHA-256/, bad);
    }
  });

  it('serves the four raster types inline, with a closed policy', () => {
    for (const mime of RASTER_TYPES) {
      assert.deepEqual(resourceHeaders(mime), {
        'content-security-policy': "default-src 'none'; sandbox",
        'content-type': mime,
        'content-disposition': 'inline',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    }
  });

  it('refuses to build headers for any other type (serve answers those with the 404)', () => {
    const others = [
      'image/svg+xml',
      'text/html',
      'text/html; charset=utf-8',
      'IMAGE/PNG',
      'image/png; x=1',
      'image/jpg',
      'application/javascript',
      'text/xml',
      '',
      undefined,
      42,
    ];
    for (const mime of others) {
      assert.throws(() => resourceHeaders(mime as never), /raster/, String(mime));
    }
  });

  it('refuses with one fixed 404', () => {
    const a = notFound();
    assert.deepEqual(a, {
      status: 404,
      headers: {
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
      body: new Uint8Array(0),
    });
    (a.headers as Record<string, string>).x = 'y';
    assert.equal(notFound().headers.x, undefined, 'a fresh object each time');
  });
});
