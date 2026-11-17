import type { Address, FolderRef, StoreWrite, WorkflowFields } from '../../store/port';

/**
 * Aplos's original demo mailbox: two `demo`-provider accounts and 19 threads, one message each plus a
 * provider-side draft reply on `design`. Same cast and content as the in-memory stand-in
 * (`packages/contract-fixture/src/data/demo.ts`), shaped as `store.commit` writes. Every address is on
 * a `.example` domain; no real people, mail or brands. Thread and message remote ids are fixed (`design`,
 * `design-m1`), so `Demo/load` stays a no-op once loaded and `Demo/reset` restores the same contract ids.
 * Times and workflow dates are relative to the load's `now`, on the UTC day.
 */

export interface DemoAccountSpec {
  id: string;
  address: string;
  colorTag: string;
  label: { remoteId: string; name: string };
}

/** The demo's two accounts, in `Demo/load`'s `accountIds` order. Ids are fixed: real ones come from `a<hex>`. */
export const DEMO_ACCOUNTS: readonly DemoAccountSpec[] = [
  {
    id: 'demo-work',
    address: 'alex@studio.example',
    colorTag: 'sky',
    label: { remoteId: 'label-projects', name: 'Projects' },
  },
  {
    id: 'demo-personal',
    address: 'alex@home.example',
    colorTag: 'sand',
    label: { remoteId: 'label-friends', name: 'Friends and family' },
  },
];

export const OWNER_NAME = 'Alex Morgan';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

interface Row {
  /** Remote thread id; the message's is `${key}-m1`. */
  key: string;
  slot: 'work' | 'personal';
  from: Address;
  /** Defaults to the account owner; `to` overrides (the sent thread). */
  to?: Address[];
  subject: string;
  body: string;
  /** Non-INBOX placement: the message's folder list otherwise starts at Inbox while `status` stays `new`. */
  place?: 'sent' | 'archive' | 'trash' | 'spam';
  status?: 'done' | 'later';
  laterInHours?: number;
  reminderInHours?: number;
  dueInDays?: number;
  todo?: string;
  replyStatus?: 'needsReply' | 'awaitingReply';
  bookmarked?: boolean;
  flagged?: boolean;
  important?: boolean;
  label?: boolean;
  seen?: boolean;
  lane?: 'do' | 'update' | 'low';
  importance?: 'important' | 'normal';
  hdr?: { bulk?: boolean; list?: boolean; noreply?: boolean; directToMe?: boolean };
  unsubscribe?: string;
  attachment?: { remotePart: string; name: string; mime: string; size: number };
}

