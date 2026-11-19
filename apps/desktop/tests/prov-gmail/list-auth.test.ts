import test from 'node:test';
import assert from 'node:assert/strict';
import { messageWrite } from '../../../../packages/engine/src/sync/facts';
import { METADATA_HEADERS, messageFacts } from '../../src/host/providers/google/facts';
import {
  aligned,
  googleResults,
  LIST_AUTH_LIMITS,
  listAuthenticated,
} from '../../src/host/providers/google/list-auth';
import type { GmailHeader } from '../../src/host/providers/google/mime';

/**
 * `list.authenticated` from Gmail's own Authentication-Results (RFC 8058 section 4): hand-written headers in message
 * order, top first, as `payload.headers` returns them. No network, no clock.
 */

const B = 'AbCdEf12GhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGhIjKlMnOpQrStUv==';
const H = 'from:to:subject:date:message-id:list-unsubscribe:list-unsubscribe-post';
const LIST = '<https://news.example.com/u?t=1>, <mailto:leave@news.example.com>';
const POST = 'List-Unsubscribe=One-Click';
const SPF =
  'spf=pass (google.com: domain of bounce@news.example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@news.example.com';
const DMARC = 'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=news.example.com';
const PASS = 'dkim=pass header.i=@example.com header.s=s1 header.b=AbCdEf12';

interface Signature {
  d?: string;
  s?: string;
  h?: string;
  b?: string;
}

function signature({ d = 'example.com', s = 's1', h = H, b = B }: Signature = {}): string {
  return `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${d}; s=${s};\r\n\th=${h};\r\n\tbh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=;\r\n\tb=${b}`;
}

function ar(results: string, id = 'mx.google.com'): GmailHeader {
  return { name: 'Authentication-Results', value: `${id};\r\n       ${results}` };
}

const h = (name: string, value: string): GmailHeader => ({ name, value });

interface Newsletter {
  results?: GmailHeader[];
  signatures?: string[];
  from?: GmailHeader[];
  list?: GmailHeader[];
  extra?: GmailHeader[];
}

/** A signed newsletter from `news.example.com`, signed by the parent `example.com`, as Gmail delivers it. */
function newsletter(over: Newsletter = {}): GmailHeader[] {
  return [
    h('Delivered-To', 'me@gmail.com'),
    h('ARC-Seal', 'i=1; a=rsa-sha256; t=1; cv=none; d=google.com; s=arc-20240605; b=xyz'),
    h('ARC-Authentication-Results', `i=1; mx.google.com; ${PASS}; ${SPF}; ${DMARC}`),
    ...(over.results ?? [ar(`${PASS};\r\n       ${SPF};\r\n       ${DMARC}`)]),
    ...(over.signatures ?? [signature()]).map(value => h('DKIM-Signature', value)),
    ...(over.from ?? [h('From', 'News <hello@news.example.com>')]),
    h('To', 'me@gmail.com'),
    h('Subject', 'This week'),
    ...(over.list ?? [h('List-Unsubscribe', LIST), h('List-Unsubscribe-Post', POST)]),
    ...(over.extra ?? []),
  ];
}

function facts(headers: GmailHeader[]) {
  const message = { id: 'g1', threadId: 't1', internalDate: '1', payload: { headers } };
  return messageFacts(message, { self: 'me@gmail.com', partial: true });
}

function verdict(headers: GmailHeader[]): boolean | undefined {
  return facts(headers).list.authenticated;
}

// ---- true ----

test('a cleanly signed newsletter is authenticated: Google A-R, aligned parent d=, h= covers all three', () => {
  assert.equal(verdict(newsletter()), true);
});

test('strict alignment, header.d instead of header.i, and an unrelated second signature are fine', () => {
  const results = [ar(`dkim=pass header.d=news.example.com header.s=k2 header.b=QrStUv99; ${SPF}`)];
  const own = signature({ d: 'news.example.com', s: 'k2', b: 'QrStUv99xyz' });
  const esp = signature({ d: 'esp.example.net', s: 'k2', b: 'QrStUv99abc' });
  assert.equal(verdict(newsletter({ results, signatures: [esp, own] })), true);
});

