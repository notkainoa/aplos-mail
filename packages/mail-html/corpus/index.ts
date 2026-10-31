import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatedEntries } from './generated';

// The hostile email corpus (plans/engine/phase1-lanes.md, html-2). Every entry is original content; every
// network-reaching vector inside a message points at the canary, so a leak is attributable to a message and a vector.

/** The attack classes. A class is "covered" when at least one entry lists it. */
export const ATTACK_CLASSES = [
  'script-inline',
  'event-handler',
  'javascript-url',
  'link-scheme',
  'data-url',
  'meta-refresh',
  'link-prefetch',
  'css-url',
  'css-import',
  'css-font-face',
  'css-image-set',
  'css-legacy',
  'css-exfil',
  'css-layout-abuse',
  'base-tag',
  'svg-script',
  'svg-foreignobject',
  'svg-other',
  'form-autosubmit',
  'iframe-nested',
  'object-embed',
  'mxss',
  'dom-clobbering',
  'deep-nesting',
  'huge-line',
  'malformed-encoding',
  'resource-exhaustion',
  'tracking-pixel',
  'hidden-content',
  'open-redirect-image',
  'ssrf-image',
  'remote-image',
  'remote-font',
  'relative-url',
  'audio-video',
  'ping-attr',
  'meta-misc',
  'storage-cookie',
  'popup-navigation',
  'postmessage-spoof',
  'quoted-history',
  'find-text',
  'plain-text',
  'cid-inline',
  'benign-newsletter',
  'unicode-bidi',
] as const;

export type AttackClass = (typeof ATTACK_CLASSES)[number];

export interface CorpusExpect {
  /** The sanitizer must report at least this many removed trackers. */
  trackersRemovedMin?: number;
  /** Exactly this many remote images remain (`MailHtmlResult.remoteImages.length`). */
  remoteImages?: number;
  quotedCountMin?: number;
  /** At least this many find marks for `findQuery`. */
  marksMin?: number;
  bodyKind?: 'html' | 'text';
  /** Visible text that must survive sanitizing, so a sanitizer that deletes everything fails. */
  mustKeepText?: string[];
  notes?: string;
}

/** What `generated.ts` promises about a synthetic entry, checked by the corpus test. */
export interface GeneratedPromise {
  minChars?: number;
  /** The html has no line break at all (a "single line" entry). */
  singleLine?: boolean;
  /** Each needle occurs at least `count` times. */
  occurrences?: { needle: string; count: number }[];
}

export interface CorpusEntry {
  id: string;
  title: string;
  classes: AttackClass[];
  /** The HTML body (placeholders already substituted). Absent for a text-only message. */
  html?: string;
  /** The text alternative (or the whole body of a text-only message). */
  text?: string;
  /** Inline parts' Content-IDs, in `MailHtmlInput.cids` order. */
  cids: string[];
  findQuery?: string;
  expect: CorpusExpect;
  /** The unique DNS-canary hostname for this entry (`{{CANARY_HOST}}`). */
  canaryHost: string;
  generated: boolean;
  promise?: GeneratedPromise;
}

/** One manifest.json record: the html and text fields are paths relative to the corpus directory. */
export interface ManifestEntry {
  id: string;
  title: string;
  classes: string[];
  html?: string;
  text?: string;
  cids?: string[];
  findQuery?: string;
  expect: CorpusExpect;
}

export const corpusDir = import.meta.dirname;
export const DEFAULT_DNS_SUFFIX = 'canary-dns.example';

export interface LoadOptions {
  /** The canary HTTP origin, such as `http://127.0.0.1:54321`. */
  canaryOrigin: string;
  /** Domain under which every entry gets its own host, `m017.<suffix>`. */
  dnsSuffix?: string;
  /** False leaves out the synthetic entries (they are large). */
  includeGenerated?: boolean;
}

/** `m017` for `017-slug`, `g03` for `g03-slug`: the label that makes a DNS name unique per message. */
export function canaryTag(id: string): string {
  const generated = /^(g\d+)/.exec(id);
  if (generated) return generated[1];
  const numbered = /^(\d+)/.exec(id);
  if (numbered) return `m${numbered[1]}`;
  throw new Error(`corpus id "${id}" must start with digits or g<digits>`);
}

export function canaryHostFor(id: string, dnsSuffix: string = DEFAULT_DNS_SUFFIX): string {
  return `${canaryTag(id)}.${dnsSuffix}`;
}

/** Replaces `{{CANARY}}`, `{{CANARY_HOST}}`, `{{CANARY_PORT}}` and `{{ID}}`. */
export function substitute(
  text: string,
  vars: { origin: string; host: string; port: string; id: string },
): string {
  return text
    .replaceAll('{{CANARY_HOST}}', vars.host)
    .replaceAll('{{CANARY_PORT}}', vars.port)
    .replaceAll('{{CANARY}}', vars.origin)
    .replaceAll('{{ID}}', vars.id);
}

export function readManifest(): ManifestEntry[] {
  return JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf8')) as ManifestEntry[];
}

function readFileEntry(record: ManifestEntry, origin: string, suffix: string): CorpusEntry {
  const host = canaryHostFor(record.id, suffix);
  const vars = { origin, host, port: new URL(origin).port, id: record.id };
  const read = (path: string) => substitute(readFileSync(join(corpusDir, path), 'utf8'), vars);
  return {
    id: record.id,
    title: record.title,
    classes: record.classes as AttackClass[],
    html: record.html === undefined ? undefined : read(record.html),
    text: record.text === undefined ? undefined : read(record.text),
    cids: (record.cids ?? []).map(cid => substitute(cid, vars)),
    findQuery: record.findQuery,
    expect: record.expect,
    canaryHost: host,
    generated: false,
  };
}

/** The whole corpus: manifest messages (files), then the synthetic entries. */
export function loadCorpus(opts: LoadOptions): CorpusEntry[] {
  const suffix = opts.dnsSuffix ?? DEFAULT_DNS_SUFFIX;
  const entries = readManifest().map(record => readFileEntry(record, opts.canaryOrigin, suffix));
  if (opts.includeGenerated === false) return entries;
  return [...entries, ...generatedEntries({ canaryOrigin: opts.canaryOrigin, dnsSuffix: suffix })];
}
