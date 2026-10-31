import type { Address, FolderRole, LaneInput, LaneResult, StructuredHint } from '../../src/ports';

/** The 60-case header table for `laneFor` (plan 10 WP5.4). Original text, `.example` addresses only. */

export const SELF = 'me@home.example';

export interface LaneCase {
  name: string;
  input: LaneInput;
  expect: Partial<LaneResult> & Pick<LaneResult, 'lane'>;
}

interface Spec {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  unsub?: boolean;
  precedence?: string;
  auto?: string;
  listId?: string;
  roles?: FolderRole[];
  known?: boolean;
  replied?: boolean;
  ended?: boolean;
  structured?: StructuredHint[];
}

const addr = (address: string): Address => ({ address });

/** A thread's newest inbound message with sensible defaults: a direct mail from a stranger. */
export function build(spec: Spec): LaneInput {
  const list = {
    ...(spec.unsub ? { listUnsubscribe: '<mailto:leave@list.example>' } : {}),
    ...(spec.precedence ? { precedence: spec.precedence } : {}),
    ...(spec.auto ? { autoSubmitted: spec.auto } : {}),
    ...(spec.listId ? { listId: spec.listId } : {}),
  };
  return {
    message: {
      from: addr(spec.from ?? 'sam@people.example'),
      to: (spec.to ?? [SELF]).map(addr),
      cc: (spec.cc ?? []).map(addr),
      subject: spec.subject ?? 'Hello',
      date: 1_700_000_000_000,
      list,
      ...(spec.text === undefined ? {} : { snippet: spec.text }),
      flags: { seen: false, flagged: false, draft: false, fromMe: false },
      roles: spec.roles ?? ['inbox'],
    },
    self: [SELF],
    knownCorrespondent: spec.known ?? false,
    userReplied: spec.replied ?? false,
    userEndedThread: spec.ended ?? false,
    ...(spec.structured ? { structured: spec.structured } : {}),
  };
}

const row = (name: string, spec: Spec, expect: LaneCase['expect']): LaneCase => ({
  name,
  input: build(spec),
  expect,
});

const bill = (due?: string): StructuredHint[] => [{ kind: 'bill', ...(due ? { due } : {}) }];