test('comments, quoting and folded whitespace in the A-R and in b= and h= are read as RFC 8601 and 6376 allow', () => {
  const results = [
    ar(
      'dkim = pass (good (nested) signature, really) reason="ok, fine"\r\n\theader.i="@example.com"' +
        ' header.s=s1 header.b="AbCdEf12"',
      'mx.google.com 1 (Google (mail))',
    ),
  ];
  const folded = signature({
    h: 'From : To:\r\n\tSubject:List-Unsubscribe:\r\n\t List-Unsubscribe-Post',
    b: 'AbCd\r\n\tEf12GhIj',
  });
  assert.equal(verdict(newsletter({ results, signatures: [folded] })), true);
});

// ---- false: the A-R ----

test('the topmost A-R must be Google’s: a foreign one on top is false', () => {
  const results = [ar(PASS, 'mx.evil.test'), ar(PASS)];
  assert.equal(verdict(newsletter({ results })), false);
});

test('a lower A-R claiming mx.google.com dkim=pass is ignored, and so are ARC-* headers', () => {
  const results = [ar(`dkim=fail header.i=@example.com header.b=AbCdEf12; ${SPF}`), ar(PASS)];
  assert.equal(verdict(newsletter({ results })), false);
  const none = [ar(`${SPF}; ${DMARC}`)];
  assert.equal(verdict(newsletter({ results: none, extra: [ar(PASS)] })), false);
});

test('a dkim=pass hidden in a comment or after a second id does not count', () => {
  const comment = [ar(`dkim=fail (; ${PASS}) header.i=@example.com`)];
  assert.equal(verdict(newsletter({ results: comment })), false);
  const spoofed = [h('Authentication-Results', `mx.google.com mx.evil.test; ${PASS}`)];
  assert.equal(verdict(newsletter({ results: spoofed })), false);
});

test('dkim=fail, or only spf=pass and dmarc=pass, is false', () => {
  const fail = [ar(`dkim=fail header.i=@example.com header.s=s1 header.b=AbCdEf12; ${SPF}`)];
  assert.equal(verdict(newsletter({ results: fail })), false);
  assert.equal(verdict(newsletter({ results: [ar(`${SPF}; ${DMARC}`)] })), false);
  assert.equal(verdict(newsletter({ results: [ar('none')] })), false);
});

test('an A-R over the length cap is false, quickly, and so are unterminated or deeply nested comments', () => {
  const started = performance.now();
  const long = [ar(`${PASS}; ${SPF} (${'x'.repeat(LIST_AUTH_LIMITS.maxResultsChars)})`)];
  assert.equal(verdict(newsletter({ results: long })), false);
  assert.equal(verdict(newsletter({ results: [ar(`${PASS} (open`)] })), false);
  const deep = '('.repeat(20) + ')'.repeat(20);
  assert.equal(verdict(newsletter({ results: [ar(`${PASS} ${deep}`)] })), false);
  assert.equal(googleResults(`mx.google.com; ${'('.repeat(4_000)}`), null);
  assert.equal(googleResults(`mx.google.com; ${'a= '.repeat(1_300)}`), null);
  assert.ok(performance.now() - started < 200);
});

test('a result that repeats a property fails the header as ambiguous', () => {
  const results = [ar(`${PASS} header.d=example.com header.d=evil.test`)];
  assert.equal(verdict(newsletter({ results })), false);
});

// ---- false: alignment ----

const BANK = {
  from: [h('From', 'Bank <alerts@bank.example>')],
  signatures: [signature({ d: 'bank.example', s: 's1', b: 'AAAAAAAAxxxxxxxxxxxx' })],
};

test('a dkim=fail or neutral for the same signature beside a dkim=pass is false', () => {
  const results = [
    ar(
      'dkim=fail header.i=@bank.example header.s=s1 header.b=AAAAAAAA; dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA',
    ),
  ];
  assert.equal(verdict(newsletter({ ...BANK, results })), false);
  const neutral = [
    ar(
      'dkim=neutral (body hash did not verify) header.i=@bank.example header.s=s1 header.b=AAAAAAAA; dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA',
    ),
  ];
  assert.equal(verdict(newsletter({ ...BANK, results: neutral })), false);
  const reversed = [
    ar(
      'dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA; dkim=fail header.i=@bank.example header.s=s1 header.b=AAAAAAAA',
    ),
  ];
  assert.equal(verdict(newsletter({ ...BANK, results: reversed })), false);
});