const rows: readonly Row[] = [
  {
    key: 'design',
    slot: 'work',
    from: { name: 'Jordan Park', address: 'jordan@studio.example' },
    subject: 'A quieter home for our project',
    body: 'Hi Alex,\nThe two layout directions are ready for your review. The first gives the story more space; the second puts the weekly plan first. Can you send me your preference by tomorrow?\nJordan',
    dueInDays: 1,
    todo: 'Review the two layout directions',
    replyStatus: 'needsReply',
    label: true,
    lane: 'do',
    importance: 'important',
    hdr: { directToMe: true },
  },
  {
    key: 'review',
    slot: 'work',
    from: { name: 'Theo Kim', address: 'theo@studio.example' },
    subject: 'Friday review: agenda and room',
    body: 'Hi everyone,\nOur project review is Friday at 2 pm in the Oak room. We will spend 20 minutes on the prototype and 10 minutes on next steps. Please bring one question.\nTheo',
    flagged: true,
    important: true,
    bookmarked: true,
    label: true,
    lane: 'do',
    importance: 'normal',
    hdr: { directToMe: true },
  },
  {
    key: 'invoice',
    slot: 'work',
    from: { name: 'Drew Bell', address: 'drew@paperlane.example' },
    subject: 'October illustration invoice',
    body: 'Hi Alex,\nThe October illustrations are complete. Please approve the invoice when you have a moment so we can close out the project. The invoice is attached.\nDrew',
    status: 'later',
    laterInHours: 6,
    dueInDays: -1,
    todo: 'Approve the illustration invoice',
    label: true,
    lane: 'do',
    attachment: {
      remotePart: 'att-invoice',
      name: 'invoice-october.txt',
      mime: 'text/plain',
      size: 129,
    },
  },
  {
    key: 'coffee',
    slot: 'work',
    from: { name: 'Nadia Wells', address: 'nadia@studio.example' },
    subject: 'Coffee and the next chapter',
    body: 'Thanks for the chat this morning. I am checking our calendars and will send two times for next week.\nNadia',
    status: 'done',
    replyStatus: 'awaitingReply',
    seen: true,
    lane: 'update',
    importance: 'normal',
    hdr: { directToMe: true },
  },
  {
    key: 'lunch',
    slot: 'work',
    from: { name: 'Leah Brooks', address: 'leah@studio.example' },
    subject: 'Lunch plans for the new starters',
    body: 'Hi Alex,\nCould you choose somewhere for our welcome lunch? We need a quiet table for six and a couple of vegetarian choices. No rush today.\nLeah',
    status: 'later',
    laterInHours: 22,
    todo: 'Choose a place for team lunch',
    label: true,
    lane: 'do',
    importance: 'normal',
    hdr: { directToMe: true },
  },
  {
    key: 'digest',
    slot: 'work',
    from: { name: 'Weekly Digest', address: 'digest@weekly.example' },
    subject: 'Three ideas for thoughtful teams',
    body: 'This week: make room for quiet work, write decisions down, and finish meetings with one clear next step. Read at your own pace.',
    seen: true,
    lane: 'low',
    importance: 'normal',
    hdr: { bulk: true, list: true, noreply: true },
    unsubscribe: 'https://weekly.example/leave',
  },
  {
    key: 'workshop',
    slot: 'work',
    from: { name: 'Avery Stone', address: 'avery@learning.example' },
    subject: 'Workshop follow-up and resources',
    body: 'Thank you for joining the workshop. Here are the notes: start small, share early, and make the next step visible. I would love to hear how you use the exercises.\nAvery',
    status: 'later',
    laterInHours: 72,
    reminderInHours: 24,
    flagged: true,
    bookmarked: true,
    seen: true,
    lane: 'update',
    importance: 'normal',
  },
  {
    key: 'old',
    slot: 'work',
    from: { name: 'Ellis Gray', address: 'ellis@studio.example' },
    subject: 'Old room booking cancelled',
    body: 'The old room reservation has been cancelled. The updated invitation has the correct room, so you can discard this message.\nEllis',
    place: 'trash',
    seen: true,
    lane: 'update',
    importance: 'normal',
  },
  {
    key: 'sent',
    slot: 'work',
    from: { name: OWNER_NAME, address: 'alex@studio.example' },
    to: [{ name: 'Studio team', address: 'team@studio.example' }],
    subject: 'Thanks for a productive session',
    body: 'Hi team,\nThanks for the thoughtful discussion. I will send the next draft on Thursday. Please add any remaining questions before then.\nAlex',
    place: 'sent',
    status: 'done',
    replyStatus: 'awaitingReply',
    seen: true,
    lane: 'update',
    importance: 'normal',
  },
  {
    key: 'garden',
    slot: 'personal',
    from: { name: 'Maya Chen', address: 'maya@garden.example' },
    subject: 'Saturday in the community garden',
    body: 'Hi Alex,\nWe are gathering at the community garden this Saturday at 10 am. Could you help us plant the herb beds? Bring gloves if you have them. I attached a few notes.\nMaya',
    dueInDays: 2,
    todo: 'Confirm the garden volunteer shift',
    replyStatus: 'needsReply',
    flagged: true,
    important: true,
    bookmarked: true,
    label: true,
    lane: 'do',
    importance: 'important',
    hdr: { directToMe: true },
    attachment: {
      remotePart: 'att-notes',
      name: 'garden-notes.txt',
      mime: 'text/plain',
      size: 88,
    },
  },
  {
    key: 'trip',
    slot: 'personal',
    from: { name: 'Sam Rivera', address: 'sam@friends.example' },
    subject: 'Cabin weekend: a few loose ends',
    body: 'Hello!\nThe cabin is booked. I can bring dinner for Friday if you can organize breakfast. Let me know what works and whether you need a lift.\nSam',
    replyStatus: 'needsReply',
    bookmarked: true,
    label: true,
    lane: 'do',
    importance: 'normal',
    hdr: { directToMe: true },
  },
  {
    key: 'library',
    slot: 'personal',
    from: { name: 'Maple Library', address: 'hello@library.example' },
    subject: 'Your holds are ready to collect',
    body: 'Hello Alex,\nTwo books from your hold list are ready at Maple Library. We will keep them at the front desk until the end of the week.\nSee your holds: https://library.example/account/holds',
    dueInDays: 3,
    todo: 'Collect two books from the library',
    lane: 'update',
    importance: 'normal',
    hdr: { noreply: true, directToMe: true },
  },
  {
    key: 'class',
    slot: 'personal',
    from: { name: 'Rowan Pottery', address: 'classes@pottery.example' },
    subject: 'A place opened in the evening class',
    body: 'Hi Alex,\nA seat has opened in our Tuesday evening pottery class. The six-week course starts next month. Reply if you would like us to reserve it.\nRowan',
    replyStatus: 'needsReply',
    lane: 'do',
    importance: 'normal',
    hdr: { directToMe: true },
  },
  {
    key: 'delivery',
    slot: 'personal',
    from: { name: 'Parcel Trail', address: 'updates@parcel.example' },
    subject: 'Your parcel is on its way',
    body: 'Your order has left our local depot. We expect delivery tomorrow between 10 am and 2 pm. Your tracking reference is DEMO-2408. Follow it at https://parcel.example/track/DEMO-2408',
    lane: 'low',
    importance: 'normal',
    hdr: { bulk: true, noreply: true },
  },
  {
    key: 'receipt',
    slot: 'personal',
    from: { name: 'Cedar Market', address: 'receipts@cedar.example' },
    subject: 'Your market receipt',
    body: 'Thank you for shopping locally. Your total was $28.40. This demonstration receipt does not represent a real transaction.',
    status: 'done',
    seen: true,
    lane: 'low',
    importance: 'normal',
    hdr: { noreply: true },
  },
  {
    key: 'museum',
    slot: 'personal',
    from: { name: 'Mira Patel', address: 'mira@friends.example' },
    subject: 'A museum afternoon next month',
    body: 'The new exhibition looks wonderful. Shall we choose a Sunday afternoon once our calendars settle down?\nMira',
    status: 'done',
    bookmarked: true,
    seen: true,
    label: true,
    lane: 'update',
    importance: 'normal',
    hdr: { directToMe: true },
  },
  {
    key: 'newsletter',
    slot: 'personal',
    from: { name: 'Trail Journal', address: 'hello@trail.example' },
    subject: 'New walks for cooler mornings',
    body: 'The woodland loop is looking beautiful this month. Our latest walking notes include a short route, a hill route, and a cafe stop.',
    status: 'later',
    laterInHours: 96,
    seen: true,
    lane: 'low',
    importance: 'normal',
    hdr: { bulk: true, list: true, noreply: true },
    unsubscribe: 'https://trail.example/leave',
  },
  {
    key: 'spam',
    slot: 'personal',
    from: { name: 'Unknown Offers', address: 'offers@unwanted.example' },
    subject: 'A suspicious prize announcement',
    body: 'This is a synthetic unwanted message used to demonstrate the Spam folder. No links or offers here are real.',
    place: 'spam',
    lane: 'low',
    importance: 'normal',
    hdr: { bulk: true, noreply: true },
  },
  {
    key: 'notes',
    slot: 'personal',
    from: { name: 'Book Nook', address: 'hello@booknook.example' },
    subject: "This month's reading pick",
    body: 'Our pick for October is a quiet novel about a lighthouse keeper and the letters he never sends. The discussion evening is on the last Thursday of the month.',
    place: 'archive',
    seen: true,
    lane: 'update',
    importance: 'normal',
    hdr: { list: true, noreply: true },
  },
];

