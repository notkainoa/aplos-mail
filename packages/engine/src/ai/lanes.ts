import type { Address, LaneFor, LaneInput, LaneResult, StructuredHint } from '../ports';

/**
 * Heuristic Home lanes (ARCH 8.2): pure, deterministic, never waits for AI. Mail is `do` (respond), `update` (see) or
 * `low` (skip). Unsure: a person's mail goes to `do`, automated mail to `low`. Only headers, folder roles, thread facts
 * and a stored body are read.
 *
 * Trust order, so a header trick can demote automated mail but cannot hide a personal message:
 * 1. An explicit no-reply address, or strong bulk headers (Precedence, Auto-Submitted, List-Id, the promotions and
 *    social tabs), mean automated. Only a thread the user replied on lifts a strong-bulk mail, and only to `update`
 *    (to `do` when it asks a question or names a deadline, never for Auto-Submitted).
 * 2. A service-style address (`billing@`, `security-alerts@`) is automated unless the user replied in the thread.
 * 3. A lone `List-Unsubscribe` (anyone can forge it) or the Gmail updates tab is automated only for a sender the user
 *    has never written to and never replied to.
 */

const BULK_PRECEDENCE = /^(bulk|list|junk)$/i;
const SERVICE_TOKENS = new Set([
  'notification',
  'notifications',
  'notify',
  'alert',
  'alerts',
  'security',
  'account',
  'accounts',
  'newsletter',
  'news',
  'digest',
  'marketing',
  'offers',
  'promo',
  'promotions',
  'deals',
  'updates',
  'update',
  'receipt',
  'receipts',
  'order',
  'orders',
  'billing',
  'invoice',
  'invoices',
  'shipping',
  'shipment',
  'tracking',
  'delivery',
  'verify',
  'confirm',
  'confirmation',
  'system',
  'robot',
  'auto',
  'automated',
  'automail',
  'bounce',
  'bounces',
  'postmaster',
  'daemon',
]);
/** Role addresses a person can sit behind (`accounts@vendor` asking you to pay by Friday). */
const HUMAN_ROLE_TOKENS = new Set([
  'account',
  'accounts',
  'billing',
  'invoice',
  'invoices',
  'order',
  'orders',
  'security',
]);

const SECURITY =
  /\b(new (sign[- ]?in|log[- ]?in|device)|sign[- ]?in (attempt|alert|from)|security (alert|notice|code|info)|verification code|one[- ]time (code|passcode|password)|password (reset|changed)|reset your password|suspicious (activity|sign)|(2|two)[- ]?(step|factor)|your .{0,24}\bcode is\b)/i;
const SHIPPING_PROGRESS =
  /\b(on (its|the) way|has shipped|have shipped|out for delivery|shipment (update|confirmation)|tracking (number|update)|order (has )?shipped|in transit)/i;
const FINAL_STATE =
  /(\b(was|has been|been|just got|got) delivered\b|^\s*delivered\b|\bdelivered:|\b(payment|autopay) (is |was |has been )?(scheduled|received|processed|posted)|\bscheduled payment\b|\bminutes (are |were |have been )?(posted|available)\b|\b(statement|receipt|invoice) is (ready|available)\b|\brefund (was |has been )?(issued|processed))/i;
