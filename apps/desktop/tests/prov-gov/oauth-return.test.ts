// `aplos://oauth-return`: the loopback page's deep link, the nonce registry it is checked against,
// and the strict link parsing that decides what main may do with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consumeOauthReturn,
  createOauthReturns,
  isOauthReturnLink,
  oauthReturnLink,
  oauthReturnNonce,
} from '../../src/host/providers/oauth/returns';
import { openLoopback } from '../../src/host/providers/oauth/loopback';

const nonce = 'a'.repeat(32);
const nonce2 = 'b'.repeat(32);

const tmp = () => mkdtempSync(join(tmpdir(), 'aplos-oauth-return-'));
const clock = {
  sleep: (_ms: number, _signal?: AbortSignal) => new Promise<void>(() => {}),
} as never;

// ---------- strict parsing ----------

test('oauthReturnNonce accepts exactly aplos://oauth-return?n=<32 lowercase hex>', () => {
  const link = oauthReturnLink(nonce);
  assert.equal(link, `aplos://oauth-return?n=${nonce}`);
  assert.equal(oauthReturnNonce(link), nonce);
});

const hostile: string[] = [
  `aplos://oauth-return?n=${nonce}&x=1`, // extra param
  `aplos://oauth-return?x=1&n=${nonce}`,
  `aplos://oauth-return?n=${nonce}&n=${nonce2}`, // duplicate
  `aplos://oauth-return?n=${nonce.toUpperCase()}`, // uppercase hex
  `aplos://oauth-return?n=${'a'.repeat(31)}`, // short
  `aplos://oauth-return?n=${'a'.repeat(33)}`, // long
  `aplos://oauth-return?n=${'z'.repeat(32)}`, // non-hex
  'aplos://oauth-return?n=', // empty
  'aplos://oauth-return', // no param
  'aplos://oauth-return?', // empty query
  `aplos://oauth-return/?n=${nonce}`, // ok shape (control: accepted)
  `aplos://other-host?n=${nonce}`, // wrong host
  `aplos://oauth-return/extra?n=${nonce}`, // path
  `aplos://oauth-return:8080?n=${nonce}`, // port
  `aplos://user@oauth-return?n=${nonce}`, // userinfo
  `aplos://u:p@oauth-return?n=${nonce}`,
  `aplos://oauth-return?n=${nonce}#frag`, // fragment
  `aplos://oauth-return?n=${nonce}%23frag`,
  `APLOS://OAUTH-RETURN?n=${nonce}`, // case-normalised (control: accepted)
  `aplos:oauth-return?n=${nonce}`, // opaque form (claimed, rejected)
  `aplos://oauth-return?n=..%2f..%2fetc`,
  `javascript:alert(1)`,
  `data:text/html,<script>1</script>`,
  `aplos://oauth-return ?n=${nonce}`,
  `http://oauth-return?n=${nonce}`, // wrong scheme
  `aplos://oauth-return?N=${nonce}`, // param case
  `aplos://oauth-return?n=${'a'.repeat(500)}`,
];

test('oauthReturnNonce rejects every hostile or malformed variant', () => {
  for (const raw of hostile) {
    // The control cases are valid and expected to parse.
    if (raw === `aplos://oauth-return/?n=${nonce}` || raw === `APLOS://OAUTH-RETURN?n=${nonce}`) {
      assert.equal(oauthReturnNonce(raw), nonce, raw);
      continue;
    }
    assert.equal(oauthReturnNonce(raw), undefined, raw);
  }
});

test('isOauthReturnLink claims only the oauth-return shape, never other aplos links', () => {
  assert.equal(isOauthReturnLink(`aplos://oauth-return?n=${nonce}`), true);
  assert.equal(isOauthReturnLink(`APLOS://OAUTH-RETURN?bad`), true);
  assert.equal(isOauthReturnLink(`aplos:oauth-return?n=${nonce}`), true);
  assert.equal(isOauthReturnLink(`aplos://oauth-return`), true);
  assert.equal(isOauthReturnLink(`aplos://compose?to=x@y`), false);
  assert.equal(isOauthReturnLink(`mailto:a@b`), false);
  assert.equal(isOauthReturnLink(`aplos://oauth-return.evil?n=${nonce}`), false);
});

