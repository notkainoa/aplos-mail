import { tokenize, TokenType, type CSSToken } from '@csstools/css-tokenizer';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

// The spec-parser oracle: reads the sanitizer's output with parse5, which builds the tree the HTML
// standard (and so Chromium) builds, and lists everything in that tree that could run code, reach
// the network, navigate, or clobber the frame script's globals. It shares no code with the
// sanitizer, so a mistake in the sanitizer's own reading of HTML or CSS cannot hide here.

type Node = DefaultTreeAdapterMap['childNode'] | DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const ALLOWED_ELEMENTS = new Set(
  (
    'html head body style a abbr acronym address article aside b bdi bdo big blockquote br caption center cite code col ' +
    'colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li ' +
    'main mark nav ol p pre q rp rt ruby s samp section small span strike strong sub summary sup table tbody td tfoot th ' +
    'thead time tr tt u ul var wbr'
  ).split(' '),
);
/** Attributes with no URL, script or id meaning; everything else is checked by name below. */
const INERT_ATTRIBUTES = new Set(
  (
    'align alink abbr alt bgcolor border cellpadding cellspacing class clear color colspan datetime dir face frame height ' +
    'hidden hspace lang link noshade nowrap open reversed role rows rowspan rules scope size span start summary text title ' +
    'type valign value vlink vspace width'
  ).split(' '),
);
const ID_ATTRIBUTES = new Set(['id', 'name', 'headers']);
const KEPT_AT_RULES = new Set([
  'media',
  'supports',
  'keyframes',
  '-webkit-keyframes',
  'layer',
  'container',
]);
const IMAGE_ROUTE = /^(?:cid|img)\/\d+$/;
const RASTER_DATA = /^data:image\/(?:png|jpe?g|gif|webp)[;,]/i;
const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:|#)/i;
const URL_LIKE = /^[\t\n\r ]*(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;

export interface OracleOptions {
  /** With images blocked no `img/<n>` may appear at all. */
  imagesBlocked: boolean;
  /** How many remote images the result lists (`img/<n>` must be below it). */
  remoteImages?: number;
  /** How many inline parts the message has (`cid/<n>` must be below it). */
  cids?: number;
}

/** Everything unsafe in `document`, as readable strings; empty when the document is safe. */
export function unsafeParts(document: string, options: OracleOptions): string[] {
  const problems: string[] = [];
  const stack: Node[] = [parse(document)];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if ('tagName' in node) checkElement(node, options, problems);
    if ('childNodes' in node) stack.push(...node.childNodes);
    if ('content' in node) stack.push(node.content as Node);
  }
  return problems;
}

function checkElement(element: Element, options: OracleOptions, problems: string[]): void {
  const name = element.tagName;
  if (element.namespaceURI !== HTML_NS) problems.push(`foreign element <${name}>`);
  if (!ALLOWED_ELEMENTS.has(name)) problems.push(`element <${name}>`);
  if (name === 'style') checkCss(textOf(element), options, problems);
  for (const { name: attribute, value, namespace } of element.attrs) {
    if (namespace) problems.push(`namespaced attribute ${attribute} on <${name}>`);
    checkAttribute(name, attribute, value, options, problems);
  }
  const target = element.attrs.find(attribute => attribute.name === 'target');
  const rel = element.attrs.find(attribute => attribute.name === 'rel');
  if (target && rel?.value !== 'noopener noreferrer')
    problems.push(`target without rel on <${name}>`);
}

function checkAttribute(
  element: string,
  name: string,
  value: string,
  options: OracleOptions,
  problems: string[],
): void {
  if (INERT_ATTRIBUTES.has(name) || name.startsWith('aria-'))
    return checkIdReference(name, value, problems);
  if (ID_ATTRIBUTES.has(name)) return checkIdReference(name, value, problems);
  if (name === 'href' && element === 'a') return checkHref(value, problems);
  if (name === 'src' && element === 'img') return checkImage(value, true, options, problems);
  if (name === 'background') return checkImage(value, false, options, problems);
  if (name === 'style') return checkCss(value, options, problems);
  if (name === 'target' && value === '_blank') return;
  if (name === 'rel' && value === 'noopener noreferrer') return;
  problems.push(`attribute ${name}="${value.slice(0, 60)}" on <${element}>`);
}

/** Ids, anchor names and id references live in the mail's `m-` namespace (no JavaScript identifier). */
function checkIdReference(name: string, value: string, problems: string[]): void {
  if (name === 'id' || name === 'name') {
    if (!value.startsWith('m-'))
      problems.push(`${name} "${value.slice(0, 40)}" outside the m- namespace`);
    return;
  }
  const list =
    name === 'headers' ||
    /^aria-(?:labelledby|describedby|controls|owns|flowto|details|errormessage|activedescendant)$/.test(
      name,
    );
  if (!list) return;
  for (const id of value.split(/[\t\n\f\r ]+/).filter(Boolean)) {
    if (!id.startsWith('m-'))
      problems.push(`${name} "${id.slice(0, 40)}" outside the m- namespace`);
  }
}

