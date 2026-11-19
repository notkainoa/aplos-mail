import { FakeClock, type Clock } from '../kit/clock';
import { Mailbox, type MessageSpec } from './mailbox';
import { Random, mixSeed } from './rng';

/**
 * Deterministic synthetic mail. Every name, organisation, subject and sentence below is invented;
 * all addresses end in `.example.test`. The same seed always yields the same mailbox.
 */
const FIRST = [
  'Maren',
  'Tobias',
  'Ines',
  'Callum',
  'Priya',
  'Joaquin',
  'Linnea',
  'Dmitri',
  'Odessa',
  'Rafferty',
  'Noor',
  'Bastien',
  'Willa',
  'Kofi',
  'Saskia',
  'Emrys',
];
const LAST = [
  'Ashgrove',
  'Valdry',
  'Pennick',
  'Okonjo',
  'Thistlewood',
  'Marquand',
  'Halloran',
  'Brandvold',
  'Kestrel',
  'Lindqvist',
];
const ORGS = [
  'Lanternworks',
  'Brightwell Cooperative',
  'Quillon Labs',
  'Harbor Lane Bakery',
  'Northfield Transit',
  'Pinecrest Studio',
  'Oakmere Library',
  'Tidewater Market',
];
const TOPICS = [
  'the garden schedule',
  'next quarter plans',
  'the workshop agenda',
  'the shared calendar',
  'our reading list',
  'the trip itinerary',
  'the budget draft',
  'volunteer rotas',
];
const OPENERS = [
  'Thanks for the note.',
  'Quick follow-up from earlier.',
  'Sorry for the slow reply.',
  'Looping back on this.',
  'One more thing before the weekend.',
];
const MIDDLES = [
  'I moved the meeting to Thursday afternoon, which should leave more room for questions.',
  'The draft is in the shared folder and I left comments on the second page.',
  'Could you check the numbers once more before we send them on?',
  'I will bring printed copies so nobody has to hunt for a link.',
  'Nothing urgent here, just keeping everyone in the loop.',
];
const CLOSERS = ['Talk soon.', 'Let me know what works.', 'Best wishes.', 'Many thanks.'];
const HEADLINES = [
  'Five small ideas for your week',
  'New arrivals and a few favourites',
  'What we are reading this month',
  'Seasonal notes from the studio',
  'A short update from the team',
];

type Kind =
  | 'conversation'
  | 'newsletter'
  | 'social'
  | 'updates'
  | 'sent'
  | 'archived'
  | 'trash'
  | 'spam'
  | 'draft';
const KINDS: readonly Kind[] = [
  'conversation',
  'newsletter',
  'social',
  'updates',
  'sent',
  'archived',
  'trash',
  'spam',
  'draft',
];
const KIND_WEIGHTS: (readonly [Kind, number])[] = [
  ['conversation', 30],
  ['newsletter', 20],
  ['social', 8],
  ['updates', 12],
  ['sent', 8],
  ['archived', 10],
  ['trash', 4],
  ['spam', 4],
  ['draft', 4],
];

export interface GenerateOptions {
  threads: number;
  seed?: number;
  /** "Now" for the newest messages; defaults to the mailbox clock. */
  now?: number;
}

export interface GenerateMailboxOptions extends GenerateOptions {
  clock?: Clock;
  emailAddress?: string;
}

interface Person {
  name: string;
  address: string;
}

/**
 * When the next message of a thread arrives. Replies come 10 minutes to 2 days apart, but never
 * past `now`: the gap shrinks so the `remaining` messages still to come all fit before it. Clamping
 * to `now` instead would stack many threads on the same instant at the top of the list.
 */
