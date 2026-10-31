// The host-side sanitiser for the stand-in `srcdoc` path (plan 30 section 4.4). The real frame gets its HTML from the
// engine's sanitiser; this one exists so the reader is complete before `eng-html` lands, and it never trusts the
// stand-in's own cleaning.
//
// Design: parse with htmlparser2 and RE-SERIALISE from an allowlist. Nothing from the input is copied through as
// markup: every element written is one of ALLOWED with attributes from attributes.ts, every text node is escaped, and
// every `<style>` body goes through css.ts (which removes `<`). The output is therefore a small closed language, so a
// difference between htmlparser2's parse and the browser's cannot smuggle markup through (the mutation-XSS class).
// The frame's sandbox (no scripts) and the inner CSP stay as independent fences behind it.

import { Parser } from 'htmlparser2';
import { type AttributeContext, cellWeight, escapeHtml, keptAttributes } from './attributes';
import { MAX_STYLE_BLOCK, sanitiseCss } from './css';
import { flattenToText } from './flatten';
import type { ImagePolicy } from './types';

/** Input above this many characters is cut before parsing (contract bodies may reach 5,000,000). */
export const MAX_BODY_CHARS = 2_000_000;
/** More table cells than this (each counted as colspan x rowspan) and the body is shown as text. */
export const MAX_TABLE_CELLS = 5_000;
/** Deeper element nesting than this and the body is shown as text. */
export const MAX_DEPTH = 200;

/** Sentences the host shows above the letter, outside the frame, where the email's CSS cannot hide or fake them. */
export const NOTICES = {
  flattened: 'This email’s layout was too large to show, so here is its text.',
  truncated: 'This email is too long to show in full.',
} as const;

/** What `sanitiseBody` returns. */
export interface SanitisedBody {
  /** The body markup: allowlisted elements and attributes only, escaped text, sanitised CSS. */
  html: string;
  /** NOTICES sentences for the host to show outside the frame (never part of `html`). */
  notices: string[];
  /** Attributes for the frame's `<body>` taken from the email's own `<body>` (bgcolor, style, …), already escaped. */
  bodyAttributes: string;
  /** Remote resources removed or blocked: every remote image, style import and `url()` the policy refused. */
  blocked: number;
  /** Tracking pixels among them ("N trackers removed"): remote images sized 0 or 1, or hidden. */
  trackers: number;
  /** Shown as text because of the table-cell or nesting cap. */
  flattened: boolean;
  /** Cut at MAX_BODY_CHARS. */
  truncated: boolean;
}

const ALLOWED = new Set(
  (
    'a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details ' +
    'dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd li main mark ' +
    'ol p pre q s samp section small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ' +
    'ul var wbr'
  ).split(' '),
);
const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr']);
/** Elements removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set(
  (
    'script title template iframe frame frameset noframes noembed noscript object embed applet svg math textarea ' +
    'select option optgroup datalist button audio video canvas map portal'
  ).split(' '),
);
interface Frame {
  name: string;
  emitted: boolean;
}

class Writer {
  readonly out: string[] = [];
  readonly stack: Frame[] = [];
  bodyAttributes = '';
  dropDepth = 0;
  depth = 0;
  maxDepth = 0;
  cells = 0;
  style: string[] | null = null;
  /** Over a cap: parsing stops and the body is flattened instead. */
  overflow = false;

  constructor(readonly cx: AttributeContext) {}

  open(name: string, attribs: Record<string, string>): void {
    this.depth++;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    if (name === 'td' || name === 'th') this.cells += cellWeight(attribs);
    if (this.cells > MAX_TABLE_CELLS || this.maxDepth > MAX_DEPTH) this.overflow = true;
    if (this.dropDepth > 0 || DROP_WITH_CONTENT.has(name)) {
      this.dropDepth++;
      this.stack.push({ name, emitted: false });
      return;
    }
    this.stack.push({ name, emitted: this.emitOpen(name, attribs) });
  }

  private emitOpen(name: string, attribs: Record<string, string>): boolean {
    if (name === 'style') {
      this.style = [];
      return false;
    }
    if (name === 'body' && !this.bodyAttributes) {
      this.bodyAttributes = keptAttributes(name, attribs, this.cx);
    }
    if (!ALLOWED.has(name)) return false;
    this.out.push(`<${name}${keptAttributes(name, attribs, this.cx)}>`);
    return !VOID.has(name);
  }

  close(): void {
    this.depth = Math.max(0, this.depth - 1);
    const frame = this.stack.pop();
    if (!frame) return;
    if (this.dropDepth > 0) {
      this.dropDepth--;
      return;
    }
    if (frame.name === 'style') this.flushStyle();
    if (frame.emitted) this.out.push(`</${frame.name}>`);
  }

  private flushStyle(): void {
    const raw = (this.style ?? []).join('').slice(0, MAX_STYLE_BLOCK);
    const css = sanitiseCss(raw, this.cx.policy, this.cx);
    this.style = null;
    if (css.trim()) this.out.push(`<style>${css}</style>`);
  }

  text(value: string): void {
    if (this.dropDepth > 0) return;
    if (this.style) {
      this.style.push(value);
      return;
    }
    this.out.push(escapeHtml(value));
  }
}

function parse(html: string, cx: AttributeContext): Writer {
  const writer = new Writer(cx);
  const parser = new Parser(
    {
      onopentag: (name, attribs) => {
        writer.open(name, attribs);
        // htmlparser2 costs O(depth) per tag: stop as soon as the body is known to be flattened.
        if (writer.overflow) parser.pause();
      },
      onclosetag: () => writer.close(),
      ontext: value => writer.text(value),
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  if (!writer.overflow) parser.end();
  return writer;
}

function flatText(html: string): string {
  return `<div class="aplos-flat">${escapeHtml(flattenToText(html))}</div>`;
}

/**
 * Sanitise an HTML body for the scriptless `srcdoc` frame under the image policy. Pure: the same input gives the same
 * output, and nothing is fetched or executed.
 */
export function sanitiseBody(html: string, policy: ImagePolicy): SanitisedBody {
  const truncated = html.length > MAX_BODY_CHARS;
  const cx: AttributeContext = { policy, blocked: 0, trackers: 0 };
  const input = truncated ? html.slice(0, MAX_BODY_CHARS) : html;
  const writer = parse(input, cx);
  const flattened = writer.overflow;
  const notices = [
    ...(flattened ? [NOTICES.flattened] : []),
    ...(truncated ? [NOTICES.truncated] : []),
  ];
  return {
    html: flattened ? flatText(input) : writer.out.join(''),
    notices,
    bodyAttributes: flattened ? '' : writer.bodyAttributes,
    blocked: cx.blocked,
    trackers: cx.trackers,
    flattened,
    truncated,
  };
}