const QUESTION = /\?/;
const DEADLINE =
  /\b(deadline|due (on|by|date|today|tomorrow)|by (eod|end of day|tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|asap|urgent(ly)?|before (noon|tomorrow|friday|monday)|need (this|it) by)\b/i;
const REQUEST =
  /\b(please|pls|can you|could you|would you|will you|send|call|let me know|need|remember|don'?t forget|make sure|confirm|sign|bring|forward)\b/i;

const CLOSER_MAX = 120;
const DUE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Signals {
  /** Precedence bulk/list/junk, Auto-Submitted, List-Id, or a Gmail promotions/social tab. */
  strong: boolean;
  /** Auto-Submitted other than `no`: a machine wrote it, whatever the thread says. */
  auto: boolean;
  /** A `List-Unsubscribe` header alone: many services add one, and anyone can forge one. */
  weak: boolean;
  noReply: boolean;
  service: boolean;
  humanRole: boolean;
  updatesTab: boolean;
  direct: boolean;
  ccOnly: boolean;
  engaged: boolean;
  userReplied: boolean;
  text: string;
}

const norm = (address: string) => address.trim().toLowerCase();

const stripTag = (address: string) => {
  const [local = '', domain = ''] = norm(address).split('@');
  return `${local.split('+')[0]}@${domain}`;
};

/** Letters and digits only, after folding width variants and dropping invisible characters. */
const compact = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const NO_REPLY = /(no|donot)repl(y|ies)/;
const NO_REPLY_LABEL = /^(no|donot)repl(y|ies)/;

function includesSelf(list: Address[], self: Set<string>) {
  return list.some(a => self.has(norm(a.address)) || self.has(stripTag(a.address)));
}

function isNoReply(from?: Address) {
  if (!from) return false;
  const [local = '', domain = ''] = from.address.split('@');
  const flat = compact(local);
  return (
    NO_REPLY.test(flat) || domain.split('.').some(label => NO_REPLY_LABEL.test(compact(label)))
  );
}

function localTokens(from?: Address) {
  const local = from?.address.split('@')[0] ?? '';
  return local
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** The first word of a header value: `bulk;x` is bulk and `no (human)` is `no`. */
const headWord = (value?: string) =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .split(/[^a-z-]/, 1)[0] ?? '';

function isAutoSubmitted(input: LaneInput) {
  const word = headWord(input.message.list.autoSubmitted);
  return word !== '' && word !== 'no';
}

function isStrongBulk(input: LaneInput) {
  const { list, roles } = input.message;
  return (
    BULK_PRECEDENCE.test(headWord(list.precedence)) ||
    isAutoSubmitted(input) ||
    Boolean(list.listId?.trim()) ||
    roles.includes('category.promotions') ||
    roles.includes('category.social')
  );
}

/** Quoted replies and a trailing "On … wrote:" block are not the sender's words. */
function ownWords(text: string) {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex(l => /^\s*on .{5,120} wrote:\s*$/i.test(l));
  const tail = cut < 0 ? [] : lines.slice(cut + 1);
  // Text after a forged attribution line is still the sender's own, so only a quote-only tail is dropped.
  const quoteOnly = tail.every(l => l.trim() === '' || l.trimStart().startsWith('>'));
  return (cut >= 0 && quoteOnly ? lines.slice(0, cut) : lines)
    .filter(l => !l.trimStart().startsWith('>'))
    .join('\n')
    .trim();
}

function signalsOf(input: LaneInput): Signals {
  const { message, self } = input;
  const mine = new Set(self.flatMap(a => [norm(a), stripTag(a)]));
  const to = includesSelf(message.to, mine);
  const cc = includesSelf(message.cc, mine);
  const tokens = localTokens(message.from);
  return {
    strong: isStrongBulk(input),
    auto: isAutoSubmitted(input),
    weak: Boolean(message.list.listUnsubscribe?.trim()),
    noReply: isNoReply(message.from),
    service: tokens.some(t => SERVICE_TOKENS.has(t)),
    humanRole: tokens.some(t => HUMAN_ROLE_TOKENS.has(t)),
    updatesTab: message.roles.includes('category.updates'),
    // Not named at all (a Bcc, a send-as alias) counts as direct: unsure means a person's mail is seen.
    direct: to || !cc,
    ccOnly: cc && !to,
    engaged: input.knownCorrespondent || input.userReplied,
    userReplied: input.userReplied,
    text: ownWords(input.text ?? message.snippet ?? ''),
  };
}

function validDue(due?: string) {
  const m = due === undefined ? null : DUE_DATE.exec(due);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? due : undefined;
}

const dueOf = (structured: StructuredHint[]) =>
  structured
    .filter(h => h.kind === 'bill' || h.kind === 'invite')
    .map(h => validDue(h.due))
    .filter((d): d is string => d !== undefined)
    .sort()[0];

const has = (structured: StructuredHint[], kind: StructuredHint['kind']) =>
  structured.some(h => h.kind === kind);

const asks = (text: string) => QUESTION.test(text) || DEADLINE.test(text);

function importanceOf(input: LaneInput, s: Signals): LaneResult['importance'] {
  if (s.strong || s.noReply) return 'normal';
  const gmail = input.message.roles.includes('important');
  return gmail || (s.direct && input.knownCorrespondent) ? 'important' : 'normal';
}

/** The user ended the thread and this is a short thanks or "Of course!" with nothing to answer or do. */
function closesThread(input: LaneInput, s: Signals) {
  if (!input.userEndedThread || s.text === '' || s.text.length > CLOSER_MAX) return false;
  return !asks(s.text) && !REQUEST.test(s.text);
}

/** Strong bulk headers. A reply the user made lifts it out of Low; Auto-Submitted never lifts. */
function bulkLane(s: Signals): LaneResult['lane'] {
  if (!s.userReplied || s.auto) return 'low';
  return asks(s.text) ? 'do' : 'update';
}

/** Bill, delivery and reservation markup, read only when no strong bulk header contradicts it. */
function structuredLane(structured: StructuredHint[], s: Signals): LaneResult['lane'] | undefined {
  if (has(structured, 'bill')) return dueOf(structured) && !s.weak ? 'do' : 'update';
  if (structured.some(h => h.kind === 'delivery' && h.final === false)) return 'low';
  if (structured.some(h => h.kind === 'delivery' || h.kind === 'reservation')) return 'update';
  return undefined;
}

/** Automated mail, sorted by what it says. */
function automatedLane(input: LaneInput, s: Signals): LaneResult['lane'] {
  if (s.strong) return bulkLane(s);
  const words = `${input.message.subject ?? ''}\n${s.text}`;
  const structured = input.structured ?? [];
  if (has(structured, 'invite')) return s.weak ? 'update' : 'do';
  if (SECURITY.test(words)) return 'low';
  const fromMarkup = structuredLane(structured, s);
  if (fromMarkup) return fromMarkup;
  if (FINAL_STATE.test(words)) return 'update';
  if (SHIPPING_PROGRESS.test(words)) return 'low';
  if (s.updatesTab && !s.noReply) return 'update';
  // A person can sit behind `accounts@` or `orders@`: with no bulk marks, their question or deadline is seen.
  return s.humanRole && !s.noReply && !s.weak && asks(s.text) ? 'do' : 'low';
}

/** A person's mail: `low` only for a thread-closer the user ended. */
function personLane(input: LaneInput, s: Signals): LaneResult['lane'] {
  if (has(input.structured ?? [], 'invite')) return 'do';
  if (closesThread(input, s)) return 'low';
  if (s.ccOnly && !s.userReplied) return 'update';
  return 'do';
}

/** What makes a sender automated; each weaker signal gives way to the user's own history with the sender. */
const isAutomated = (s: Signals) =>
  s.strong ||
  s.noReply ||
  (s.service && !s.userReplied) ||
  ((s.weak || s.updatesTab) && !s.engaged);

export const laneFor: LaneFor = input => {
  const s = signalsOf(input);
  const lane = isAutomated(s) ? automatedLane(input, s) : personLane(input, s);
  const due = lane === 'low' ? undefined : dueOf(input.structured ?? []);
  const result: LaneResult = {
    lane,
    importance: lane === 'low' ? 'normal' : importanceOf(input, s),
  };
  return due === undefined ? result : { ...result, due };
};