function nextReplyAt(at: number, remaining: number, now: number, random: Random): number {
  const wanted = random.int(10 * 60_000, 2 * 86400_000);
  const room = Math.floor((now - 60_000 - at) / remaining);
  return at + Math.max(1000, Math.min(wanted, room));
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Fills `mailbox` with `threads` threads, then clears history so the result is the starting state. */
export function generateInto(mailbox: Mailbox, options: GenerateOptions & { clock: Clock }): void {
  const random = new Random(mixSeed(options.seed ?? 1, 0x6d));
  const now = options.now ?? options.clock.now();
  const userLabels = ['Projects', 'Receipts', 'Team Notes'].map(
    name => mailbox.labelIdByName(name) ?? mailbox.createLabel(name).id,
  );
  const own: Person = { name: 'Test User', address: mailbox.emailAddress };

  const person = (): Person => {
    const first = random.pick(FIRST);
    const last = random.pick(LAST);
    return { name: `${first} ${last}`, address: `${slug(first)}.${slug(last)}@mail.example.test` };
  };
  const org = (): Person => {
    const name = random.pick(ORGS);
    return { name, address: `hello@${slug(name)}.example.test` };
  };
  const formatted = (p: Person): string => `${p.name} <${p.address}>`;
  const paragraph = (): string =>
    `${random.pick(OPENERS)} ${random.pick(MIDDLES)} ${random.pick(CLOSERS)}`;
  const topic = (): string => random.pick(TOPICS);

  for (let index = 0; index < options.threads; index++) {
    // The first pass visits every kind once so even small mailboxes show the whole mix.
    const kind = index < KINDS.length ? KINDS[index] : random.weighted(KIND_WEIGHTS);
    const ageMs = Math.floor(Math.pow(random.float(), 2) * 60 * 86400_000) + 5 * 60_000;
    let at = now - ageMs;
    const labelBase: string[] = [];
    const extra: Pick<MessageSpec, 'headers' | 'html' | 'attachments' | 'htmlAsAttachment'> = {};
    let count = 1;
    const subject = (): string => {
      switch (kind) {
        case 'newsletter':
          return random.pick(HEADLINES);
        case 'social':
          return `${person().name} mentioned you in a comment`;
        case 'updates':
          return `Your receipt from ${random.pick(ORGS)}`;
        default:
          return `Notes on ${topic()}`;
      }
    };
    const title = subject();
    let counterpart: Person = person();

    switch (kind) {
      case 'conversation':
      case 'archived':
        count = random.weighted([
          [1, 3],
          [2, 4],
          [3, 3],
          [4, 2],
          [5, 1],
          [6, 1],
        ]);
        break;
      case 'newsletter': {
        counterpart = org();
        const promo = random.chance(0.6);
        labelBase.push(promo ? 'CATEGORY_PROMOTIONS' : 'CATEGORY_UPDATES');
        extra.headers = {
          'List-Unsubscribe': `<mailto:unsubscribe@${counterpart.address.split('@')[1]}>, <https://links.example.test/u/${random.hex(10)}>`,
          Precedence: 'bulk',
          ...(random.chance(0.5) ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}),
        };
        extra.htmlAsAttachment = random.chance(0.2);
        break;
      }
      case 'social':
        counterpart = org();
        labelBase.push('CATEGORY_SOCIAL');
        count = random.int(1, 2);
        break;
      case 'updates':
        counterpart = org();
        labelBase.push('CATEGORY_UPDATES');
        extra.headers = random.chance(0.6) ? { 'Auto-Submitted': 'auto-generated' } : {};
        if (random.chance(0.3))
          extra.attachments = [
            {
              filename: 'receipt.pdf',
              mimeType: 'application/pdf',
              data: Buffer.from(`%PDF-1.4 synthetic receipt ${random.hex(12)}`),
            },
          ];
        break;
      case 'draft':
        count = random.int(1, 2);
        break;
      default:
        break;
    }

    let first: string | undefined;
    for (let n = 0; n < count; n++) {
      const fromContact =
        kind === 'sent'
          ? false
          : kind === 'conversation' || kind === 'archived' || kind === 'draft'
            ? n % 2 === 0
            : true;
      const sender = fromContact ? counterpart : own;
      const recipients = fromContact ? [own] : [counterpart];
      const labelIds = fromContact ? [...labelBase] : ['SENT'];
      if (fromContact) {
        if (kind === 'trash') labelIds.push('TRASH');
        else if (kind === 'spam') labelIds.push('SPAM');
        else if (kind !== 'archived') labelIds.push('INBOX');
      }
      const last = n === count - 1;
      if (fromContact && last && labelIds.includes('INBOX') && random.chance(0.4))
        labelIds.push('UNREAD');
      if (fromContact && labelIds.includes('INBOX') && kind === 'conversation') {
        if (random.chance(0.35)) labelIds.push('IMPORTANT');
        if (last && random.chance(0.1)) labelIds.push('STARRED');
      }
      if (last && kind !== 'trash' && kind !== 'spam' && random.chance(0.25))
        labelIds.push(random.pick(userLabels));
      const text = `${paragraph()}\n\n${paragraph()}`;
      const html =
        kind === 'newsletter' || kind === 'social' || kind === 'spam'
          ? `<html><body><h1>${title}</h1><p>${paragraph()}</p><p><a href="https://links.example.test/read/${random.hex(8)}">Read more</a></p></body></html>`
          : undefined;
      const message = mailbox.addMessage({
        from: formatted(sender),
        to: recipients.map(formatted),
        subject: n === 0 ? title : `Re: ${title}`,
        text,
        html,
        labelIds,
        threadId: first,
        internalDate: at,
        ...extra,
        // Replies carry an In-Reply-To via the thread; only the first message carries list headers.
        headers: n === 0 ? extra.headers : undefined,
        attachments: n === 0 ? extra.attachments : undefined,
      });
      first ??= message.threadId;
      at = nextReplyAt(at, count - n, now, random);
    }
    if (kind === 'draft') {
      mailbox.createDraftElsewhere({
        to: [counterpart.address],
        subject: `Re: ${title}`,
        text: `${paragraph()}`,
        threadId: first,
        internalDate: at,
      });
    }
  }
  mailbox.history.clear();
}

/** A new standalone mailbox filled with synthetic mail. */
export function generateMailbox(options: GenerateMailboxOptions): Mailbox {
  const clock = options.clock ?? new FakeClock({ auto: false });
  const mailbox = new Mailbox({
    clock,
    emailAddress: options.emailAddress ?? 'test.user@example.test',
    seed: options.seed ?? 1,
  });
  generateInto(mailbox, { ...options, clock });
  return mailbox;
}