/** The provider-side draft on `design`: a synced draft is a message with the draft flag in the Drafts folder. */
const DRAFT_BODY =
  'Hi Jordan,\nI like the direction with more room for the story. A few thoughts to follow.\nAlex';

const SYSTEM_FOLDERS = [
  ['INBOX', 'Inbox', 'inbox'],
  ['SENT', 'Sent', 'sent'],
  ['DRAFTS', 'Drafts', 'drafts'],
  ['TRASH', 'Trash', 'trash'],
  ['SPAM', 'Spam', 'spam'],
  ['ARCHIVE', 'Archive', 'archive'],
  ['STARRED', 'Starred', 'starred'],
  ['IMPORTANT', 'Important', 'important'],
  ['ALL', 'All mail', 'all'],
] as const;

function accountOf(slot: Row['slot']): DemoAccountSpec {
  return DEMO_ACCOUNTS[slot === 'work' ? 0 : 1];
}

/** The account and folder writes for one demo account. */
function accountWrites(account: DemoAccountSpec, now: number): StoreWrite[] {
  const folders = SYSTEM_FOLDERS.map(([remoteId, name, role]) => ({
    kind: 'folder' as const,
    accountId: account.id,
    remoteId,
    name,
    role,
    folderKind: 'system' as const,
    syncScope: 'none' as const,
  }));
  return [
    {
      kind: 'account',
      id: account.id,
      provider: 'demo',
      address: account.address,
      displayName: OWNER_NAME,
      capabilities: {
        labels: true,
        folders: true,
        drafts: true,
        serverSearch: false,
        calendar: false,
        filters: false,
        push: false,
        sendAs: false,
        unsubscribeHeaders: true,
        importance: true,
        threading: 'native',
      },
      grantedScopes: [],
      status: { state: 'ok' },
      baselineDoneAt: now,
      calendarListedAt: now,
      aiAllowed: true,
      colorTag: account.colorTag,
      settings: { colorTag: account.colorTag, notifications: true },
    },
    ...folders,
    {
      kind: 'folder',
      accountId: account.id,
      remoteId: account.label.remoteId,
      name: account.label.name,
      folderKind: 'label',
      syncScope: 'none',
    },
  ];
}

