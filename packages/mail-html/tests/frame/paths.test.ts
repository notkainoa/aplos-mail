import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { frameUrl, isToken, parseFramePath, parseFrameUrl, tokenOf } from '../../src/frame/paths';

// The frame URL grammar: exactly the three shapes, everything else refused.

const T = '0123456789abcdef0123456789abcdef';
const BASE = `aplos-mail://m/${T}/`;

describe('frame URL grammar', () => {
  it('accepts the document and the two sub-resource shapes', () => {
    assert.deepEqual(parseFrameUrl(BASE), { token: T, route: { kind: 'document' } });
    assert.deepEqual(parseFrameUrl(`${BASE}cid/0`), { token: T, route: { kind: 'cid', index: 0 } });
    assert.deepEqual(parseFrameUrl(`${BASE}img/7`), { token: T, route: { kind: 'img', index: 7 } });
    assert.deepEqual(parseFrameUrl(`${BASE}img/999999`), {
      token: T,
      route: { kind: 'img', index: 999999 },
    });
  });

  it('issues the document URL with the trailing slash relative routes need', () => {
    assert.equal(frameUrl(T), BASE);
    assert.equal(new URL('cid/3', frameUrl(T)).href, `${BASE}cid/3`);
  });

  const rejects: Record<string, string[]> = {
    'no trailing slash': [`aplos-mail://m/${T}`],
    'trailing junk': [`${BASE}x`, `${BASE}cid/1/`, `${BASE}cid/1x`, `${BASE}cid/1 `, `${BASE} `],
    'dot segments': [
      `${BASE}../${T}/cid/0`,
      `${BASE}cid/../img/0`,
      `${BASE}./cid/0`,
      `${BASE}cid/./0`,
      `aplos-mail://m/${T}/..`,
    ],
    'percent escapes': [
      `${BASE}%2e%2e/cid/0`,
      `${BASE}cid%2f0`,
      `${BASE}cid/%30`,
      `${BASE}%63id/0`,
      `aplos-mail://m/${T}%2fcid/0`,
    ],
    backslashes: [`${BASE}cid\\0`, `aplos-mail://m/${T}\\cid/0`, `${BASE}..\\cid/0`],
    'doubled slashes': [`aplos-mail://m/${T}//cid/0`, `${BASE}cid//0`, `aplos-mail://m//${T}/`],
    'odd tokens': [
      `aplos-mail://m/${T.toUpperCase()}/`,
      `aplos-mail://m/${T.slice(1)}/`,
      `aplos-mail://m/${T}0/`,
      `aplos-mail://m/${T.slice(0, 31)}g/`,
      'aplos-mail://m//',
    ],
    'odd indexes': [
      `${BASE}cid/01`,
      `${BASE}cid/00`,
      `${BASE}img/1000000`,
      `${BASE}img/99999999999999999999`,
      `${BASE}img/-1`,
      `${BASE}img/+1`,
      `${BASE}img/1e3`,
      `${BASE}img/0x1`,
      `${BASE}img/1.0`,
      `${BASE}img/`,
      `${BASE}img/١`,
    ],
    'other routes': [`${BASE}cid`, `${BASE}CID/0`, `${BASE}att/0`, `${BASE}index.html`],
    'query or fragment': [`${BASE}?x`, `${BASE}#x`, `${BASE}cid/0?x=1`, `${BASE}img/0#a`],
    'other origin': [
      `APLOS-MAIL://m/${T}/`,
      `aplos-mail://M/${T}/`,
      `aplos-mail://x/${T}/`,
      `aplos-mail:m/${T}/`,
      `https://m/${T}/`,
      ` ${BASE}`,
      `aplos-mail://user@m/${T}/`,
      `aplos-mail://m:80/${T}/`,
    ],
    'control and wide characters': [`${BASE}cid/0\n`, `${BASE}\u0000`, `${BASE}cid/０`],
  };

  for (const [name, urls] of Object.entries(rejects)) {
    it(`refuses ${name}`, () => {
      for (const url of urls) assert.equal(parseFrameUrl(url), undefined, JSON.stringify(url));
    });
  }

  it('refuses non-strings and huge strings without throwing', () => {
    for (const value of [undefined, null, 1, {}, [], BASE + 'x'.repeat(100_000)]) {
      assert.equal(parseFrameUrl(value), undefined);
      assert.equal(parseFramePath(value), undefined);
    }
  });

  it('parses Mail/serve paths with the same grammar', () => {
    assert.deepEqual(parseFramePath(''), { kind: 'document' });
    assert.deepEqual(parseFramePath('cid/12'), { kind: 'cid', index: 12 });
    for (const bad of ['/', '/cid/0', 'cid/0/', '../cid/0', 'cid/01', 'img/1000000', 'img/0?'])
      assert.equal(parseFramePath(bad), undefined, bad);
  });

  it('names a token by bare token or document URL only', () => {
    assert.equal(isToken(T), true);
    assert.equal(tokenOf(T), T);
    assert.equal(tokenOf(BASE), T);
    assert.equal(tokenOf(`${BASE}cid/0`), undefined);
    assert.equal(tokenOf(T.toUpperCase()), undefined);
    assert.equal(tokenOf(42), undefined);
  });

  it('lets tokenOf alone take the document URL without its slash (the contract form)', () => {
    const bare = `aplos-mail://m/${T}`;
    assert.equal(tokenOf(bare), T);
    assert.equal(parseFrameUrl(bare), undefined, 'the serving grammar stays strict');
    for (const bad of [
      `${bare}x`,
      `${bare}?x`,
      `${bare}#x`,
      `${bare}%2f`,
      `${bare}\\`,
      `aplos-mail://m/${T.toUpperCase()}`,
      `aplos-mail://m/${T.slice(1)}`,
      `aplos-mail://m/${T}//`,
      `aplos-mail://m/${T}/cid/0`,
      `aplos-mail://m/${T}/..`,
      ` ${bare}`,
      `APLOS-MAIL://m/${T}`,
    ]) {
      assert.equal(tokenOf(bad), undefined, bad);
    }
  });
});
