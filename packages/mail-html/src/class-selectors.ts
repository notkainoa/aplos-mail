import { TokenType, type CSSToken } from '@csstools/css-tokenizer';
import { ID_PREFIX, moveOwnNames } from './ids';

// Aplos's own elements carry a class that starts with `aplos-` (quote wrappers, find marks, the
// blocked-image placeholder, the clipped note), and a mail's class of that name is moved to
// `m-aplos-…` (ids.ts). A mail's CSS must follow that move wherever a selector can name a class,
// or it could hide what Aplos adds. This file finds the attribute-selector half, `[class…=value]`.
//
// A selector whose value could match a class that begins with `aplos-` is REWRITTEN to its
// `m-aplos-` counterpart, never dropped: the mail's own renamed elements still match what it meant,
// and Aplos's elements no longer do.
//
//   =  ~=  $=   a name starting `aplos-`                  [class~="aplos-q"] -> [class~="m-aplos-q"]
//   ^=  *=  |=  a name starting `aplos-`, or just `aplos`  [class|=aplos]     -> [class|=m-aplos]
//
// "Starting" means at the start of the value or after whitespace in it (`$=` and `*=` values may
// hold several names). Any case; the `i` and `s` flags are left alone. Not covered, on purpose: a
// fragment that is not recognisably ours (`[class^=ap]`, `[class*=quote]`, `[class$=-find]`): it
// would also change selectors for other classes. Such a selector can still hide a wrapper, which
// is cosmetic (no load, no script).

const OPERATOR_STARTS = new Set(['~', '|', '^', '$', '*']);
const NAME_OR_STEM = /(^|[\t\n\f\r ])(aplos)(?=-|$)/gi;
const STEM_OPERATORS = new Set(['^', '*', '|']);

function skipsTrivia(token: CSSToken | undefined): boolean {
  return token?.[0] === TokenType.Whitespace || token?.[0] === TokenType.Comment;
}

function nextMeaningful(tokens: CSSToken[], from: number): number {
  let at = from;
  while (at < tokens.length && skipsTrivia(tokens[at])) at++;
  return at;
}

function delimOf(token: CSSToken | undefined): string | undefined {
  return token?.[0] === TokenType.Delim ? token[4].value : undefined;
}

function nameOf(token: CSSToken | undefined): string | undefined {
  return token?.[0] === TokenType.Ident ? token[4].value : undefined;
}

/** The operator at `at` (`=` or `X=`): its first character, and the index just past it. */
function readOperator(tokens: CSSToken[], at: number): { op: string; end: number } | undefined {
  const first = delimOf(tokens[at]);
  if (first === '=') return { op: '=', end: at + 1 };
  if (first === undefined || !OPERATOR_STARTS.has(first)) return undefined;
  // Comments are not tokens to the browser, so `^/**/=` is `^=`. Whitespace is not allowed there,
  // but being generous costs nothing: renaming inside a selector the browser drops changes nothing.
  const next = nextMeaningful(tokens, at + 1);
  return delimOf(tokens[next]) === '=' ? { op: first, end: next + 1 } : undefined;
}

/** `[ns|class` up to the operator: the attribute name and where the operator starts, if any. */
function readName(tokens: CSSToken[], open: number): { name: string; at: number } | undefined {
  let name = '';
  let at = nextMeaningful(tokens, open + 1);
  for (; at < tokens.length; at = nextMeaningful(tokens, at + 1)) {
    const ident = nameOf(tokens[at]);
    if (ident !== undefined) name = ident;
    else if (readOperator(tokens, at)) return { name, at };
    else if (delimOf(tokens[at]) !== '|' && delimOf(tokens[at]) !== '*') return undefined;
  }
  return undefined;
}

/** `value` with every `aplos-` name (or stem, for `^=`, `*=`, `|=`) moved to `m-aplos…`. */
export function scopeClassSelectorValue(op: string, value: string): string {
  if (!STEM_OPERATORS.has(op)) return moveOwnNames(value);
  return value.replace(NAME_OR_STEM, `$1${ID_PREFIX}$2`);
}

/**
 * For each `[class OP value]` whose value changes, the index of the value token and its new
 * decoded value. Each scan ends at the next `[` at the latest, so the pass is linear.
 */
export function classValueRewrites(tokens: CSSToken[]): Map<number, string> {
  const rewrites = new Map<number, string>();
  for (let open = 0; open < tokens.length; open++) {
    if (tokens[open][0] !== TokenType.OpenSquare) continue;
    const found = readName(tokens, open);
    if (found?.name.toLowerCase() !== 'class') continue;
    const operator = readOperator(tokens, found.at);
    if (!operator) continue;
    const at = nextMeaningful(tokens, operator.end);
    const token = tokens[at];
    if (token?.[0] !== TokenType.Ident && token?.[0] !== TokenType.String) continue;
    const scoped = scopeClassSelectorValue(operator.op, token[4].value);
    if (scoped !== token[4].value) rewrites.set(at, scoped);
  }
  return rewrites;
}
