import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import {
  ATTACK_CLASSES,
  corpusDir,
  loadCorpus,
  readManifest,
  type CorpusEntry,
  type ManifestEntry,
} from '../../../../packages/mail-html/corpus/index';

// A fast guard on the hostile corpus itself: size, coverage, and the rule that every network-reaching vector points
// at the canary so a leak is attributable.

/** The attack classes plans/engine/phase1-lanes.md section 8 and plan 10 E4 name, plus the classes the lane brief adds. */
const REQUIRED_CLASSES = [
  'script-inline',
  'event-handler',
  'javascript-url',
  'data-url',
  'meta-refresh',
  'link-prefetch',
  'css-url',
  'css-import',
  'css-font-face',
  'css-image-set',
  'base-tag',
  'svg-script',
  'svg-foreignobject',
  'svg-other',
  'form-autosubmit',
  'iframe-nested',
  'object-embed',
  'mxss',
  'deep-nesting',
  'huge-line',
  'malformed-encoding',
  'tracking-pixel',
  'hidden-content',
  'open-redirect-image',
  'remote-image',
  'remote-font',
  'audio-video',
  'ping-attr',
  'meta-misc',
  'storage-cookie',
  'popup-navigation',
  'quoted-history',
  'find-text',
  'plain-text',
  'cid-inline',
  'benign-newsletter',
  'unicode-bidi',
];

const ORIGIN = 'http://127.0.0.1:41999';
/** XML namespace identifiers are names, never fetched. */
const NAMESPACE_HOSTS = ['www.w3.org/'];
const TEXT_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  colon: ':',
  sol: '/',
  Tab: '\t',
  NewLine: '\n',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&([A-Za-z]+);/g, (whole, name: string) => TEXT_ENTITIES[name] ?? whole);
}