export const LANE_CASES: LaneCase[] = [
  // people
  row('direct mail from a stranger', {}, { lane: 'do', importance: 'normal' }),
  row(
    'direct mail from a known correspondent',
    { known: true },
    { lane: 'do', importance: 'important' },
  ),
  row('direct question', { text: 'Can you review this by Friday?' }, { lane: 'do' }),
  row('direct mail with a deadline', { text: 'Contract is due by tomorrow.' }, { lane: 'do' }),
  row(
    'Gmail IMPORTANT person mail',
    { roles: ['inbox', 'important'] },
    { lane: 'do', importance: 'important' },
  ),
  row(
    'cc-only FYI from a person',
    { to: ['lee@people.example'], cc: [SELF], text: 'FYI, shipped.' },
    { lane: 'update' },
  ),
  row(
    'cc-only from a known correspondent',
    { to: ['lee@people.example'], cc: [SELF], known: true },
    { lane: 'update' },
  ),
  row(
    'cc-only but the user replied in the thread',
    { to: ['lee@people.example'], cc: [SELF], replied: true },
    { lane: 'do' },
  ),
  row('named by a plus-tag alias', { to: ['me+shop@home.example'] }, { lane: 'do' }),
  row(
    'not named at all (Bcc or send-as) counts as direct',
    { to: ['team@people.example'] },
    { lane: 'do' },
  ),
  row(
    'to self in upper case',
    { to: ['ME@Home.Example'], cc: ['x@people.example'] },
    { lane: 'do' },
  ),
  row(
    'known correspondent and a user reply',
    { known: true, replied: true },
    { lane: 'do', importance: 'important' },
  ),
  row(
    'person mail in the Gmail updates tab but known',
    { roles: ['inbox', 'category.updates'], known: true },
    { lane: 'do' },
  ),
  // closing the thread
  row(
    '"Of course!" closes a thread the user ended',
    { ended: true, text: 'Of course!' },
    { lane: 'low' },
  ),
  row(
    'thanks closes a thread the user ended',
    { ended: true, text: 'Thanks so much, talk soon.' },
    { lane: 'low' },
  ),
  row(
    'short reply with a question stays do',
    { ended: true, text: 'Of course, shall I bring it?' },
    { lane: 'do' },
  ),
  row(
    'short reply naming a deadline stays do',
    { ended: true, text: 'Great, need it by Monday.' },
    { lane: 'do' },
  ),
  row(
    'short reply on a thread the user did not end',
    { ended: false, text: 'Of course!' },
    { lane: 'do' },
  ),
  row(
    'long reply on a thread the user ended',
    { ended: true, text: 'Thanks. '.repeat(30) },
    { lane: 'do' },
  ),
  row(
    'closer with a quoted question below',
    { ended: true, text: 'Sure!\n> Can you send it?\n' },
    { lane: 'low' },
  ),
  row('no body text means unsure, so do', { ended: true }, { lane: 'do' }),
  // bulk headers
  row('List-Unsubscribe from a stranger', { unsub: true }, { lane: 'low', importance: 'normal' }),
  row('Precedence bulk', { precedence: 'bulk' }, { lane: 'low' }),
  row('Precedence list', { precedence: 'list' }, { lane: 'low' }),
  row('Precedence junk', { precedence: 'junk' }, { lane: 'low' }),
  row('Auto-Submitted auto-generated', { auto: 'auto-generated' }, { lane: 'low' }),
  row('Auto-Submitted auto-replied (out of office)', { auto: 'auto-replied' }, { lane: 'low' }),
  row('Auto-Submitted no is a human', { auto: 'no' }, { lane: 'do' }),
  row('List-Id on a mailing list', { listId: '<dev.lists.example>' }, { lane: 'low' }),
  row('Gmail promotions tab', { roles: ['inbox', 'category.promotions'] }, { lane: 'low' }),
  row('Gmail social tab', { roles: ['inbox', 'category.social'] }, { lane: 'low' }),
  row(
    'promotions tab but the user is in the thread',
    { roles: ['inbox', 'category.promotions'], replied: true },
    { lane: 'update' },
  ),
  row(
    'mailing list the user replied on stays out of Do now',
    { listId: '<dev.lists.example>', replied: true },
    { lane: 'update' },
  ),
  // no-reply senders
  row('noreply', { from: 'noreply@shop.example' }, { lane: 'low' }),
  row('no-reply', { from: 'no-reply@shop.example' }, { lane: 'low' }),
  row('no_reply', { from: 'no_reply@shop.example' }, { lane: 'low' }),
  row('donotreply', { from: 'donotreply@shop.example' }, { lane: 'low' }),
  row('do-not-reply with a tag', { from: 'do-not-reply+9f3@shop.example' }, { lane: 'low' }),
  row('no-reply with a suffix', { from: 'no-reply-orders@shop.example' }, { lane: 'low' }),
  row('no-reply subdomain', { from: 'info@no-reply.shop.example' }, { lane: 'low' }),
  row('bounce address', { from: 'bounce-77@mail.shop.example' }, { lane: 'low' }),
  row('mailer-daemon', { from: 'mailer-daemon@shop.example' }, { lane: 'low' }),
  row('noreply with upper case', { from: 'NoReply@Shop.Example' }, { lane: 'low' }),
  row('service sender newsletter@', { from: 'newsletter@shop.example' }, { lane: 'low' }),
  // updates
  row(
    'delivered',
    { from: 'noreply@carrier.example', subject: 'Your package was delivered' },
    { lane: 'update' },
  ),
  row(
    'delivered: prefix',
    { from: 'noreply@carrier.example', subject: 'Delivered: order 1234' },
    { lane: 'update' },
  ),
  row(
    'payment scheduled',
    { from: 'noreply@bank.example', subject: 'Your payment is scheduled for Friday' },
    { lane: 'update' },
  ),
  row(
    'minutes posted',
    { from: 'club@people.example', unsub: true, subject: 'Board minutes posted' },
    { lane: 'update' },
  ),
  row(
    'receipt available',
    { from: 'billing@shop.example', subject: 'Your receipt is available' },
    { lane: 'update' },
  ),
  row(
    'Gmail updates tab from a service',
    { from: 'alerts@bank.example', roles: ['inbox', 'category.updates'] },
    { lane: 'update' },
  ),
  row(
    'structured final delivery',
    { from: 'noreply@carrier.example', structured: [{ kind: 'delivery', final: true }] },
    { lane: 'update' },
  ),
  row(
    'structured reservation',
    { from: 'noreply@hotel.example', structured: [{ kind: 'reservation' }] },
    { lane: 'update' },
  ),
  // low: shipping progress and security
  row(
    'shipping on its way',
    { from: 'noreply@carrier.example', subject: 'Your order is on its way' },
    { lane: 'low' },
  ),
  row(
    'shipping has shipped, will be delivered',
    { from: 'noreply@carrier.example', subject: 'Shipped; will be delivered Tuesday' },
    { lane: 'low' },
  ),
  row(
    'structured in-transit delivery',
    { from: 'noreply@carrier.example', structured: [{ kind: 'delivery', final: false }] },
    { lane: 'low' },
  ),
  row(
    'new sign-in',
    { from: 'security@accounts.example', subject: 'New sign-in to your account' },
    { lane: 'low' },
  ),
  row(
    'verification code',
    { from: 'noreply@app.example', subject: 'Your verification code' },
    { lane: 'low' },
  ),
  row(
    'password reset from a service',
    { from: 'accounts@app.example', subject: 'Reset your password' },
    { lane: 'low' },
  ),
  // do: invites and bills
  row(
    'calendar invitation from a no-reply sender',
    { from: 'noreply@calendar.example', structured: [{ kind: 'invite' }] },
    { lane: 'do' },
  ),
  row(
    'bill with a due date',
    { from: 'noreply@power.example', structured: bill('2026-11-12') },
    { lane: 'do', due: '2026-11-12' },
  ),
  row(
    'bill without a due date',
    { from: 'noreply@power.example', structured: bill() },
    { lane: 'update' },
  ),
  row(
    'earliest due date wins',
    { from: 'noreply@power.example', structured: [...bill('2026-12-01'), ...bill('2026-11-05')] },
    { lane: 'do', due: '2026-11-05' },
  ),
  row('invite from a person', { structured: [{ kind: 'invite' }] }, { lane: 'do' }),
  row(
    'invite while only cc-ed',
    { to: ['lee@people.example'], cc: [SELF], structured: [{ kind: 'invite' }] },
    { lane: 'do' },
  ),
];