test('the injected-comment repro: sender text echoed in Google’s A-R cannot make a dkim=pass appear', () => {
  // The envelope sender is echoed into the SPF comment; a quote and `;` there split the header so a forged
  // `dkim=pass` segment is seen next to Google's own `dkim=neutral` for the same signature.
  const results = [
    ar(
      'dkim=neutral (body hash did not verify) header.i=@bank.example header.s=s1 header.b=AAAAAAAA; ' +
        'spf=pass (google.com: domain of "x); dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA; ' +
        'spf=none ("@evil.example designates 1.2.3.4 as permitted sender) smtp.mailfrom="x"; ' +
        'dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=bank.example',
    ),
  ];
  assert.equal(verdict(newsletter({ ...BANK, results })), false);
});

test('i= below d= cannot hide Google’s fail: sameness is decided by the b= prefix alone', () => {
  // Forged `d=bank.example; i=@sub.bank.example`: Google reports header.i=@sub.bank.example for it, the injected
  // pass says @bank.example. Different domains, same signature.
  const attack = {
    ...BANK,
    signatures: [signature({ d: 'bank.example', s: 's1', b: 'AAAAAAAAxxxxxxxxxxxx' })],
  };
  const results = [
    ar(
      'dkim=fail header.i=@sub.bank.example header.s=s1 header.b=AAAAAAAA; ' +
        'dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA',
    ),
  ];
  assert.equal(verdict(newsletter({ ...attack, results })), false);
  const otherSelector = [
    ar(
      'dkim=fail header.i=@bank.example header.s=zz header.b=AAAAAAAA; ' +
        'dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA',
    ),
  ];
  assert.equal(verdict(newsletter({ ...attack, results: otherSelector })), false);
});

test('a non-pass dkim result without a b= counts as contradicting', () => {
  const results = [ar(`dkim=neutral header.i=@example.com; ${PASS}; ${SPF}`)];
  assert.equal(verdict(newsletter({ results })), false);
});

test('a raw ( or " inside a value, or a dkim result after spf or dmarc, fails the header', () => {
  const hidden = [
    ar(
      'dkim=fail header.s=k( header.i=@bank.example header.b=AAAAAAAA; spf=pass (google.com: domain of "a)); ' +
        'dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA; x.y=z ("@evil.example) smtp.mailfrom="b"',
    ),
  ];
  assert.equal(verdict(newsletter({ ...BANK, results: hidden })), false);
  const quote = [ar('dkim=pass header.i=@example.com"x header.s=s1 header.b=AbCdEf12')];
  assert.equal(verdict(newsletter({ results: quote })), false);
  const late = [ar(`${SPF}; ${PASS}; ${DMARC}`)];
  assert.equal(verdict(newsletter({ results: late })), false);
  const lateAfterDmarc = [
    ar(`${PASS}; ${DMARC}; dkim=pass header.i=@example.com header.s=s1 header.b=AbCdEf12`),
  ];
  assert.equal(verdict(newsletter({ results: lateAfterDmarc })), false);
  // Google's real order: the dkim run, then arc, spf and dmarc.
  const arc = 'arc=pass (i=1 spf=pass spfdomain=news.example.com dkim=pass dkdomain=example.com)';
  const real = [ar(`${PASS}; ${arc}; ${SPF}; ${DMARC}`)];
  assert.equal(verdict(newsletter({ results: real })), true);
  const arcFirst = [ar(`${arc}; ${PASS}; ${SPF}; ${DMARC}`)];
  assert.equal(verdict(newsletter({ results: arcFirst })), false);
});