function safeChar(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function decodePercent(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, run => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** A copy for scanning: entities and percent escapes decoded, tabs and newlines removed from inside schemes. */
function normalizeForScan(text: string): string {
  const decoded = decodePercent(decodeEntities(text));
  return [...decoded].filter(ch => ch.charCodeAt(0) > 10 && ch !== '\r').join('');
}

const SCHEME = /\b(?:https?|wss?|ftp)\s*:[\\/\s]*/gi;
const AUTHORITY_END = /[/?#"'<>()\s\\]/;

/** Violations of the vector rule in one message body (placeholders still in place). */
export function networkViolations(raw: string): string[] {
  const found: string[] = [];
  const text = normalizeForScan(raw);
  for (const match of text.matchAll(SCHEME)) {
    const after = text.slice(match.index + match[0].length);
    if (authorityIsAttributable(after) || isExampleNavigation(text, match.index, after)) continue;
    found.push(`${match[0]}${after.slice(0, 60)}`);
  }
  for (const match of text.matchAll(/(?<=^|[\s"'(=,])\/\/(?=[\w{[])/g)) {
    const after = text.slice(match.index + 2);
    if (!after.startsWith('{{CANARY_HOST}}') && !after.startsWith('m/0123456789abcdef'))
      found.push(`//${after.slice(0, 60)}`);
  }
  for (const match of text.matchAll(/\{\{CANARY\}\}(?!\/(?:\{\{ID\}\}\/|redirect\?))/g)) {
    found.push(`{{CANARY}} without id: ${text.slice(match.index, match.index + 60)}`);
  }
  return found;
}

/**
 * A plain `*.example` address is fine where nothing fetches it: running text, a style selector, or the href of an
 * `<a>` or `<area>` (clicked, never loaded). The net log check flags any lookup of a `.example` name anyway.
 */
function isExampleNavigation(text: string, index: number, after: string): boolean {
  if (!/^[\w.-]+\.example(?:[/?#:"'<>\s]|$)/.test(after)) return false;
  const open = text.lastIndexOf('<', index);
  if (text.lastIndexOf('>', index) > open) return true;
  const tag = /^<([a-z0-9]+)/i.exec(text.slice(open))?.[1]?.toLowerCase();
  return (
    (tag === 'a' || tag === 'area') &&
    /href\s*=\s*["']?$/i.test(text.slice(Math.max(open, index - 24), index))
  );
}

function authorityIsAttributable(after: string): boolean {
  if (NAMESPACE_HOSTS.some(host => after.startsWith(host))) return true;
  const end = after.search(AUTHORITY_END);
  const authority = end === -1 ? after : after.slice(0, end);
  const hostPart = authority.slice(authority.lastIndexOf('@') + 1);
  if (authority.includes('{{CANARY_HOST}}')) return true;
  const rest = end === -1 ? '' : after.slice(end);
  return /^[\w.[\]:%-]+:\{\{CANARY_PORT\}\}$/.test(hostPart) && rest.startsWith('/{{ID}}/');
}

const EMAIL = /[\w.+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/g;
const REAL_TLD =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|edu|gov|info|biz|me|app|dev|us|uk|de|fr|ru|cn|tv|ai|xyz|test|local|invalid)\b/gi;

/** Domains and addresses that are not on a reserved example domain. */
export function realLookingNames(raw: string): string[] {
  const text = decodeEntities(raw);
  const found: string[] = [];
  for (const match of text.matchAll(EMAIL)) {
    if (!/\.example$/.test(match[1]) && !text.slice(match.index).includes('@{{CANARY_HOST}}'))
      found.push(match[0]);
  }
  for (const match of text.matchAll(REAL_TLD)) {
    if (!NAMESPACE_HOSTS.some(host => match[0] + '/' === host || match[0] === host.slice(0, -1)))
      found.push(match[0]);
  }
  return found;
}

function messageFiles(): string[] {
  return readdirSync(join(corpusDir, 'messages')).sort();
}

describe('corpus manifest', () => {
  const manifest = readManifest();

  it('has at least 60 messages with unique ids that match their files', () => {
    assert.ok(manifest.length >= 60, `only ${manifest.length} messages`);
    const ids = new Set(manifest.map(m => m.id));
    assert.equal(ids.size, manifest.length, 'duplicate ids');
    for (const entry of manifest) assert.match(entry.id, /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const files = new Set(messageFiles());
    for (const entry of manifest) {
      for (const path of [entry.html, entry.text].filter((p): p is string => p !== undefined)) {
        assert.ok(existsSync(join(corpusDir, path)), `${path} is missing`);
        assert.equal(
          path.split('/').pop()?.slice(0, entry.id.length),
          entry.id,
          `${path} does not match ${entry.id}`,
        );
        files.delete(path.split('/').pop() ?? '');
      }
      assert.ok(entry.html ?? entry.text, `${entry.id} has no body`);
    }
    assert.deepEqual([...files], [], 'message files that no manifest entry uses');
  });

  it('numbers messages without gaps from 001', () => {
    manifest.forEach((entry, index) =>
      assert.equal(entry.id.slice(0, 3), String(index + 1).padStart(3, '0')),
    );
  });

  it('uses only known classes and gives each message a title, a class and a keep-text', () => {
    for (const entry of manifest) {
      assert.ok(entry.title.length > 10, `${entry.id} needs a plain English title`);
      assert.ok(entry.classes.length > 0, `${entry.id} has no class`);
      for (const name of entry.classes)
        assert.ok(
          (ATTACK_CLASSES as readonly string[]).includes(name),
          `${entry.id}: unknown class ${name}`,
        );
      assert.ok((entry.expect.mustKeepText ?? []).length > 0, `${entry.id} needs mustKeepText`);
    }
  });

  it('keeps every mustKeepText string in the message source', () => {
    for (const entry of manifest) {
      const source = [entry.html, entry.text]
        .filter((p): p is string => p !== undefined)
        .map(path => decodeEntities(readFileSync(join(corpusDir, path), 'utf8')))
        .join('\n');
      for (const needle of entry.expect.mustKeepText ?? [])
        assert.ok(source.includes(needle), `${entry.id}: "${needle}" is not in the source`);
    }
  });

  it('holds the two owner demo messages', () => {
    const track = manifest.find(m => m.title === 'A message that tries to track you');
    const run = manifest.find(m => m.title === 'A message that tries to run code');
    assert.ok(track && run, 'owner demo titles');
    assert.equal(track.expect.trackersRemovedMin, 3);
    const html = readFileSync(join(corpusDir, track.html ?? ''), 'utf8');
    const pixels = html.match(/<img [^>]*(?:width="[01]"|width:1px)[^>]*>/g) ?? [];
    assert.equal(pixels.length, 3, 'exactly three tracking pixels');
    for (const klass of [
      'script-inline',
      'event-handler',
      'javascript-url',
      'form-autosubmit',
      'svg-script',
      'iframe-nested',
    ])
      assert.ok(run.classes.includes(klass as never), `run-code demo needs ${klass}`);
  });

  it('keeps each message file a reasonable size', () => {
    for (const file of messageFiles())
      assert.ok(statSync(join(corpusDir, 'messages', file)).size < 100_000, `${file} is too large`);
  });
});

describe('every network vector is attributable', () => {
  const manifest = readManifest();

  it('points every http, https, ws, wss, ftp and protocol-relative address at a placeholder', () => {
    for (const entry of manifest) {
      for (const path of [entry.html, entry.text].filter((p): p is string => p !== undefined)) {
        const violations = networkViolations(readFileSync(join(corpusDir, path), 'utf8'));
        assert.deepEqual(violations, [], `${path} has vectors that are not attributable`);
      }
    }
  });

  it('uses only example domains and example addresses', () => {
    for (const file of messageFiles()) {
      const names = realLookingNames(readFileSync(join(corpusDir, 'messages', file), 'utf8'));
      assert.deepEqual(names, [], `${file} names a real-looking domain or address`);
    }
  });

  it('flags a bad vector (the scanner itself works)', () => {
    assert.notEqual(networkViolations('<img src="http://tracker.example/x.gif">').length, 0);
    assert.notEqual(networkViolations('<img src="//tracker.example/x.gif">').length, 0);
    assert.notEqual(networkViolations('<img src="ht&#x74;p://tracker.example/x.gif">').length, 0);
    assert.notEqual(networkViolations('<a href="http:\\\\tracker.example\\x">').length, 0);
    assert.notEqual(networkViolations('<img src="{{CANARY}}/x.gif">').length, 0);
    assert.deepEqual(
      networkViolations('<img src="{{CANARY}}/{{ID}}/x.gif"><img src="http://{{CANARY_HOST}}/y">'),
      [],
    );
    assert.notEqual(realLookingNames('write to someone@mailbox.com').length, 0);
  });
});

describe('loaded corpus', () => {
  let corpus: CorpusEntry[] = [];

  before(() => {
    corpus = loadCorpus({ canaryOrigin: ORIGIN });
  });

  it('covers every attack class at least once', () => {
    const covered = new Set(corpus.flatMap(entry => entry.classes));
    const missing = ATTACK_CLASSES.filter(name => !covered.has(name));
    assert.deepEqual(missing, [], 'classes with no entry');
  });

  it('only labels a handwritten message with a class its source shows', () => {
    const evidence: Record<string, RegExp> = {
      'css-import': /@import/i,
      'css-url': /url\(/i,
      'ping-attr': /\bping\s*=/i,
      'iframe-nested': /<(?:iframe|frame)\b/i,
      'form-autosubmit': /<form\b/i,
      'svg-script': /<script|\bon\w+\s*=/i,
    };
    const mislabelled = readManifest().flatMap(entry => {
      if (!entry.html) return [];
      const source = readFileSync(join(corpusDir, entry.html), 'utf8');
      return entry.classes
        .filter(name => evidence[name] && !evidence[name].test(source))
        .map(name => `${entry.id}: ${name}`);
    });
    assert.deepEqual(mislabelled, [], 'a class label the message source does not support');
  });

  it('covers every class the plan lists', () => {
    const known = new Set<string>(ATTACK_CLASSES);
    for (const name of REQUIRED_CLASSES)
      assert.ok(known.has(name), `${name} is missing from ATTACK_CLASSES`);
    const covered = new Set(corpus.flatMap(entry => entry.classes as string[]));
    for (const name of REQUIRED_CLASSES) assert.ok(covered.has(name), `${name} has no entry`);
  });

  it('covers the plan classes with more than one message in the handwritten set', () => {
    const counts = new Map<string, number>();
    for (const entry of corpus.filter(e => !e.generated))
      for (const name of entry.classes) counts.set(name, (counts.get(name) ?? 0) + 1);
    const thin = REQUIRED_CLASSES.filter(
      name => (counts.get(name) ?? 0) < 2 && !['huge-line', 'deep-nesting'].includes(name),
    );
    assert.deepEqual(thin, [], 'classes with a single handwritten message');
  });

  it('leaves no placeholder behind and gives each entry its own DNS host', () => {
    const hosts = new Set<string>();
    for (const entry of corpus) {
      for (const body of [entry.html, entry.text, ...entry.cids]) {
        if (body !== undefined)
          assert.equal(/\{\{[A-Z_]+\}\}/.test(body), false, `${entry.id} still has a placeholder`);
      }
      assert.match(entry.canaryHost, /^(?:m\d{3}|g\d{2})\.canary-dns\.example$/);
      assert.equal(hosts.has(entry.canaryHost), false, `${entry.id} shares a DNS host`);
      hosts.add(entry.canaryHost);
    }
  });

  it('substitutes the origin, the unique host, the port and the id', () => {
    const entry = corpus.find(e => e.id.startsWith('073-'));
    assert.ok(
      entry?.html?.includes('http://2130706433:41999/073-ssrf-image-address-forms/decimal'),
    );
    const other = loadCorpus({
      canaryOrigin: 'http://127.0.0.1:50000',
      dnsSuffix: 'dns.test-suffix.example',
      includeGenerated: false,
    });
    assert.ok(other[0].html?.includes('http://127.0.0.1:50000/001-tracking-three-pixels/'));
    assert.equal(other[0].canaryHost, 'm001.dns.test-suffix.example');
  });

  it('has the promised synthetic entries and sizes', () => {
    const generated = corpus.filter(e => e.generated);
    assert.ok(generated.length >= 25, `only ${generated.length} generated entries`);
    assert.equal(
      new Set(corpus.map(e => e.id)).size,
      corpus.length,
      'ids are unique across the corpus',
    );
    const byId = new Map(generated.map(e => [e.id, e]));
    const mustHave = [
      'g01-nesting-div-unclosed-100k',
      'g03-nesting-table-100k',
      'g04-nesting-font-100k',
      'g12-line-prose-5mb',
      'g22-attribute-values-huge',
      'g20-attributes-10k-distinct',
      'g28-encoding-lone-surrogates',
      'g31-encoding-overlong-entities',
      'g32-encoding-mixed-line-endings',
    ];
    for (const id of mustHave) assert.ok(byId.has(id), `${id} is missing`);
    for (const entry of generated) checkPromise(entry);
  });

  it('keeps every vector in the synthetic entries pointed at the canary', () => {
    for (const entry of corpus.filter(e => e.generated)) {
      const body = (entry.html ?? entry.text ?? '')
        .split(ORIGIN)
        .join('')
        .split(`http://${entry.canaryHost}`)
        .join('');
      const bad = [...body.matchAll(/\b(?:https?|wss?|ftp):\/\/(?!www\.w3\.org\/)/gi)];
      assert.equal(bad.length, 0, `${entry.id} names a host outside the canary`);
    }
  });

  it('keeps text-only messages free of html and html messages parseable as strings', () => {
    for (const entry of corpus)
      assert.ok(entry.html !== undefined || entry.text !== undefined, entry.id);
    const textOnly = corpus.filter(e => e.html === undefined && !e.generated);
    assert.ok(textOnly.length >= 3, 'at least three text-only messages');
    for (const entry of textOnly) assert.equal(entry.expect.bodyKind, 'text');
  });
});

function checkPromise(entry: CorpusEntry): void {
  const body = entry.html ?? entry.text ?? '';
  const promise = entry.promise;
  assert.ok(promise, `${entry.id} promises nothing`);
  if (promise.minChars !== undefined)
    assert.ok(body.length >= promise.minChars, `${entry.id}: ${body.length} < ${promise.minChars}`);
  if (promise.singleLine)
    assert.equal(/[\r\n\u2028\u2029]/.test(body), false, `${entry.id} is not a single line`);
  for (const { needle, count } of promise.occurrences ?? []) {
    const seen = body.split(needle).length - 1;
    assert.ok(
      seen >= count,
      `${entry.id}: ${seen} of ${JSON.stringify(needle.slice(0, 20))}, wanted ${count}`,
    );
  }
}

export type { ManifestEntry };