test('isOauthReturnLink claims every oauth-return near-miss so it cannot reach handleLink', () => {
  // Slash-count, port, trailing-dot, userinfo, extra-path and overlong variants are all claimed:
  // each then fails the strict nonce check and is a silent no-op instead of a focused window with
  // the raw link (nonce included) forwarded to the renderer.
  assert.equal(isOauthReturnLink(`aplos:/oauth-return?n=${nonce}`), true);
  assert.equal(isOauthReturnLink(`aplos:///oauth-return?n=${nonce}`), true);
  assert.equal(isOauthReturnLink(`aplos://oauth-return:443?n=${nonce}`), true);
  assert.equal(isOauthReturnLink(`aplos://oauth-return.?n=${nonce}`), true);
  assert.equal(isOauthReturnLink(`aplos://OAUTH-RETURN.:443?n=${nonce}`), true);
  assert.equal(isOauthReturnLink(`aplos://oauth-return/extra?n=${nonce}`), true);
  assert.equal(isOauthReturnLink(`aplos://user@oauth-return?n=${nonce}`), true);
  assert.equal(isOauthReturnLink(`aplos:oauth-return-anything?n=${nonce}`), true);
  assert.equal(isOauthReturnLink(`aplos://oauth-return?n=${'a'.repeat(500)}`), true);
  // Still not claimed: a different host or scheme keeps its existing handling.
  assert.equal(isOauthReturnLink(`aplos://oauth-return.evil?n=${nonce}`), false);
  assert.equal(isOauthReturnLink(`aplos://notoauth-return?n=${nonce}`), false);
  assert.equal(isOauthReturnLink(`aplos://compose/oauth-return?n=${nonce}`), false);
});

// ---------- the registry ----------

