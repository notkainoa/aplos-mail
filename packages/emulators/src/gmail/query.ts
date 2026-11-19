/**
 * A small subset of Gmail search, enough for the calls Aplos makes.
 *
 * Supported: bare words and "quoted phrases" (subject, snippet and body), `-` negation, `OR`
 * (binds tighter than the implicit AND, as in Gmail), parentheses (ignored, which is correct
 * given that precedence), and the operators
 *   label: category: in: is: has:attachment from: to: (To and Cc) subject: rfc822msgid:
 *   newer_than: older_than: (Nd, Nw, Nm = 30 days, Ny = 365 days, Nh) before: after: (yyyy/mm/dd, UTC).
 * Not supported: size:, filename:, larger:, smaller:, {braces}, AROUND, exact-word matching (words
 * match as substrings). Unknown operators match nothing.
 */
export interface QueryTarget {
  labelIds: string[];
  /** Lowercase label names with spaces as hyphens, e.g. 'inbox', 'unread', 'team-notes'. */
  labelNames: string[];
  from: string;
  to: string;
  subject: string;
  messageId: string;
  internalDate: number;
  hasAttachment: boolean;
  /** Lowercase subject, snippet and body text. */
  searchText: string;
}

interface Term {
  or?: false;
  neg: boolean;
  key?: string;
  value: string;
}
type Token = Term | { or: true };

export interface ParsedQuery {
  /** AND of ORs: every group needs one matching term. */
  groups: Term[][];
}

export const normalizeLabelName = (name: string): string =>
  name.toLowerCase().replace(/[\s/]+/g, '-');

function tokenize(q: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const readQuoted = (): string => {
    i++; // opening quote
    const start = i;
    while (i < q.length && q[i] !== '"') i++;
    const value = q.slice(start, i);
    i++; // closing quote
    return value;
  };
  while (i < q.length) {
    if (/[\s()]/.test(q[i])) {
      i++;
      continue;
    }
    let neg = false;
    if (q[i] === '-' && i + 1 < q.length && !/\s/.test(q[i + 1])) {
      neg = true;
      i++;
    }
    const keyed = /^([a-z_0-9]+):/i.exec(q.slice(i));
    if (keyed) {
      i += keyed[0].length;
      const value = q[i] === '"' ? readQuoted() : readWord();
      tokens.push({ neg, key: keyed[1].toLowerCase(), value });
    } else if (q[i] === '"') {
      tokens.push({ neg, value: readQuoted() });
    } else {
      const word = readWord();
      if (word === 'OR' && !neg) tokens.push({ or: true });
      else if (word) tokens.push({ neg, value: word });
    }
  }
  return tokens;

  function readWord(): string {
    const start = i;
    while (i < q.length && !/[\s()]/.test(q[i])) i++;
    return q.slice(start, i);
  }
}

export function parseQuery(q: string): ParsedQuery {
  const tokens = tokenize(q);
  const groups: Term[][] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.or) continue;
    const group: Term[] = [token];
    // "a OR b OR c" collects into one group.
    while (tokens[i + 1]?.or && tokens[i + 2] && !tokens[i + 2].or) {
      group.push(tokens[i + 2] as Term);
      i += 2;
    }
    groups.push(group);
  }
  return { groups };
}

/** True when the query itself asks for spam or trash, so the default exclusion must not hide them. */
export function mentionsSpamTrash(parsed: ParsedQuery): boolean {
  return parsed.groups.flat().some(term => {
    if (term.neg || !term.key) return false;
    const value = term.value.toLowerCase();
    return (
      (term.key === 'in' && ['anywhere', 'trash', 'spam'].includes(value)) ||
      ((term.key === 'label' || term.key === 'is') && ['trash', 'spam'].includes(value))
    );
  });
}

const UNIT_MS: Record<string, number> = {
  h: 3600_000,
  d: 86400_000,
  w: 7 * 86400_000,
  m: 30 * 86400_000,
  y: 365 * 86400_000,
};

function ageLimitMs(value: string): number | undefined {
  const match = /^(\d+)([hdwmy])?$/i.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * UNIT_MS[(match[2] ?? 'd').toLowerCase()];
}

function dateMs(value: string): number | undefined {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
}

function termMatches(term: Term, target: QueryTarget, now: number): boolean {
  const value = term.value.toLowerCase();
  let result: boolean;
  switch (term.key) {
    case undefined:
      result = target.searchText.includes(value);
      break;
    case 'label':
      result = target.labelNames.includes(normalizeLabelName(value));
      break;
    case 'category':
      result = target.labelIds.includes(`CATEGORY_${value.toUpperCase()}`);
      break;
    case 'in':
      result =
        value === 'anywhere' || target.labelNames.includes(value === 'drafts' ? 'draft' : value);
      break;
    case 'is':
      result =
        value === 'read' ? !target.labelIds.includes('UNREAD') : target.labelNames.includes(value);
      break;
    case 'has':
      result = value === 'attachment' ? target.hasAttachment : false;
      break;
    case 'from':
      result = target.from.includes(value);
      break;
    case 'to':
      result = target.to.includes(value);
      break;
    case 'subject':
      result = target.subject.includes(value);
      break;
    case 'rfc822msgid':
      result = target.messageId === value.replace(/^<|>$/g, '');
      break;
    case 'newer_than': {
      const limit = ageLimitMs(value);
      result = limit !== undefined && target.internalDate >= now - limit;
      break;
    }
    case 'older_than': {
      const limit = ageLimitMs(value);
      result = limit !== undefined && target.internalDate < now - limit;
      break;
    }
    case 'before': {
      const at = dateMs(value);
      result = at !== undefined && target.internalDate < at;
      break;
    }
    case 'after': {
      const at = dateMs(value);
      result = at !== undefined && target.internalDate >= at;
      break;
    }
    default:
      result = false;
  }
  return term.neg ? !result : result;
}

export function matchesQuery(parsed: ParsedQuery, target: QueryTarget, now: number): boolean {
  return parsed.groups.every(group => group.some(term => termMatches(term, target, now)));
}