/** The message's complete folder set for one row (Gmail labelIds minus UNREAD and STARRED). */
function foldersFor(row: Row, account: DemoAccountSpec): FolderRef[] {
  if (row.place === 'sent') return [{ folder: 'SENT' }];
  const out: string[] = [];
  // A trashed, spammed or archived message, and anything already triaged (done/later), is out of the Inbox.
  if (row.place !== undefined) out.push(row.place.toUpperCase());
  else if (row.status === undefined) out.push('INBOX');
  if (row.important) out.push('IMPORTANT');
  if (row.label) out.push(account.label.remoteId);
  return out.map(folder => ({ folder }));
}

/** `YYYY-MM-DD` `days` from `now`, on the UTC day, plus Home's due band for it (0 due, 1 tomorrow, 2 within 7). */
function due(now: number, days: number): Pick<WorkflowFields, 'dueDate' | 'dueSource' | 'dueBand'> {
  const dueDate = new Date(now + days * DAY).toISOString().slice(0, 10);
  return {
    dueDate,
    dueSource: 'structured',
    dueBand: days <= 0 ? 0 : days === 1 ? 1 : days <= 7 ? 2 : 3,
  };
}

/**
 * When a demo Later item comes back: the day `hours` after `now` lands on, at 9:00 AM local (5:00 PM when 9:00 AM has
 * already passed that day, else 9:00 AM the next day), so nothing "comes back at 2:49 AM" because the demo loaded then.
 */
export function returnTime(now: number, hours: number): number {
  const at = new Date(now + hours * HOUR);
  at.setHours(9, 0, 0, 0);
  if (at.getTime() <= now + HOUR) at.setHours(17);
  if (at.getTime() <= now + HOUR) {
    at.setDate(at.getDate() + 1);
    at.setHours(9);
  }
  return at.getTime();
}

function workflowFor(row: Row, now: number): Partial<WorkflowFields> {
  return {
    ...(row.status !== undefined ? { status: row.status } : {}),
    ...(row.laterInHours !== undefined ? { laterUntil: returnTime(now, row.laterInHours) } : {}),
    ...(row.reminderInHours !== undefined
      ? { reminderAt: returnTime(now, row.reminderInHours) }
      : {}),
    ...(row.todo !== undefined ? { todo: row.todo } : {}),
    ...(row.replyStatus !== undefined ? { replyStatus: row.replyStatus } : {}),
    ...(row.bookmarked !== undefined ? { bookmarked: row.bookmarked } : {}),
    ...(row.dueInDays !== undefined ? due(now, row.dueInDays) : {}),
    lane: row.lane ?? 'do',
    importance: row.importance ?? 'important',
    rankSource: 'heuristic',
    rankedAt: now,
  };
}