test('a ( glued to a value would hide Google’s fail in a comment: the header is refused', () => {
  // Only this rule stops it: no dkim result is left that contradicts, and the dkim results all precede the spf ones.
  // Without it the comment opened at `header.s=k(` swallows the real `dkim=fail` for the forged signature.
  const results = [
    ar(
      'dkim=pass header.i=@example.com header.s=k( header.b=ZZZZZZZZ; ' +
        'dkim=fail header.i=@bank.example header.s=s1 header.b=AAAAAAAA; ' +
        'spf=pass (google.com: domain of "a)); ' +
        'dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA; spf=none smtp.mailfrom="x"',
    ),
  ];
  assert.equal(verdict(newsletter({ ...BANK, results })), false);
  const quoted = [ar('dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA"x; spf=pass')];
  assert.equal(verdict(newsletter({ ...BANK, results: quoted })), false);
});

test('an opener right after = cannot swallow Google’s own header.b and spf result: no ; inside a comment or quote', () => {
  // Forged `s=(` or `s="` plus a crafted envelope sender in the SPF comment: the comment or quote runs across the `;`
  // between results, so the real fail loses its b= and the injected pass appears before any spf result.
  const comment =
    'dkim=fail header.i=@bank.example header.s=( header.b=AAAAAAAA; spf=pass (google.com: domain of x)) s2 header.b=ZZZZZZZZ; ' +
    'dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA; dmarc=pass header.from=bank.example';
  const quote =
    'dkim=fail header.i=@bank.example header.s=" header.b=AAAAAAAA; spf=pass (google.com: domain of x" header.b=ZZZZZZZZ; ' +
    'dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA; dmarc=pass header.from=bank.example';
  const escaped =
    'dkim=fail header.i=@bank.example header.s=( header.b=AAAAAAAA\\; spf=pass (google.com: domain of x)) s2 header.b=ZZZZZZZZ; ' +
    'dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA; dmarc=pass header.from=bank.example';
  for (const results of [comment, quote, escaped])
    assert.equal(verdict(newsletter({ ...BANK, results: [ar(results)] })), false, results);
});

test('round 4: a dkim pass injected after an ARC comment, and a b= that reads back differently, are refused', () => {
  const junk = signature({ d: 'bank.example', s: 's9', b: '()AAAAAAzz' });
  // The reviewer's input: the ARC comment (attacker's own hop) is closed by the sender text, `;` is then outside any
  // comment, and `()` / `""` in b= vanish from Google's header.b but not from the signature.
  const attack =
    'dkim=fail header.i=@bank.example header.s=s9 header.b=()AAAAAA; ' +
    'arc=pass (i=1 spf=pass spfdomain=evil.example dkim=pass dkdomain=x); ' +
    'dkim=pass header.i=@bank.example header.b="()AAAA"; x.y=z (); ' +
    'spf=pass (google.com: domain of b@evil.example) smtp.mailfrom=b@evil.example; ' +
    'dmarc=fail (p=NONE) header.from=bank.example';
  const attackFrom = { from: [h('From', 'Bank <alerts@bank.example>')] };
  assert.equal(
    verdict(newsletter({ ...attackFrom, signatures: [junk], results: [ar(attack)] })),
    false,
  );
  const quotes = signature({ d: 'bank.example', s: 's9', b: '""AAAAAAzz' });
  assert.equal(
    verdict(newsletter({ ...attackFrom, signatures: [quotes], results: [ar(attack)] })),
    false,
  );
});

test('round 4, each rule alone: a dkim after another result is refused; a non-base64 b= is not compared', () => {
  const clean = { from: [h('From', 'Bank <alerts@bank.example>')] };
  const good = signature({ d: 'bank.example', s: 's1', b: 'AAAAAAAAxxxxxxxxxxxx' });
  const pass = 'dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA';
  // Order alone: a clean pass, but after an arc result.
  const late = [ar(`arc=pass (i=1); ${pass}; ${SPF}`)];
  assert.equal(verdict(newsletter({ ...clean, signatures: [good], results: late })), false);
  // Base64 alone: right order, a pass whose header.b holds a `(`-free junk character, and a signature to match.
  const junkBody = signature({ d: 'bank.example', s: 's1', b: 'AAAA-AAAxxxxxxxx' });
  const junk = [ar('dkim=pass header.i=@bank.example header.s=s1 header.b=AAAA-AAA')];
  assert.equal(verdict(newsletter({ ...clean, signatures: [junkBody], results: junk })), false);
  // A failed dkim whose header.b is not base64 cannot be compared with the pass, so it counts against it.
  const failJunk = [
    ar(`dkim=fail header.i=@bank.example header.s=s1 header.b=AA!AAAAA; ${pass}; ${SPF}`),
  ];
  assert.equal(verdict(newsletter({ ...clean, signatures: [good], results: failJunk })), false);
  // Control: the same pass, right order, base64: authenticated.
  assert.equal(
    verdict(newsletter({ ...clean, signatures: [good], results: [ar(`${pass}; ${SPF}`)] })),
    true,
  );
});

