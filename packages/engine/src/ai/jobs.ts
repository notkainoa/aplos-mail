import type { LaneInput } from '../ports';

export type Job = 'ask' | 'update' | 'read' | 'newPerson' | 'record' | 'other';

interface JobResult {
  job: Job;
  confidence: 'sure' | 'unsure';
}

const NO_REPLY = /^(no|donot)repl(y|ies)/;
const SERVICE =
  /\b(alerts?|notifications?|billing|invoices?|receipts?|orders?|shipping|delivery|tracking|newsletter|digest|offers?|marketing|security|statements?)\b/i;
const REQUEST =
  /\b(can|could|would|will) you\b|\bplease (send|review|approve|confirm|sign|pay|reply|choose|complete)\b|\byour (approval|permission|signature|response) (is )?(needed|required)\b/i;
const ACTION = /\b(action required|payment due|pay by|permission form|rsvp|deadline)\b/i;
const CHANGE =
  /\b(refund|failed payment|payment (failed|declined)|unusual (charge|activity)|security alert|new (sign[- ]?in|device)|password (reset|changed)|cancelled|canceled|rescheduled|delayed|has shipped|out for delivery|in transit)\b/i;
const RECORD =
  /\b(receipt|statement|payment (received|processed)|paid in full|policy (update|notice))\b/i;
const READING = /\b(newsletter|digest|edition|weekly round[- ]?up)\b/i;
const PROMOTION = /\b(sale|discount|coupon|special offer|shop now|limited time|free trial)\b/i;

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
  const { list, roles } = input.message;
  return (
    /^(bulk|list|junk)\b/i.test(list.precedence ?? '') ||
    Boolean(list.listId?.trim()) ||
    Boolean(list.autoSubmitted && !/^no$/i.test(list.autoSubmitted.trim())) ||
    roles.includes('category.promotions') ||
    roles.includes('category.social')
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
  const weak = Boolean(list.listUnsubscribe) || roles.includes('category.updates');
  const automated = noReply || strong || (!engaged && (service || weak));
  const person = !automated || (engaged && !strong && !noReply);
  const machine = noReply || (service && !engaged);
  return { person, machine, engaged };
}

function contentSignals(input: LaneInput) {
  const { message } = input;
  const body = ownWords(input.text ?? message.snippet ?? '');
  const subject = /^\s*(re|fw|fwd):/i.test(message.subject ?? '') ? '' : message.subject;
  const words = `${subject ?? ''}\n${body}`;
  const request = REQUEST.test(words) || ACTION.test(words);
  const changed = CHANGE.test(words);
  const record = RECORD.test(words);
  const reading = READING.test(words);
  const promo = PROMOTION.test(words);
  const structured = input.structured ?? [];
  const invite = structured.some(hint => hint.kind === 'invite');
  const dueBill = structured.some(hint => hint.kind === 'bill' && hint.due);
  const logistics = structured.some(
    hint => hint.kind === 'delivery' || hint.kind === 'reservation',
  );
  return { request, changed, record, reading, promo, invite, dueBill, logistics };
}

const result = (job: Job, sure = false): JobResult => ({
  job,
  confidence: sure ? 'sure' : 'unsure',
});

function personJob(s: ReturnType<typeof contentSignals>, engaged: boolean) {
  if (s.request || s.invite || s.dueBill) {
    return result('ask', engaged && s.request && !s.changed && !s.promo);
  }
  return result('ask');
}

function automatedJob(s: ReturnType<typeof contentSignals>, machine: boolean) {
  const { changed, request, promo, reading, invite, dueBill, record } = s;
  if (changed) return result('update', machine && !request && !promo && !reading);
  if (request || invite || dueBill) return result('ask');
  if (record && !reading && !promo && machine) return result('record');
  if (reading && !promo && !record) return result('read');
  if (promo && machine && !record && !reading) return result('other', true);
  if (s.logistics) return result('update');
  return result(machine ? 'update' : 'ask');
}

/** Header and sender facts establish automation; history defeats weak signals. Ambiguity stays visible. */
export function jobFor(input: LaneInput): JobResult {
  const sender = senderSignals(input);
  const content = contentSignals(input);
  return sender.person ? personJob(content, sender.engaged) : automatedJob(content, sender.machine);
}