test('register then consume returns the purpose once; a second consume or a replay is a no-op', () => {
  const dir = tmp();
  try {
    const returns = createOauthReturns({ dir });
    assert.equal(returns.register({ nonce, purpose: 'onboarding', ttlMs: 60_000 }), true);
    const consumed = new Set<string>();
    const opts = { dir, consumed };
    assert.equal(consumeOauthReturn(opts, nonce), 'onboarding');
    assert.equal(consumeOauthReturn(opts, nonce), undefined);
    // Even if the file were re-created, the in-memory set blocks it.
    writeFileSync(
      join(dir, `${nonce}.json`),
      JSON.stringify({ purpose: 'mail', exp: Date.now() + 1e5 }),
    );
    assert.equal(consumeOauthReturn(opts, nonce), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an expired or forged entry is a no-op; revoke drops a live one', () => {
  const dir = tmp();
  try {
    const now = Date.now();
    let clockNow = now;
    const returns = createOauthReturns({ dir, now: () => clockNow });
    returns.register({ nonce, purpose: 'mail', ttlMs: 1_000 });
    clockNow = now + 2_000;
    assert.equal(consumeOauthReturn({ dir, now: () => clockNow }, nonce), undefined);
    returns.register({ nonce: nonce2, purpose: 'mail', ttlMs: 60_000 });
    returns.revoke(nonce2);
    assert.equal(consumeOauthReturn({ dir }, nonce2), undefined);
    assert.equal(consumeOauthReturn({ dir }, 'c'.repeat(32)), undefined); // never issued
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the registry is bounded: past the cap, register refuses and the page gets no link', () => {
  const dir = tmp();
  try {
    const returns = createOauthReturns({ dir, maxEntries: 2 });
    assert.equal(returns.register({ nonce, purpose: 'mail', ttlMs: 1e5 }), true);
    assert.equal(returns.register({ nonce: nonce2, purpose: 'mail', ttlMs: 1e5 }), true);
    assert.equal(returns.register({ nonce: 'c'.repeat(32), purpose: 'mail', ttlMs: 1e5 }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused delete still spends the nonce: consume and revoke leave a tombstone the sweep removes', () => {
  const dir = tmp();
  try {
    const returns = createOauthReturns({ dir });
    assert.equal(returns.register({ nonce, purpose: 'mail', ttlMs: 60_000 }), true);
    assert.equal(returns.register({ nonce: nonce2, purpose: 'mail', ttlMs: 60_000 }), true);
    // A directory the process cannot delete from: the unlink fails, the file itself stays writable.
    chmodSync(dir, 0o500);
    try {
      assert.equal(consumeOauthReturn({ dir, consumed: new Set() }, nonce), 'mail');
      // A fresh consumed set (as after a restart) still reads the nonce as spent, and so does a
      // revoked one — the failed unlink left a tombstone, not a live entry.
      assert.equal(consumeOauthReturn({ dir, consumed: new Set() }, nonce), undefined);
      assert.equal(readFileSync(join(dir, `${nonce}.json`), 'utf8'), '');
      returns.revoke(nonce2);
      assert.equal(consumeOauthReturn({ dir, consumed: new Set() }, nonce2), undefined);
    } finally {
      chmodSync(dir, 0o700);
    }
    // The next register's sweep deletes both tombstones.
    assert.equal(returns.register({ nonce: 'c'.repeat(32), purpose: 'mail', ttlMs: 60_000 }), true);
    assert.throws(() => readFileSync(join(dir, `${nonce}.json`), 'utf8'));
    assert.throws(() => readFileSync(join(dir, `${nonce2}.json`), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlinked entry file is never followed', () => {
  const dir = tmp();
  const real = join(tmp(), 'real.json');
  writeFileSync(real, JSON.stringify({ purpose: 'mail', exp: Date.now() + 1e5 }));
  try {
    symlinkSync(real, join(dir, `${nonce}.json`));
    assert.equal(consumeOauthReturn({ dir }, nonce), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(real, { force: true });
  }
});

// ---------- the page ----------

async function get(
  url: string,
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const res = await fetch(url);
  const headers: Record<string, unknown> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, headers, body: await res.text() };
}

async function openTestLoopback(returnLink?: string) {
  const controller = new AbortController();
  const loopback = await openLoopback({
    state: 'state-1',
    clock,
    signal: controller.signal,
    ...(returnLink ? { returnLink } : {}),
  });
  return { loopback, controller };
}

test('the ok page redirects to the deep link and keeps a visible fallback anchor', async () => {
  const link = oauthReturnLink(nonce);
  const { loopback, controller } = await openTestLoopback(link);
  try {
    const page = await get(`${loopback.redirectUri}?state=state-1&code=x`);
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['content-security-policy'], "default-src 'none'");
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(
      page.body,
      new RegExp(`http-equiv="refresh" content="0;url=${link.replace(/[?]/g, '\\?')}`),
    );
    assert.match(page.body, new RegExp(`<a href="${link.replace(/[?]/g, '\\?')}">`));
    assert.doesNotMatch(page.body, /script/i);
  } finally {
    controller.abort();
    loopback.close();
  }
});

test('the error page offers the link but no redirect; the refused page has neither', async () => {
  const link = oauthReturnLink(nonce);
  const { loopback, controller } = await openTestLoopback(link);
  try {
    const failed = await get(`${loopback.redirectUri}?state=state-1&error=access_denied`);
    assert.equal(failed.status, 200);
    assert.match(failed.body, new RegExp(`<a href="${link.replace(/[?]/g, '\\?')}">`));
    assert.doesNotMatch(failed.body, /http-equiv="refresh"/);
  } finally {
    controller.abort();
    loopback.close();
  }
  const refusedRun = await openTestLoopback(link);
  try {
    const refused = await get(`${refusedRun.loopback.redirectUri}?state=wrong&code=x`);
    assert.equal(refused.status, 400);
    assert.doesNotMatch(refused.body, /aplos:/);
  } finally {
    refusedRun.controller.abort();
    refusedRun.loopback.close();
  }
});

test('without a return link the pages stay the plain text they were', async () => {
  const { loopback, controller } = await openTestLoopback();
  try {
    const ok = await get(`${loopback.redirectUri}?state=state-1&code=x`);
    assert.equal(ok.headers['content-type'], 'text/plain; charset=utf-8');
    assert.doesNotMatch(ok.body, /aplos:/);
  } finally {
    controller.abort();
    loopback.close();
  }
});
