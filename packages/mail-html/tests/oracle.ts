import { tokenize, TokenType, type CSSToken } from '@csstools/css-tokenizer';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

// The spec-parser oracle: reads the sanitizer's output with parse5, which builds the same tree as
// Chromium, and lists everything in that tree that could run code or reach the network.
// It shares no code with the sanitizer.

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
const KEPT_AT_RULES = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', 'layer', 'container']);
const SAFE_IMAGE = /^(?:cid\/\d+|img\/\d+|data:image\/(?:png|jpe?g|gif|webp)[;,])/i;
const SAFE_HREF = /^(?:https?:\/\/|mailto:|#)/i;

export interface OracleOptions {
  /** With images blocked no `img/<n>` may appear at all. */
  imagesBlocked: boolean;
}

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
  for (const { name: attribute, value } of element.attrs) {
    checkAttribute(name, attribute, value, options, problems);
  }
}

function checkAttribute(element: string, name: string, value: string, options: OracleOptions, problems: string[]): void {
  if (/^on/i.test(name)) problems.push(`handler ${name} on <${element}>`);
  if (name === 'href' && !SAFE_HREF.test(value)) problems.push(`href ${value}`);
  if ((name === 'src' || name === 'background') && !SAFE_IMAGE.test(value)) problems.push(`${name} ${value}`);
  if (['srcset', 'action', 'formaction', 'data', 'poster', 'ping', 'xlink:href', 'srcdoc'].includes(name)) {
    problems.push(`attribute ${name} on <${element}>`);
  }
  if (name === 'target' && value !== '_blank') problems.push(`target ${value}`);
  if (name === 'style') checkCss(value, options, problems);
  if (options.imagesBlocked && /^img\/\d+/.test(value)) problems.push(`img route while blocked: ${value}`);
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
    checkCssToken(token, tokens[index + 1], imageSets.length > 0, options, problems);
  }
}

function trackDepth(token: CSSToken, depth: number, imageSets: number[]): number {
  if (token[0] === TokenType.Function) {
    if (/image-set$/i.test(token[4].value)) imageSets.push(depth + 1);
    return depth + 1;
  }
  if (token[0] === TokenType.OpenParen) return depth + 1;
  if (token[0] !== TokenType.CloseParen) return depth;
  if (imageSets[imageSets.length - 1] === depth) imageSets.pop();
  return depth - 1;
}

function checkCssToken(
  token: CSSToken,
  next: CSSToken | undefined,
  inImageSet: boolean,
  options: OracleOptions,
  problems: string[],
): void {
  if (token[0] === TokenType.URL) checkCssUrl(token[4].value, options, problems);
  if (token[0] === TokenType.AtKeyword && !KEPT_AT_RULES.has(token[4].value.toLowerCase())) {
    problems.push(`at-rule @${token[4].value}`);
  }
  const urlFunction = token[0] === TokenType.Function && /^(?:url|src)$/i.test(token[4].value);
  if (urlFunction && next?.[0] === TokenType.String) checkCssUrl(next[4].value, options, problems);
  if (urlFunction && next?.[0] !== TokenType.String) problems.push(`css ${token[4].value}() without a string`);
  if (inImageSet && token[0] === TokenType.String) checkCssUrl(token[4].value, options, problems);
}

function checkCssUrl(value: string, options: OracleOptions, problems: string[]): void {
  if (!SAFE_IMAGE.test(value)) problems.push(`css url ${value}`);
  if (options.imagesBlocked && /^img\//.test(value)) problems.push(`css img route while blocked: ${value}`);
}