test('a signature whose b= is not base64 is refused even when Google’s prefix matches its first characters', () => {
  const body = signature({ d: 'bank.example', s: 's1', b: 'AAAAAAAA()xxxx' });
  const results = [
    ar(
      'dkim=pass header.i=@bank.example header.s=s1 header.b=AAAAAAAA; spf=none smtp.mailfrom=a@b.example',
    ),
  ];
  const from = [h('From', 'Bank <alerts@bank.example>')];
  assert.equal(verdict(newsletter({ from, signatures: [body], results })), false);
});

test('an escaped ; inside a quoted string fails the header', () => {
  const results = [
    ar(`${PASS}; ${SPF.replace('smtp.mailfrom=bounce@news.example.com', 'smtp.mailfrom="a\\;b"')}`),
  ];
  assert.equal(verdict(newsletter({ results })), false);
  assert.equal(verdict(newsletter({ results: [ar(`${PASS}; ${SPF}`)] })), true);
});

test('a failed dkim for another domain or another signature does not hide a good pass', () => {
  const results = [
    ar(`dkim=fail header.i=@esp.example.net header.s=k9 header.b=ZZZZZZZZ; ${PASS}; ${SPF}`),
  ];
  assert.equal(verdict(newsletter({ results })), true);
  const sameDomain = [
    ar(`dkim=fail header.i=@example.com header.s=s2 header.b=ZZZZZZZZ; ${PASS}; ${SPF}`),
  ];
  assert.equal(verdict(newsletter({ results: sameDomain })), true);
});

test('one result that does not parse fails the whole header, and a trailing semicolon does not', () => {
  assert.equal(verdict(newsletter({ results: [ar(`${PASS}; none`)] })), false);
  assert.equal(verdict(newsletter({ results: [ar(`${PASS}; dkim=pass header.i`)] })), false);
  assert.equal(
    verdict(newsletter({ results: [ar(`${PASS}; spf=pass smtp.mailfrom=a b=`)] })),
    false,
  );
  assert.equal(verdict(newsletter({ results: [ar(`${PASS};`)] })), true);
});

test('lookalike authserv-ids are not Google’s', () => {
  for (const id of [
    'evil-mx.google.com',
    'mx.google.com.evil.test',
    'xmx.google.com',
    'mx.google.com.',
    'google.com',
    'mx.google.comx',
  ])
    assert.equal(verdict(newsletter({ results: [ar(PASS, id)] })), false, id);
});

test('dkim=pass for a d= that does not align with From is false', () => {
  const results = [ar('dkim=pass header.i=@evil.test header.s=s1 header.b=AbCdEf12')];
  const signatures = [signature({ d: 'evil.test' })];
  assert.equal(verdict(newsletter({ results, signatures })), false);
});

test('a dotless d= (a bare TLD) never aligns, and d= below From does not either', () => {
  const results = [ar('dkim=pass header.i=@com header.s=s1 header.b=AbCdEf12')];
  const from = [h('From', 'a@example.com')];
  assert.equal(
    verdict(newsletter({ results, signatures: [signature({ d: 'com' })], from })),
    false,
  );
  assert.equal(aligned('news.example.com', 'com'), false);
  assert.equal(aligned('news.example.com', '.example.com'), false);
  assert.equal(aligned('example.com', 'news.example.com'), false);
  assert.equal(aligned('badexample.com', 'example.com'), false);
  assert.equal(aligned('news.example.com', 'example.com'), true);
});

test('two From headers, or one with two addresses, is false', () => {
  const two = [h('From', 'hello@news.example.com'), h('From', 'other@evil.test')];
  assert.equal(verdict(newsletter({ from: two })), false);
  const both = [h('From', 'hello@news.example.com, other@evil.test')];
  assert.equal(verdict(newsletter({ from: both })), false);
});

