import type { LaneInput } from '../ports';

export type Job = 'ask' | 'update' | 'read' | 'newPerson' | 'record' | 'other';

interface JobResult {
  job: Job;
  confidence: 'sure' | 'unsure';
}

const NO_REPLY = /^(no|donot)repl(y|ies)/;
const SERVICE =
  /\b(alerts?|notifications?|notify|billing|invoices?|receipts?|orders?|shipping|delivery|tracking|newsletter|news|digest|offers?|marketing|security|statements?|updates?|automated|system|robot)\b/i;
const REQUEST =
  /\?|\b(can|could|would|will) you\b|\bplease\b|\b(let me know|rsvp|action required)\b|\byour (approval|permission|signature|response) (is )?(needed|required)\b/i;
const ACTION =
  /\b(deadline|payment due|pay by|permission form|due (on|by|today|tomorrow)|by (eod|tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday)|asap|urgent)\b/i;
const IMPERATIVE =
  /(?:^|[.!:;\n])\s*(book|schedule|sign|complete)\b|\b(you must|you should|you need to|to)\s+(book|schedule|sign|complete)\b/i;
const CONSENT =
  /\b(accept|agree to)\s+((the|our|these|updated|new)\s+)*(terms|conditions|agreement|policy)\b|\b(review|read) and (accept|agree|sign|complete|approve)\b/i;
const DATED_DEADLINE =
  /\b(by|before|due( on)?)\s+(\d{1,4}[-/]\d{1,2}([-/]\d{1,4})?|(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2})\b/i;
const CHANGE =
  /\b(refund|failed|declined|unusual|security|new (sign[- ]?in|device)|password|cancelled|canceled|rescheduled|delayed|shipped|shipping|delivered|delivery|tracking|in transit|appointment|reservation|check[- ]?in|change|changed|moved|returned|restored|locked|unavailable|available|ready|confirmed|scheduled|closed)\b/i;
const RECORD =
  /\b(receipt|statement|payment (received|processed)|payment has been received|paid in full|policy|warranty|certificate|tax|records|copy|archive|signed|settled|summary|acknowledgment|settlement)\b/i;
const READING =
  /\b(newsletter|digest|edition|issue|round[- ]?up|essays?|articles?|editorial|weekly|monthly|subscribers|seasonal)\b/i;
const PROMOTION =
  /\b(sale|discount|coupon|offers?|shop now|limited time|free trial|promotion|upgrade|buy|advertising|sponsored|premium|campaign|outreach|prospect|directory)\b/i;

function ownWords(text: string) {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex(line => /^\s*on .{5,120} wrote:\s*$/i.test(line));
  const tail = cut < 0 ? [] : lines.slice(cut + 1);
  const quoteOnly = tail.every(line => !line.trim() || line.trimStart().startsWith('>'));
  return (cut >= 0 && quoteOnly ? lines.slice(0, cut) : lines)
    .filter(line => !line.trimStart().startsWith('>'))
    .join('\n');
}

function strongBulk(input: LaneInput) {
  const { list } = input.message;
  return (
    /^(bulk|list|junk)\b/i.test(list.precedence ?? '') ||
    Boolean(list.listId?.trim()) ||
    Boolean(list.autoSubmitted && !/^no$/i.test(list.autoSubmitted.trim()))
  );
}

function senderSignals(input: LaneInput) {
  const { message } = input;
  const { list, roles } = message;
  const local = (message.from?.address.split('@')[0] ?? '').normalize('NFKC').toLowerCase();
  const noReply = NO_REPLY.test(local.replace(/[^a-z0-9]/g, ''));
  const service = SERVICE.test(local.replace(/[._+-]/g, ' '));
  const engaged = input.knownCorrespondent || input.userReplied;
  const strong = strongBulk(input);
  const promotion = roles.includes('category.promotions');
  const social = roles.includes('category.social');
  const weak = Boolean(list.listUnsubscribe) || roles.includes('category.updates');
  const automated = noReply || strong || promotion || social || (!engaged && (service || weak));
  const person = !automated || (engaged && !strong && !noReply);
  const machine = !person && (noReply || service || strong);
  const editorial = Boolean(list.listId) || /^(bulk|list|junk)\b/i.test(list.precedence ?? '');
  const generic = /^(hello|info|contact|team|support|office)$/i.test(local);
  const clean = ![noReply, service, strong, weak, promotion, social, generic].some(Boolean);
  const app = /\b(notifications?|notify|system|robot)\b/i.test(local);
  const explicit = noReply || service;
  return { person, machine, engaged, promotion, social, editorial, clean, app, explicit };
}

function contentSignals(input: LaneInput) {
  const { message } = input;
  const body = ownWords(input.text ?? message.snippet ?? '');
  const subject = /^\s*(re|fw|fwd):/i.test(message.subject ?? '') ? '' : message.subject;
  const words = `${subject ?? ''}\n${body}`;
  const request = [REQUEST, ACTION, IMPERATIVE, CONSENT, DATED_DEADLINE].some(cue =>
    cue.test(words),
  );
  const changed = CHANGE.test(words);
  const record = RECORD.test(words);
  const reading = READING.test(words);
  const promo = PROMOTION.test(words);
  const structured = input.structured ?? [];
  const invite = structured.some(hint => hint.kind === 'invite');
  const dueBill = structured.some(hint => hint.kind === 'bill' && hint.due);
  const finalBill = structured.some(hint => hint.kind === 'bill' && hint.final && !hint.due);
  const logistics = structured.some(
    hint => hint.kind === 'delivery' || hint.kind === 'reservation',
  );
  const hasText = Boolean(body.trim());
  return {
    request,
    changed,
    record,
    reading,
    promo,
    invite,
    dueBill,
    finalBill,
    logistics,
    hasText,
  };
}

const result = (job: Job, sure = false): JobResult => ({
  job,
  confidence: sure ? 'sure' : 'unsure',
});

function personJob(s: ReturnType<typeof contentSignals>, sender: ReturnType<typeof senderSignals>) {
  const conflict = s.changed || s.record || s.reading || s.promo || s.logistics;
  if (!sender.engaged) return result('newPerson', sender.clean && s.hasText && !conflict);
  if (s.request || s.invite || s.dueBill) {
    return result('ask');
  }
  return result('update', s.hasText && !s.record && !s.reading && !s.promo && !s.finalBill);
}

function automatedJob(
  s: ReturnType<typeof contentSignals>,
  sender: ReturnType<typeof senderSignals>,
) {
  const { machine } = sender;
  const { changed, request, promo, reading, invite, dueBill, record } = s;
  if (request || invite || dueBill) return result('ask');
  if (changed || s.logistics)
    return result('update', machine && !request && !promo && !reading && !record);
  if ((record || s.finalBill) && machine) return result('record', !reading && !promo);
  if (reading && !promo && !record) return result('read', sender.editorial);
  const other = machine && (promo || sender.app || sender.social);
  if (other && !record && !reading) return result('other', true);
  return result(sender.explicit ? 'update' : 'ask');
}

/** Header and sender facts establish automation; history defeats weak signals. Ambiguity stays visible. */
export function jobFor(input: LaneInput): JobResult {
  const sender = senderSignals(input);
  const content = contentSignals(input);
  return sender.person ? personJob(content, sender) : automatedJob(content, sender);
}
