// The frame's URL grammar, and nothing else. A token is 32 lowercase hex characters (128 bits).
//
//   document:      aplos-mail://m/<token>/
//   sub-resource:  aplos-mail://m/<token>/cid/<n>   aplos-mail://m/<token>/img/<n>
//   n:             0, or 1-6 decimal digits with no leading zero (0 to 999999)
//
// The document URL ends with a slash so the sanitizer's relative `cid/<n>` and `img/<n>` resolve
// under the token (without it they would resolve to `aplos-mail://m/cid/<n>`). Everything else is
// refused: no query, fragment, percent-escape, dot segment, backslash, doubled or trailing slash,
// uppercase hex, other host or scheme. `Mail/serve` gets `{token, path}`, where path is what
// follows `<token>/`: '' for the document, `cid/<n>` or `img/<n>` for a sub-resource.

export const FRAME_ORIGIN = 'aplos-mail://m/';

export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

const PATH_PATTERN = /^(?:(cid|img)\/(0|[1-9][0-9]{0,5}))?$/;

/** Longer than any accepted URL: refused before any pattern runs. */
const MAX_URL = FRAME_ORIGIN.length + 32 + 1 + 'img/'.length + 6;

export type FrameRoute =
  { kind: 'document' } | { kind: 'cid'; index: number } | { kind: 'img'; index: number };

export interface FrameTarget {
  token: string;
  route: FrameRoute;
}

export function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** The document URL for a token, as `Mail/frame` returns it. */
export function frameUrl(token: string): string {
  return `${FRAME_ORIGIN}${token}/`;
}

/** The route for a `Mail/serve` path, or undefined for anything outside the grammar. */
export function parseFramePath(path: unknown): FrameRoute | undefined {
  if (typeof path !== 'string' || path.length > 10) return undefined;
  const match = PATH_PATTERN.exec(path);
  if (!match) return undefined;
  if (!match[1]) return { kind: 'document' };
  const kind = match[1] === 'cid' ? 'cid' : 'img';
  return { kind, index: Number(match[2]) };
}

/** Token and route for a full frame URL, or undefined for anything outside the grammar. */
export function parseFrameUrl(url: unknown): FrameTarget | undefined {
  if (typeof url !== 'string' || url.length > MAX_URL) return undefined;
  if (!url.startsWith(FRAME_ORIGIN)) return undefined;
  const rest = url.slice(FRAME_ORIGIN.length);
  const token = rest.slice(0, 32);
  if (!isToken(token) || rest[32] !== '/') return undefined;
  const route = parseFramePath(rest.slice(33));
  return route ? { token, route } : undefined;
}

/**
 * The token named by a `Mail/release` or `Mail/toggleQuotes` url: a bare token, the document URL,
 * or the document URL without its slash (the form the contract comment shows). Only here: serving
 * keeps the strict grammar.
 */
export function tokenOf(urlOrToken: unknown): string | undefined {
  if (isToken(urlOrToken)) return urlOrToken;
  const bare = typeof urlOrToken === 'string' && urlOrToken.length === FRAME_ORIGIN.length + 32;
  const target = parseFrameUrl(bare ? `${urlOrToken}/` : urlOrToken);
  return target?.route.kind === 'document' ? target.token : undefined;
}