// ---- false: the signature ----

test('h= must list From, List-Unsubscribe and List-Unsubscribe-Post', () => {
  const noPost = signature({ h: 'from:to:subject:list-unsubscribe' });
  assert.equal(verdict(newsletter({ signatures: [noPost] })), false);
  const noFrom = signature({ h: 'to:subject:list-unsubscribe:list-unsubscribe-post' });
  assert.equal(verdict(newsletter({ signatures: [noFrom] })), false);
  const upper = signature().replace('h=', 'H=');
  assert.equal(verdict(newsletter({ signatures: [upper] })), false);
});

test('a decoy DKIM-Signature with the same d=, s= and b= prefix makes the match ambiguous', () => {
  const decoy = signature({ b: 'AbCdEf12ZZZZ' });
  assert.equal(verdict(newsletter({ signatures: [signature(), decoy] })), false);
  const other = signature({ b: 'XyXyXy12ZZZZ' });
  assert.equal(verdict(newsletter({ signatures: [signature(), other] })), true);
});

test('no matching DKIM-Signature, a selector mismatch, or a header.b under six characters is false', () => {
  assert.equal(verdict(newsletter({ signatures: [signature({ b: 'ZzZzZz' })] })), false);
  assert.equal(verdict(newsletter({ signatures: [signature({ s: 's2' })] })), false);
  assert.equal(verdict(newsletter({ signatures: [] })), false);
  const short = [ar('dkim=pass header.i=@example.com header.s=s1 header.b=AbCdE')];
  assert.equal(verdict(newsletter({ results: short })), false);
  const lower = [ar('dkim=pass header.i=@example.com header.s=s1 header.b=abcdef12')];
  assert.equal(verdict(newsletter({ results: lower })), false);
});

test('an unreadable DKIM-Signature (too long, repeated tag) is false: it could be the one that matches', () => {
  const long = `${signature()}; x=${'a'.repeat(LIST_AUTH_LIMITS.maxSignatureChars)}`;
  assert.equal(verdict(newsletter({ signatures: [long] })), false);
  assert.equal(verdict(newsletter({ signatures: [`${signature()}; d=evil.test`] })), false);
});

// ---- false: the list headers ----

test('List-Unsubscribe and List-Unsubscribe-Post must each appear exactly once', () => {
  const twoLists = [
    h('List-Unsubscribe', LIST),
    h('List-Unsubscribe', LIST),
    h('List-Unsubscribe-Post', POST),
  ];
  assert.equal(verdict(newsletter({ list: twoLists })), false);
  const twoPosts = [
    h('List-Unsubscribe', LIST),
    h('List-Unsubscribe-Post', POST),
    h('List-Unsubscribe-Post', POST),
  ];
  assert.equal(verdict(newsletter({ list: twoPosts })), false);
  assert.equal(verdict(newsletter({ list: [h('List-Unsubscribe', LIST)] })), false);
});

// ---- absent ----

test('no A-R at all, or no List-Unsubscribe, leaves the field out (unknown)', () => {
  const noAr = facts(newsletter({ results: [] })).list;
  assert.equal('authenticated' in noAr, false);
  const noList = facts(newsletter({ list: [] })).list;
  assert.equal('authenticated' in noList, false);
  assert.equal(listAuthenticated([], []), undefined);
});

// ---- wiring ----

test('the verdict reaches the store write, and metadata asks for both headers', () => {
  assert.equal(messageWrite('a1', 'me@gmail.com', facts(newsletter())).listAuthenticated, true);
  const fail = newsletter({ results: [ar(`${SPF}; ${DMARC}`)] });
  assert.equal(messageWrite('a1', 'me@gmail.com', facts(fail)).listAuthenticated, false);
  const unknown = messageWrite('a1', 'me@gmail.com', facts(newsletter({ results: [] })));
  assert.equal('listAuthenticated' in unknown, false);
  const asked: readonly string[] = METADATA_HEADERS;
  assert.ok(asked.includes('Authentication-Results'));
  assert.ok(asked.includes('DKIM-Signature'));
});
