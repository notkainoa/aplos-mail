import type {
  Account,
  Calendar,
  Draft,
  Event,
  Folder,
  Message,
  Plan,
  SuggestedAction,
  ThreadRow,
} from '@aplos/contract';
import { addDays, atLocal, dueBand, localDay, weekday } from '../time';
import { demoCalendars } from './demo-calendar';

/**
 * The `demo` scenario's content: Aplos's own original demo mailbox (`packages/engine/src/legacy/demo.ts`), adapted to the
 * v1 types. No real people, mail or addresses: every domain is `.example`. Times are relative to the engine clock.
 */

export interface Dataset {
  accounts: Account[];
  folders: Folder[];
  threads: ThreadRow[];
  messages: Message[];
  /** Message id → plain-text body. */
  bodies: Record<string, string>;
  /** Attachment id → bytes. */
  files: Record<string, { bytes: Bytes; mime: string; name: string }>;
  calendars: Calendar[];
  events: Event[];
  plans: Plan[];
  drafts: Draft[];
}

export const demoAccountIds = { work: 'demo-work', personal: 'demo-personal' } as const;
type Slot = keyof typeof demoAccountIds;

const day = 86_400_000;
type AttachmentMeta = Message['attachments'][number];
export type Bytes = Uint8Array<ArrayBuffer>;

export function demoAccount(
  id: string,
  slot: Slot,
  now: number,
  extra: Partial<Account> = {},
): Account {
  const address = slot === 'work' ? 'alex@studio.example' : 'alex@home.example';
  return {
    id,
    rev: 1,
    provider: 'demo',
    address,
    name: 'Alex Morgan',
    colorTag: slot === 'work' ? 'sage' : 'clay',
    demo: true,
    health: { status: { state: 'ok' }, lastSyncAt: now },
    capabilities: {
      labels: true,
      folders: false,
      drafts: true,
      serverSearch: false,
      calendar: true,
      filters: false,
      push: false,
      sendAs: false,
      unsubscribeHeaders: true,
      importance: true,
    },
    grantedScopes: [],
    aiAllowed: true,
    notifications: true,
    lease: { role: 'primary', holderDeviceId: 'fixture-device', holderDeviceName: 'Fixture Mac' },
    identities: [{ address, name: 'Alex Morgan', default: true }],
    baselineDoneAt: now - 30 * day,
    // The calendar list was read long ago (the demo has calendars): "No calendars" and "Syncing…" are told apart by this.
    calendarListedAt: now - 30 * day,
    createdAt: now - 30 * day,
    pendingChanges: 0,
    ...extra,
  };
}