/** The writes one row's thread needs: the message, its workflow patch, body and attachment metadata. */
function threadWrites(row: Row, index: number, now: number): StoreWrite[] {
  const account = accountOf(row.slot);
  const remoteId = `${row.key}-m1`;
  const date = now - Math.floor(index / 3) * DAY - (index % 3) * 45 * MIN - 20 * MIN;
  const message = {
    kind: 'message' as const,
    accountId: account.id,
    remoteId,
    remoteThreadId: row.key,
    internetId: `<${row.key}@mail.demo.example>`,
    from: row.from,
    to: row.to ?? [{ name: OWNER_NAME, address: account.address }],
    cc: [],
    subject: row.subject,
    snippet: row.body.replace(/\s+/g, ' ').slice(0, 140),
    date,
    internalDate: date,
    size: row.body.length,
    flags: {
      seen: row.seen ?? false,
      flagged: row.flagged ?? false,
      draft: false,
      fromMe: row.place === 'sent',
    },
    hasAttachments: row.attachment !== undefined,
    hdr: row.hdr,
    ...(row.unsubscribe !== undefined
      ? { listUnsubscribe: { urls: [row.unsubscribe], oneClick: true } }
      : {}),
    folders: foldersFor(row, account),
  };
  const writes: StoreWrite[] = [message];
  writes.push({
    kind: 'workflow',
    accountId: account.id,
    remoteThreadId: row.key,
    patch: workflowFor(row, now),
  });
  writes.push({
    kind: 'body',
    accountId: account.id,
    remoteId,
    body: { text: row.body },
  });
  if (row.attachment)
    writes.push({
      kind: 'attachments',
      accountId: account.id,
      remoteId,
      list: [{ ...row.attachment, inline: false }],
    });
  return writes;
}

/** The draft reply on `design`: a draft-flagged message in DRAFTS, as a provider sync would store it. */
function draftWrites(account: DemoAccountSpec, now: number): StoreWrite[] {
  const date = now - HOUR;
  return [
    {
      kind: 'message',
      accountId: account.id,
      remoteId: 'design-draft',
      remoteThreadId: 'design',
      internetId: '<design-draft@mail.demo.example>',
      inReplyTo: '<design@mail.demo.example>',
      from: { name: OWNER_NAME, address: account.address },
      to: [{ name: 'Jordan Park', address: 'jordan@studio.example' }],
      cc: [],
      subject: 'Re: A quieter home for our project',
      snippet: DRAFT_BODY.replace(/\s+/g, ' ').slice(0, 140),
      date,
      internalDate: date,
      size: DRAFT_BODY.length,
      flags: { seen: true, flagged: false, draft: true, fromMe: true },
      folders: [{ folder: 'DRAFTS' }],
    },
    { kind: 'body', accountId: account.id, remoteId: 'design-draft', body: { text: DRAFT_BODY } },
  ];
}

/** One demo calendar per account: its remote id, name and tag colour (a `TagColor`, so the grid paints it). */
const DEMO_CALENDARS: Record<
  'work' | 'personal',
  { remoteId: string; name: string; color: string }
> = {
  work: { remoteId: 'demo-work-cal', name: 'Studio', color: 'sky' },
  personal: { remoteId: 'demo-personal-cal', name: 'Home', color: 'sand' },
};

interface DemoEvent {
  key: string;
  slot: 'work' | 'personal';
  title: string;
  /** Days after this week's Monday (UTC), so 7 is next Monday. */
  day: number;
  /** UTC hours and minutes; a missing start makes the event all-day. */
  start?: [number, number];
  minutes?: number;
  location?: string;
  guests?: Address[];
}