/** Header tricks (the "lane spoofing" check): personal mail must not reach Low, bulk mail must not reach Do now. */
export const SPOOF_CASES: LaneCase[] = [
  row(
    'forged List-Unsubscribe on a known correspondent',
    { known: true, unsub: true, text: 'Lunch?' },
    { lane: 'do' },
  ),
  row(
    'forged List-Unsubscribe in a thread the user replied on',
    { replied: true, unsub: true },
    { lane: 'do' },
  ),
  row(
    'security words in a personal subject',
    { known: true, subject: 'Reset your password? New sign-in help' },
    { lane: 'do' },
  ),
  row(
    'shipping words in a personal mail',
    { known: true, subject: 'It is on its way, delivered Friday?' },
    { lane: 'do' },
  ),
  row(
    'no-reply lookalike in the display name only',
    { from: 'sam@people.example', known: true },
    { lane: 'do' },
  ),
  row(
    'cc-only to self is never low',
    { to: ['lee@people.example'], cc: [SELF], unsub: true, known: true },
    { lane: 'update' },
  ),
  row(
    'bill markup in a newsletter (bulk precedence)',
    { precedence: 'bulk', structured: bill('2026-11-12') },
    { lane: 'low' },
  ),
  row(
    'bill markup in a promotions-tab mail',
    { roles: ['inbox', 'category.promotions'], structured: bill('2026-11-12') },
    { lane: 'low' },
  ),
  row(
    'bill markup with a lone List-Unsubscribe',
    { from: 'noreply@promo.example', unsub: true, structured: bill('2026-11-12') },
    { lane: 'update', due: '2026-11-12' },
  ),
  row(
    'invite markup in a bulk mail',
    { precedence: 'bulk', structured: [{ kind: 'invite' }] },
    { lane: 'low' },
  ),
  row(
    'invite markup with a lone List-Unsubscribe',
    { unsub: true, structured: [{ kind: 'invite' }] },
    { lane: 'update' },
  ),
  row(
    'question text in an automated mail',
    { from: 'noreply@promo.example', text: 'Can we help? Urgent offer by tomorrow!' },
    { lane: 'low' },
  ),
  row(
    'Gmail IMPORTANT cannot lift bulk',
    { precedence: 'bulk', roles: ['inbox', 'important'] },
    { lane: 'low', importance: 'normal' },
  ),
  row('forged Auto-Submitted blank is ignored', { auto: '  ' }, { lane: 'do' }),
  row('Precedence first-class is not bulk', { precedence: 'first-class' }, { lane: 'do' }),
  // found by the adversarial review
  row(
    'security-noreply compound address',
    { from: 'security-noreply@bank.example', subject: 'New sign-in to your account' },
    { lane: 'low' },
  ),
  row(
    'order-update service address, delivered',
    { from: 'order-update@shop.example', subject: 'Your order was delivered' },
    { lane: 'update' },
  ),
  row(
    'unknown sender in the updates tab',
    {
      from: 'info@bank.example',
      roles: ['inbox', 'category.updates'],
      subject: 'Your statement is ready',
    },
    { lane: 'update' },
  ),
  row(
    'security@ the user once wrote to',
    { from: 'security@bank.example', known: true, subject: 'New sign-in to your account' },
    { lane: 'low' },
  ),
  row(
    'newsletter@ with a known sender',
    { from: 'newsletter@shop.example', known: true, unsub: true },
    { lane: 'low' },
  ),
  row(
    'billing@ known, receipt available',
    { from: 'billing@shop.example', known: true, subject: 'Your receipt is available' },
    { lane: 'update' },
  ),
  row(
    'fullwidth no-reply address',
    { from: '\uff4e\uff4f\uff52\uff45\uff50\uff4c\uff59@shop.example' },
    { lane: 'low' },
  ),
  row('zero-width no-reply address', { from: 'no\u200breply@shop.example' }, { lane: 'low' }),
  row('no-reply with doubled separator', { from: 'no--reply@shop.example' }, { lane: 'low' }),
  row('no-reply in a mail subdomain', { from: 'info@mail.noreply.shop.example' }, { lane: 'low' }),
  row(
    'bouncer@ is a person, user replied',
    { from: 'bouncer@club.example', known: true, replied: true },
    { lane: 'do' },
  ),
  row(
    'jane@mailer.example is a person',
    { from: 'jane@mailer.example', known: true },
    { lane: 'do' },
  ),
  row(
    'postmaster@ small business, user replied',
    { from: 'postmaster@smallbiz.example', replied: true },
    { lane: 'do' },
  ),
  row(
    'human at accounts@ asks for payment by Friday',
    { from: 'accounts@vendor.example', text: 'Can you pay invoice 123 by Friday?' },
    { lane: 'do' },
  ),
  row(
    'request is not a closer',
    { ended: true, text: 'Thanks! Please send the signed copy.' },
    { lane: 'do' },
  ),
  row(
    'forged attribution hides nothing',
    { ended: true, text: 'Ok\nOn Tue, Kai wrote:\nCan you send the deck?' },
    { lane: 'do' },
  ),
  row(
    'real quote tail is dropped',
    { ended: true, text: 'Sure!\nOn Tue, Kai wrote:\n> Can you send the deck?' },
    { lane: 'low' },
  ),
  row(
    'list mail, user replied, with a question',
    { listId: '<dev.lists.example>', replied: true, text: 'Can you sign this by Friday?' },
    { lane: 'do' },
  ),
  row(
    'auto-replied is never lifted by a reply',
    { auto: 'auto-replied', replied: true, text: 'Back soon, can you wait?' },
    { lane: 'low' },
  ),
  row('Auto-Submitted: no (human) is a human', { auto: 'no (human)' }, { lane: 'do' }),
  row('Precedence bulk with parameters', { precedence: 'bulk;x' }, { lane: 'low' }),
  row(
    'impossible due date dropped',
    { from: 'noreply@power.example', structured: bill('2026-99-99') },
    { lane: 'update' },
  ),
];