/**
 * Every attribute value that is not inert text, an id or a link target (in practice `src` and
 * `background`): none may name a host. CSS is checked token by token in `unsafeParts` instead, because CSS text can
 * legitimately hold an address that is no URL (`u/**\/rl(http://…)` is an unknown function).
 */
export function loadableValues(document: string): string[] {
  const values: string[] = [];
  const stack: Node[] = [parse(document)];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if ('tagName' in node) {
      for (const { name, value } of node.attrs) {
        const inert =
          INERT_ATTRIBUTES.has(name) || ID_ATTRIBUTES.has(name) || name.startsWith('aria-');
        if (!inert && name !== 'style' && !(name === 'href' && node.tagName === 'a'))
          values.push(value);
      }
    }
    if ('childNodes' in node) stack.push(...node.childNodes);
  }
  return values;
}

function checkHref(value: string, problems: string[]): void {
  if (!SAFE_HREF.test(value)) problems.push(`href ${value.slice(0, 80)}`);
  if (value.startsWith('#') && value.length > 1 && !value.startsWith('#m-'))
    problems.push(`fragment ${value} outside m-`);
}

function checkImage(
  value: string,
  dataAllowed: boolean,
  options: OracleOptions,
  problems: string[],
): void {
  if (dataAllowed && RASTER_DATA.test(value)) return;
  if (!IMAGE_ROUTE.test(value)) return void problems.push(`image ${value.slice(0, 80)}`);
  const index = Number(value.slice(4));
  if (value.startsWith('img/') && options.imagesBlocked)
    problems.push(`img route while blocked: ${value}`);
  if (
    value.startsWith('img/') &&
    options.remoteImages !== undefined &&
    index >= options.remoteImages
  ) {
    problems.push(`img route ${value} past the list`);
  }
  if (value.startsWith('cid/') && options.cids !== undefined && index >= options.cids)
    problems.push(`${value} past the cids`);
}

function textOf(element: Element): string {
  return element.childNodes.map(child => ('value' in child ? child.value : '')).join('');
}

function checkCss(css: string, options: OracleOptions, problems: string[]): void {
  const tokens = tokenize({ css }, { onParseError: () => undefined });
  const imageSets: number[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    depth = trackDepth(token, depth, imageSets);
    checkCssToken(token, tokens, index, imageSets.length > 0, options, problems);
  }
}

function trackDepth(token: CSSToken, depth: number, imageSets: number[]): number {
  if (token[0] === TokenType.Function) {
    if (/^(?:-webkit-)?image(?:-set)?$/i.test(token[4].value)) imageSets.push(depth + 1);
    return depth + 1;
  }
  if (token[0] === TokenType.OpenParen) return depth + 1;
  if (token[0] !== TokenType.CloseParen) return depth;
  if (imageSets[imageSets.length - 1] === depth) imageSets.pop();
  return depth - 1;
}

function nextSignificant(tokens: CSSToken[], index: number): CSSToken | undefined {
  let at = index + 1;
  while (tokens[at]?.[0] === TokenType.Whitespace) at++;
  return tokens[at];
}

function checkCssToken(
  token: CSSToken,
  tokens: CSSToken[],
  index: number,
  inImageSet: boolean,
  options: OracleOptions,
  problems: string[],
): void {
  if (token[0] === TokenType.URL) checkImage(token[4].value, false, options, problems);
  if (token[0] === TokenType.BadURL) problems.push('css bad url');
  if (token[0] === TokenType.AtKeyword && !KEPT_AT_RULES.has(token[4].value.toLowerCase())) {
    problems.push(`at-rule @${token[4].value}`);
  }
  if (token[0] === TokenType.Function && /^(?:attr|expression)$/i.test(token[4].value))
    problems.push(`css ${token[4].value}()`);
  const urlFunction = token[0] === TokenType.Function && /^(?:url|src)$/i.test(token[4].value);
  const next = nextSignificant(tokens, index);
  if (urlFunction && next?.[0] === TokenType.String)
    checkImage(next[4].value, false, options, problems);
  if (urlFunction && next?.[0] !== TokenType.String)
    problems.push(`css ${token[4].value}() without a string`);
  if (token[0] !== TokenType.String) return;
  if (inImageSet) checkImage(token[4].value, false, options, problems);
  else if (URL_LIKE.test(token[4].value.replace(/[\t\n\r]/g, '')))
    problems.push(`css string ${token[4].value.slice(0, 60)}`);
}