/** Events across this week and next, so the week on screen is never empty: one all-day, one overlapping pair. */
const demoEvents: readonly DemoEvent[] = [
  { key: 'sync', slot: 'work', title: 'Weekly sync', day: 0, start: [17, 0], minutes: 30 },
  {
    key: 'layout',
    slot: 'work',
    title: 'Layout review',
    day: 2,
    start: [18, 0],
    minutes: 60,
    guests: [{ name: 'Jordan Park', address: 'jordan@studio.example' }],
  },
  { key: 'critique', slot: 'work', title: 'Design critique', day: 3, start: [22, 0], minutes: 60 },
  { key: 'dentist', slot: 'personal', title: 'Dentist', day: 3, start: [22, 30], minutes: 60 },
  {
    key: 'gallery',
    slot: 'personal',
    title: 'Gallery with Mira',
    day: 4,
    start: [19, 0],
    minutes: 120,
    location: 'City gallery',
  },
  { key: 'offsite', slot: 'work', title: 'Planning day', day: 7 },
  { key: 'nadia', slot: 'personal', title: 'Call with Nadia', day: 8, start: [20, 0], minutes: 30 },
  { key: 'review', slot: 'work', title: 'Quarterly review', day: 9, start: [18, 0], minutes: 90 },
  { key: 'sync2', slot: 'work', title: 'Weekly sync', day: 10, start: [17, 0], minutes: 30 },
];

/** The UTC midnight of this week's Monday. */
function mondayStart(now: number): number {
  const today = Math.floor(now / DAY) * DAY;
  return today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
}

function eventWrite(event: DemoEvent, account: DemoAccountSpec, now: number): StoreWrite {
  const day = mondayStart(now) + event.day * DAY;
  const at = event.start;
  const allDay = at === undefined;
  const start = at === undefined ? day : day + at[0] * HOUR + at[1] * MIN;
  const end = allDay ? day + DAY : start + (event.minutes ?? 60) * MIN;
  const date = (t: number) => new Date(t).toISOString().slice(0, 10);
  const stamp = (t: number) => ({ dateTime: new Date(t).toISOString() });
  const data = {
    summary: event.title,
    status: 'confirmed',
    start: allDay ? { date: date(start) } : stamp(start),
    end: allDay ? { date: date(end) } : stamp(end),
    ...(event.location ? { location: event.location } : {}),
    organizer: { email: account.address, displayName: OWNER_NAME, self: true },
    attendees: [
      { email: account.address, displayName: OWNER_NAME, self: true, responseStatus: 'accepted' },
      ...(event.guests ?? []).map(g => ({
        email: g.address,
        displayName: g.name,
        responseStatus: 'accepted',
      })),
    ],
  };
  return {
    kind: 'event',
    accountId: account.id,
    calendarRemoteId: DEMO_CALENDARS[event.slot].remoteId,
    remoteId: `demo-ev-${event.key}`,
    rows: [
      {
        status: 'confirmed',
        startUtc: start,
        endUtc: end,
        allDay,
        data: JSON.stringify(data),
      },
    ],
  };
}

/** A read-only calendar per account (the demo has no provider to write to) and the sample events on them. */
function calendarWrites(now: number): StoreWrite[] {
  const writes: StoreWrite[] = DEMO_ACCOUNTS.map((account, index) => {
    const calendar = DEMO_CALENDARS[index === 0 ? 'work' : 'personal'];
    return {
      kind: 'calendar',
      accountId: account.id,
      remoteId: calendar.remoteId,
      name: calendar.name,
      color: calendar.color,
      primary: true,
      hidden: false,
      selected: true,
      readOnly: true,
    };
  });
  for (const event of demoEvents)
    writes.push(
      eventWrite(event, DEMO_ACCOUNTS[event.slot === 'work' ? 0 : 1] as DemoAccountSpec, now),
    );
  return writes;
}

/** The whole demo mailbox as one commit's writes: accounts and folders first, then every thread. */
export function demoWrites(now: number): StoreWrite[] {
  const writes = DEMO_ACCOUNTS.flatMap(account => accountWrites(account, now));
  rows.forEach((row, index) => writes.push(...threadWrites(row, index, now)));
  writes.push(...draftWrites(DEMO_ACCOUNTS[0], now));
  writes.push(...calendarWrites(now));
  return writes;
}