function bytesOf(base64: string): Bytes {
  const raw = atob(base64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

const files: Record<
  string,
  { id: string; name: string; mime: string; base64: string } | undefined
> = {
  garden: {
    id: 'att-notes',
    name: 'garden-notes.txt',
    mime: 'text/plain',
    base64:
      'Q29tbXVuaXR5IGdhcmRlbiBwbGFubmluZwpCcmluZyBnbG92ZXMsIGEgd2F0ZXIgYm90dGxlLCBhbmQgaWRlYXMgZm9yIHRoZSBoZXJiIGJlZHMuCg==',
  },
  invoice: {
    id: 'att-invoice',
    name: 'invoice-october.txt',
    mime: 'text/plain',
    base64:
      'UGFwZXIgTGFuZSBpbGx1c3RyYXRpb24gaW52b2ljZSAoZGVtbykKT2N0b2JlciBpbGx1c3RyYXRpb25zOiA2IHBpZWNlcywgJDEsMjAwLjAwClRoaXMgZGVtb25zdHJhdGlvbiBpbnZvaWNlIGlzIG5vdCBhIHJlYWwgYmlsbC4K',
  },
};

interface Row {
  key: string;
  slot: Slot;
  fromName: string;
  from: string;
  subject: string;
  lane: 'do' | 'update' | 'low';
  importance?: 'important' | 'normal';
  status?: 'new' | 'done' | 'later';
  place?: 'trash' | 'spam';
  laterUntil?: (now: number, today: string, zone: string) => number | undefined;
  todo?: string;
  due?: number;
  replyStatus?: 'needsReply' | 'awaitingReply';
  bookmarked?: boolean;
  reminder?: (today: string, zone: string) => number;
  action?: SuggestedAction;
  unread?: boolean;
  unsubscribe?: boolean;
  fromMe?: boolean;
  label?: string;
  body: string;
  summary: string;
}

const rows: Row[] = [
  {
    key: 'garden',
    slot: 'personal',
    fromName: 'Maya Chen',
    from: 'maya@garden.example',
    subject: 'Saturday in the community garden',
    lane: 'do',
    todo: 'Confirm the garden volunteer shift',
    due: 2,
    replyStatus: 'needsReply',
    bookmarked: true,
    action: { kind: 'calendar', label: 'Add to calendar' },
    label: 'friends',
    body: 'Hi Alex,\nWe are gathering at the community garden this Saturday at 10 am. Could you help us plant the herb beds? Bring gloves if you have them. I attached a few notes.\nMaya',
    summary: 'Help plant the herb beds Saturday at 10 am, bring gloves',
  },
  {
    key: 'design',
    slot: 'work',
    fromName: 'Jordan Park',
    from: 'jordan@studio.example',
    subject: 'A quieter home for our project',
    lane: 'do',
    todo: 'Review the two layout directions',
    due: 1,
    replyStatus: 'needsReply',
    action: { kind: 'reply', label: 'Reply', prompt: 'Say which layout direction you prefer' },
    label: 'projects',
    body: 'Hi Alex,\nThe two layout directions are ready for your review. The first gives the story more space; the second puts the weekly plan first. Can you send me your preference by tomorrow?\nJordan',
    summary: 'Two layout directions ready, wants your preference by tomorrow',
  },
  {
    key: 'trip',
    slot: 'personal',
    fromName: 'Sam Rivera',
    from: 'sam@friends.example',
    subject: 'Cabin weekend: a few loose ends',
    lane: 'do',
    importance: 'normal',
    replyStatus: 'needsReply',
    bookmarked: true,
    action: {
      kind: 'reply',
      label: 'Reply',
      prompt: 'Offer to organize breakfast and say whether you need a lift',
    },
    label: 'friends',
    body: 'Hello!\nThe cabin is booked. I can bring dinner for Friday if you can organize breakfast. Let me know what works and whether you need a lift.\nSam',
    summary: 'Cabin booked; Sam brings Friday dinner, you sort out breakfast',
  },
  {
    key: 'invoice',
    slot: 'work',
    fromName: 'Drew Bell',
    from: 'drew@paperlane.example',
    subject: 'October illustration invoice',
    lane: 'do',
    todo: 'Approve the illustration invoice',
    due: -1,
    status: 'later',
    laterUntil: now => now - 2 * 3_600_000,
    action: { kind: 'attachment', label: 'View invoice', attachmentId: 'att-invoice' },
    label: 'projects',
    body: 'Hi Alex,\nThe October illustrations are complete. Please approve the invoice when you have a moment so we can close out the project. The invoice is attached.\nDrew',
    summary: 'October illustrations finished, approve the invoice to close out',
  },
  {
    key: 'coffee',
    slot: 'work',
    fromName: 'Nadia Wells',
    from: 'nadia@studio.example',
    subject: 'Coffee and the next chapter',
    lane: 'update',
    importance: 'normal',
    replyStatus: 'awaitingReply',
    status: 'done',
    body: 'Thanks for the chat this morning. I am checking our calendars and will send two times for next week.\nNadia',
    summary: 'Sending two meeting times for next week',
  },
  {
    key: 'library',
    slot: 'personal',
    fromName: 'Maple Library',
    from: 'hello@library.example',
    subject: 'Your holds are ready to collect',
    lane: 'update',
    todo: 'Collect two books from the library',
    due: 3,
    action: { kind: 'link', label: 'View holds', url: 'https://library.example/account/holds' },
    body: 'Hello Alex,\nTwo books from your hold list are ready at Maple Library. We will keep them at the front desk until the end of the week.\nSee your holds: https://library.example/account/holds',
    summary: 'Two holds waiting at the front desk until the end of the week',
  },
  {
    key: 'review',
    slot: 'work',
    fromName: 'Theo Kim',
    from: 'theo@studio.example',
    subject: 'Friday review: agenda and room',
    lane: 'do',
    importance: 'normal',
    bookmarked: true,
    action: { kind: 'calendar', label: 'Add to calendar' },
    label: 'projects',
    body: 'Hi everyone,\nOur project review is Friday at 2 pm in the Oak room. We will spend 20 minutes on the prototype and 10 minutes on next steps. Please bring one question.\nTheo',
    summary: 'Project review Friday at 2 pm in the Oak room, bring one question',
  },
  {
    key: 'class',
    slot: 'personal',
    fromName: 'Rowan Pottery',
    from: 'classes@pottery.example',
    subject: 'A place opened in the evening class',
    lane: 'do',
    importance: 'normal',
    replyStatus: 'needsReply',
    action: {
      kind: 'reply',
      label: 'Reserve seat',
      prompt: 'Ask them to reserve the seat in the Tuesday class',
    },
    body: 'Hi Alex,\nA seat has opened in our Tuesday evening pottery class. The six-week course starts next month. Reply if you would like us to reserve it.\nRowan',
    summary: 'A seat opened in the Tuesday evening class, reply to reserve it',
  },
  {
    key: 'lunch',
    slot: 'work',
    fromName: 'Leah Brooks',
    from: 'leah@studio.example',
    subject: 'Lunch plans for the new starters',
    lane: 'do',
    importance: 'normal',
    status: 'later',
    laterUntil: (_now, today, zone) => atLocal(addDays(today, 1), 8, 0, zone),
    todo: 'Choose a place for team lunch',
    action: {
      kind: 'reply',
      label: 'Suggest a place',
      prompt: 'Suggest a quiet lunch spot for six with vegetarian choices',
    },
    body: 'Hi Alex,\nCould you choose somewhere for our welcome lunch? We need a quiet table for six and a couple of vegetarian choices. No rush today.\nLeah',
    summary: 'Pick a quiet lunch spot for six with vegetarian choices',
  },
  {
    key: 'delivery',
    slot: 'personal',
    fromName: 'Parcel Trail',
    from: 'updates@parcel.example',
    subject: 'Your parcel is on its way',
    lane: 'low',
    importance: 'normal',
    action: { kind: 'link', label: 'Track parcel', url: 'https://parcel.example/track/DEMO-2408' },
    body: 'Your order has left our local depot. We expect delivery tomorrow between 10 am and 2 pm. Your tracking reference is DEMO-2408. Follow it at https://parcel.example/track/DEMO-2408',
    summary: 'Parcel arrives tomorrow between 10 am and 2 pm',
  },
  {
    key: 'digest',
    slot: 'work',
    fromName: 'Field Notes',
    from: 'digest@fieldnotes.example',
    subject: 'Three ideas for thoughtful teams',
    lane: 'low',
    importance: 'normal',
    unsubscribe: true,
    body: 'This week: make room for quiet work, write decisions down, and finish meetings with one clear next step. Read at your own pace.',
    summary: 'Three team habits: quiet work, written decisions, clear next steps',
  },
  {
    key: 'receipt',
    slot: 'personal',
    fromName: 'Cedar Market',
    from: 'receipts@cedar.example',
    subject: 'Your market receipt',
    lane: 'low',
    importance: 'normal',
    status: 'done',
    body: 'Thank you for shopping locally. Your total was $28.40. This demonstration receipt does not represent a real transaction.',
    summary: '$28.40 receipt for your order',
  },
  {
    key: 'workshop',
    slot: 'work',
    fromName: 'Avery Stone',
    from: 'avery@learning.example',
    subject: 'Workshop follow-up and resources',
    lane: 'update',
    importance: 'normal',
    status: 'later',
    laterUntil: (_now, today, zone) => atLocal(addDays(today, 3), 8, 0, zone),
    bookmarked: true,
    reminder: (today, zone) => atLocal(addDays(today, 1), 9, 0, zone),
    action: { kind: 'read', label: 'Read notes' },
    body: 'Thank you for joining the workshop. Here are the notes: start small, share early, and make the next step visible. I would love to hear how you use the exercises.\nAvery',
    summary: 'Workshop notes shared, wants to hear how the exercises go',
  },
  {
    key: 'museum',
    slot: 'personal',
    fromName: 'Mira Patel',
    from: 'mira@friends.example',
    subject: 'A museum afternoon next month',
    lane: 'update',
    importance: 'normal',
    status: 'done',
    bookmarked: true,
    label: 'friends',
    body: 'The new exhibition looks wonderful. Shall we choose a Sunday afternoon once our calendars settle down?\nMira',
    summary: 'Suggests a Sunday afternoon at the new exhibition',
  },
  {
    key: 'newsletter',
    slot: 'personal',
    fromName: 'Trail Journal',
    from: 'hello@trail.example',
    subject: 'New walks for cooler mornings',
    lane: 'low',
    importance: 'normal',
    status: 'later',
    unsubscribe: true,
    body: 'The woodland loop is looking beautiful this month. Our latest walking notes include a short route, a hill route, and a cafe stop.',
    summary: 'New autumn walks: a short loop, a hill route and a cafe stop',
  },
  {
    key: 'old',
    slot: 'work',
    fromName: 'Ellis Gray',
    from: 'ellis@studio.example',
    subject: 'Old room booking cancelled',
    lane: 'update',
    importance: 'normal',
    place: 'trash',
    unread: false,
    body: 'The old room reservation has been cancelled. The updated invitation has the correct room, so you can discard this message.\nEllis',
    summary: 'Old room booking cancelled; the updated invitation has the right room',
  },
  {
    key: 'spam',
    slot: 'personal',
    fromName: 'Unknown Offers',
    from: 'offers@unwanted.example',
    subject: 'A suspicious prize announcement',
    lane: 'low',
    importance: 'normal',
    place: 'spam',
    body: 'This is a synthetic unwanted message used to demonstrate the Spam folder. No links or offers here are real.',
    summary: 'Unsolicited prize announcement',
  },
  {
    key: 'sent',
    slot: 'work',
    fromName: 'Alex Morgan',
    from: 'alex@studio.example',
    subject: 'Thanks for a productive session',
    lane: 'update',
    importance: 'normal',
    status: 'done',
    replyStatus: 'awaitingReply',
    unread: false,
    fromMe: true,
    body: 'Hi team,\nThanks for the thoughtful discussion. I will send the next draft on Thursday. Please add any remaining questions before then.\nAlex',
    summary: 'Thanked the team and promised the next draft on Thursday',
  },
];

const labelNames: Record<string, string> = { projects: 'Projects', friends: 'Friends and family' };

/** System folders plus the demo's own labels, for one account. */
export function foldersFor(accountId: string): Folder[] {
  const system = [
    ['INBOX', 'Inbox', 'inbox'],
    ['SENT', 'Sent', 'sent'],
    ['DRAFTS', 'Drafts', 'drafts'],
    ['TRASH', 'Trash', 'trash'],
    ['SPAM', 'Spam', 'spam'],
    ['STARRED', 'Starred', 'starred'],
    ['IMPORTANT', 'Important', 'important'],
    ['ALL', 'All mail', 'all'],
  ] as const;
  return [
    ...system.map(([id, name, role]) => ({
      id: `${accountId}:${id}`,
      accountId,
      name,
      role,
      kind: 'system' as const,
      hidden: false,
      unread: 0,
    })),
    ...Object.entries(labelNames).map(([id, name]) => ({
      id: `${accountId}:label-${id}`,
      accountId,
      name,
      kind: 'label' as const,
      hidden: false,
      colorTag: id === 'projects' ? 'slate' : 'ochre',
      unread: 0,
    })),
  ];
}

/** The system and label folder ids one demo row's message and thread carry. */
function labelsFor(row: Row, accountId: string, status: 'new' | 'done' | 'later'): string[] {
  return [
    ...(row.place === 'trash'
      ? ['TRASH']
      : row.place === 'spam'
        ? ['SPAM']
        : status === 'new'
          ? ['INBOX']
          : []),
    ...(row.fromMe ? ['SENT'] : []),
    ...((row.importance ?? 'important') === 'important' ? ['IMPORTANT'] : []),
  ]
    .map(l => `${accountId}:${l}`)
    .concat(row.label ? [`${accountId}:label-${row.label}`] : []);
}

/** A demo thread's workflow sub-object: status, later, done, due, todo and reminder, as the row sets them. */
function workflowFor(
  row: Row,
  status: 'new' | 'done' | 'later',
  ctx: { now: number; today: string; date: number; dueDate?: string; zone: string },
) {
  return {
    status,
    bookmarked: !!row.bookmarked,
    hiddenFromHome: false,
    replyStatus: row.replyStatus ?? 'none',
    ...(row.laterUntil ? { laterUntil: row.laterUntil(ctx.now, ctx.today, ctx.zone) } : {}),
    ...(status === 'done' ? { doneAt: ctx.date + 3_600_000 } : {}),
    ...(ctx.dueDate ? { dueDate: ctx.dueDate, dueSource: 'ai' as const } : {}),
    ...(row.todo ? { todo: row.todo } : {}),
    ...(row.reminder ? { reminderAt: row.reminder(ctx.today, ctx.zone) } : {}),
  };
}

/**
 * Builds the demo mailbox. `accounts` maps the work and personal slots to account ids; a practice account passes the
 * same id for both, and gets the whole mailbox under one address.
 */
export function demoData(
  now: number,
  zone: string,
  accounts: Record<Slot, string> = demoAccountIds,
): Dataset {
  const today = localDay(now, zone);
  const out: Dataset = {
    accounts: [],
    folders: [],
    threads: [],
    messages: [],
    bodies: {},
    files: {},
    calendars: [],
    events: [],
    plans: [],
    drafts: [],
  };
  const accountIds = [...new Set(Object.values(accounts))];
  if (accounts.work !== accounts.personal)
    out.accounts.push(
      demoAccount(accounts.work, 'work', now),
      demoAccount(accounts.personal, 'personal', now),
    );
  for (const id of accountIds) out.folders.push(...foldersFor(id));

  rows.forEach((row, index) => {
    const accountId = accounts[row.slot];
    const me = {
      name: 'Alex Morgan',
      address: row.slot === 'work' ? 'alex@studio.example' : 'alex@home.example',
    };
    const id = `${accountId}:${row.key}`;
    const messageId = `${id}.m1`;
    const date = now - Math.floor(index / 3) * day - (index % 3) * 45 * 60_000 - 20 * 60_000;
    const unread = row.unread ?? index < 8;
    const status = row.status ?? 'new';
    const file = files[row.key];
    const attachments: AttachmentMeta[] = file
      ? [
          {
            id: file.id,
            name: file.name,
            mime: file.mime,
            size: bytesOf(file.base64).length,
            inline: false,
            state: 'present',
          },
        ]
      : [];
    if (file)
      out.files[`${messageId}/${file.id}`] = {
        bytes: bytesOf(file.base64),
        mime: file.mime,
        name: file.name,
      };
    const labels = labelsFor(row, accountId, status);
    const dueDate = row.due === undefined ? undefined : addDays(today, row.due);
    const snippet = row.body.replace(/\s+/g, ' ').slice(0, 140);
    out.threads.push({
      id,
      accountId,
      rev: 1,
      subject: row.subject,
      snippet,
      fromName: row.fromName,
      participants: row.fromMe
        ? [
            { ...me, me: true },
            { name: 'Studio team', address: 'team@studio.example' },
          ]
        : [
            { name: row.fromName, address: row.from },
            { ...me, me: true },
          ],
      lastDate: date,
      ...(row.fromMe ? {} : { lastInboundDate: date }),
      messageCount: 1,
      unreadCount: unread ? 1 : 0,
      partial: false,
      unread,
      flagged: false,
      hasAttachments: attachments.length > 0,
      labels,
      workflow: workflowFor(row, status, { now, today, date, dueDate, zone }),
      rank: {
        lane: row.lane,
        importance: row.importance ?? 'important',
        source: 'ai',
        dueBand: dueBand(dueDate, today),
        rankedAt: date,
      },
      summary: {
        state: 'ready',
        text: row.summary,
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        ...(row.action ? { action: row.action } : {}),
      },
      unsubscribe: !!row.unsubscribe,
      fromLater: false,
      ...(row.fromMe ? { follow: { since: date } } : {}),
    });
    out.messages.push({
      id: messageId,
      threadId: id,
      accountId,
      rev: 1,
      internetId: `<${row.key}.${accountId}@demo.example>`,
      from: row.fromMe ? me : { address: row.from, name: row.fromName },
      to: row.fromMe ? [{ address: 'team@studio.example', name: 'Studio team' }] : [me],
      cc: [],
      subject: row.subject,
      snippet,
      date,
      seen: !unread,
      flagged: false,
      answered: false,
      fromMe: !!row.fromMe,
      labels,
      attachments,
      bodyState: 'present',
      bodyKind: 'html',
      notification: !row.fromMe && unread ? 'sent' : 'none',
    });
    out.bodies[messageId] = row.body;
  });

  for (const t of out.threads)
    if (t.id.endsWith(':review')) t.eventId = `${accounts.work}:ev-review`;

  const { calendars, events } = demoCalendars(accounts, today, zone);
  out.calendars.push(...calendars);
  out.events.push(...events);

  const weekStart = addDays(today, -weekday(today));
  const saturday = addDays(weekStart, 6 + (weekday(today) === 6 ? 7 : 0));
  out.plans.push({
    id: `${accounts.personal}:plan-garden`,
    rev: 1,
    threadId: `${accounts.personal}:garden`,
    messageId: `${accounts.personal}:garden.m1`,
    fromName: 'Maya Chen',
    quote: 'We are gathering at the community garden this Saturday at 10 am.',
    title: 'Plant the herb beds at the community garden',
    start: { type: 'utc', utc: atLocal(saturday, 10, 0, zone) },
    end: { type: 'utc', utc: atLocal(saturday, 12, 0, zone) },
    allDay: false,
    timeZone: zone,
    location: 'Community garden',
    state: 'open',
  });

  out.drafts.push({
    id: `${accounts.work}:draft-welcome`,
    rev: 1,
    revision: 1,
    accountId: accounts.work,
    mode: 'reply',
    threadId: `${accounts.work}:design`,
    replyToMessageId: `${accounts.work}:design.m1`,
    to: [{ address: 'jordan@studio.example', name: 'Jordan Park' }],
    cc: [],
    bcc: [],
    subject: 'Re: A quieter home for our project',
    html: '<p>Hi Jordan,</p><p>I like the direction with more room for the story. A few thoughts to follow.</p>',
    attachments: [],
    signature: false,
    updatedAt: now - 3_600_000,
    origin: 'local',
    sync: 'localOnly',
  });
  return out;
}
