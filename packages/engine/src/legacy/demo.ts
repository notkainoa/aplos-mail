import type {
  AppState,
  Attachment,
  CalendarEvent,
  CalendarInfo,
  Settings,
  Thread,
} from '@aplos/contract/legacy/types';
import { aiFeature, defaultAskModel } from '@aplos/contract/legacy/ask';

export const defaultSettings: Settings = {
  theme: 'system',
  zen: false,
  sidebar: true,
  sidebarStyle: 'normal',
  triageDirection: 'done-right',
  swipe: true,
  doneAction: 'archive',
  laterAction: 'read',
  lowAction: 'archive',
  defaultReply: 'reply',
  signature: 'Warmly,\nAlex',
  signatureMode: 'new',
  footer: false,
  autoPolish: false,
  undoSeconds: 8,
  sendSound: true,
  autoCalendar: false,
  gmailEvents: true,
  notifications: true,
  accountNotifications: {},
  microphone: 'default',
  launchAtLogin: false,
  remoteImages: false,
  onboardingDone: false,
  hiddenCalendars: [],
  askModel: defaultAskModel,
  summaryModel: aiFeature('summary').fallback,
  draftModel: aiFeature('draft').fallback,
  planModel: aiFeature('plan').fallback,
  voiceModel: aiFeature('voice').fallback,
  askCustomUrl: '',
  askOllamaUrl: '',
  askLmStudioUrl: '',
};

/** The demo accounts' local calendars. Each account's first calendar is its default. */
export const demoCalendars: CalendarInfo[] = [
  { id: 'demo-work', name: 'Work', accountId: 'work', primary: true, color: '#5b7fa6' },
  { id: 'demo-work-team', name: 'Team', accountId: 'work', color: '#8a74b0' },
  { id: 'demo-work-focus', name: 'Focus time', accountId: 'work', color: '#4f9488' },
  { id: 'demo-personal', name: 'Personal', accountId: 'personal', primary: true, color: '#c07a5a' },
  { id: 'demo-personal-family', name: 'Family', accountId: 'personal', color: '#bf9638' },
  { id: 'demo-personal-fitness', name: 'Fitness', accountId: 'personal', color: '#5f9a62' },
];

export function createDemo(now = new Date()): AppState {
  const stamp = (days: number, hour = 10) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const due = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const attachment: Attachment = {
    id: 'att-notes',
    name: 'garden-notes.txt',
    type: 'text/plain',
    size: 88,
    data: 'Q29tbXVuaXR5IGdhcmRlbiBwbGFubmluZwpCcmluZyBnbG92ZXMsIGEgd2F0ZXIgYm90dGxlLCBhbmQgaWRlYXMgZm9yIHRoZSBoZXJiIGJlZHMuCg==',
  };
  const invoiceFile: Attachment = {
    id: 'att-invoice',
    name: 'invoice-october.txt',
    type: 'text/plain',
    size: 129,
    data: 'UGFwZXIgTGFuZSBpbGx1c3RyYXRpb24gaW52b2ljZSAoZGVtbykKT2N0b2JlciBpbGx1c3RyYXRpb25zOiA2IHBpZWNlcywgJDEsMjAwLjAwClRoaXMgZGVtb25zdHJhdGlvbiBpbnZvaWNlIGlzIG5vdCBhIHJlYWwgYmlsbC4K',
  };
  const files: Record<string, Attachment[]> = { garden: [attachment], invoice: [invoiceFile] };
  const rows: Array<[string, string, string, string, string, Partial<Thread>?]> = [
    [
      'garden',
      'personal',
      'Maya Chen',
      'maya@garden.example',
      'Saturday in the community garden',
      {
        todo: 'Confirm the garden volunteer shift',
        dueDate: due(2),
        replyStatus: 'needs-reply',
        bookmarked: true,
        action: { kind: 'calendar', label: 'Add to calendar' },
      },
    ],
    [
      'design',
      'work',
      'Jordan Park',
      'jordan@studio.example',
      'A quieter home for our project',
      {
        todo: 'Review the two layout directions',
        dueDate: due(1),
        replyStatus: 'needs-reply',
        action: { kind: 'reply', label: 'Reply', prompt: 'Say which layout direction you prefer' },
      },
    ],
    [
      'trip',
      'personal',
      'Sam Rivera',
      'sam@friends.example',
      'Cabin weekend: a few loose ends',
      {
        replyStatus: 'needs-reply',
        bookmarked: true,
        action: {
          kind: 'reply',
          label: 'Reply',
          prompt: 'Offer to organize breakfast and say whether you need a lift',
        },
      },
    ],
    [
      'invoice',
      'work',
      'Drew Bell',
      'drew@paperlane.example',
      'October illustration invoice',
      {
        todo: 'Approve the illustration invoice',
        dueDate: due(-1),
        status: 'later',
        action: { kind: 'attachment', label: 'View invoice', attachmentId: 'att-invoice' },
      },
    ],
    [
      'coffee',
      'work',
      'Nadia Wells',
      'nadia@studio.example',
      'Coffee and the next chapter',
      { replyStatus: 'awaiting-reply', status: 'done' },
    ],
    [
      'library',
      'personal',
      'Maple Library',
      'hello@library.example',
      'Your holds are ready to collect',
      {
        todo: 'Collect two books from the library',
        dueDate: due(3),
        action: { kind: 'link', label: 'View holds', url: 'https://library.example/account/holds' },
      },
    ],
    [
      'review',
      'work',
      'Theo Kim',
      'theo@studio.example',
      'Friday review: agenda and room',
      { bookmarked: true, action: { kind: 'calendar', label: 'Add to calendar' } },
    ],
    [
      'class',
      'personal',
      'Rowan Pottery',
      'classes@pottery.example',
      'A place opened in the evening class',
      {
        replyStatus: 'needs-reply',
        action: {
          kind: 'reply',
          label: 'Reserve seat',
          prompt: 'Ask them to reserve the seat in the Tuesday class',
        },
      },
    ],
    [
      'lunch',
      'work',
      'Leah Brooks',
      'leah@studio.example',
      'Lunch plans for the new starters',
      {
        status: 'later',
        todo: 'Choose a place for team lunch',
        action: {
          kind: 'reply',
          label: 'Suggest a place',
          prompt: 'Suggest a quiet lunch spot for six with vegetarian choices',
        },
      },
    ],
    [
      'delivery',
      'personal',
      'Parcel Trail',
      'updates@parcel.example',
      'Your parcel is on its way',
      {
        importance: 'low',
        action: {
          kind: 'link',
          label: 'Track parcel',
          url: 'https://parcel.example/track/DEMO-2408',
        },
      },
    ],
    [
      'digest',
      'work',
      'Field Notes',
      'digest@fieldnotes.example',
      'Three ideas for thoughtful teams',
      { importance: 'low' },
    ],
    [
      'receipt',
      'personal',
      'Cedar Market',
      'receipts@cedar.example',
      'Your market receipt',
      { status: 'done', importance: 'low' },
    ],
    [
      'workshop',
      'work',
      'Avery Stone',
      'avery@learning.example',
      'Workshop follow-up and resources',
      {
        status: 'later',
        bookmarked: true,
        reminderAt: stamp(1, 9),
        action: { kind: 'read', label: 'Read notes' },
      },
    ],
    [
      'museum',
      'personal',
      'Mira Patel',
      'mira@friends.example',
      'A museum afternoon next month',
      { status: 'done', bookmarked: true },
    ],
    [
      'newsletter',
      'personal',
      'Trail Journal',
      'hello@trail.example',
      'New walks for cooler mornings',
      { importance: 'low', status: 'later' },
    ],
    [
      'old',
      'work',
      'Ellis Gray',
      'ellis@studio.example',
      'Old room booking cancelled',
      { status: 'trash', unread: false },
    ],
    [
      'spam',
      'personal',
      'Unknown Offers',
      'offers@unwanted.example',
      'A suspicious prize announcement',
      { status: 'spam', importance: 'low' },
    ],
    [
      'sent',
      'work',
      'Alex Morgan',
      'alex@studio.example',
      'Thanks for a productive session',
      { status: 'done', replyStatus: 'awaiting-reply', unread: false },
    ],
  ];
  const bodies: Record<string, string> = {
    garden:
      'Hi Alex,\nWe are gathering at the community garden this Saturday at 10 am. Could you help us plant the herb beds? Bring gloves if you have them. I attached a few notes.\nMaya',
    design:
      'Hi Alex,\nThe two layout directions are ready for your review. The first gives the story more space; the second puts the weekly plan first. Can you send me your preference by tomorrow?\nJordan',
    trip: 'Hello!\nThe cabin is booked. I can bring dinner for Friday if you can organize breakfast. Let me know what works and whether you need a lift.\nSam',
    invoice:
      'Hi Alex,\nThe October illustrations are complete. Please approve the invoice when you have a moment so we can close out the project. The invoice is attached.\nDrew',
    coffee:
      'Thanks for the chat this morning. I am checking our calendars and will send two times for next week.\nNadia',
    library:
      'Hello Alex,\nTwo books from your hold list are ready at Maple Library. We will keep them at the front desk until the end of the week.\nSee your holds: https://library.example/account/holds',
    review:
      'Hi everyone,\nOur project review is Friday at 2 pm in the Oak room. We will spend 20 minutes on the prototype and 10 minutes on next steps. Please bring one question.\nTheo',
    class:
      'Hi Alex,\nA seat has opened in our Tuesday evening pottery class. The six-week course starts next month. Reply if you would like us to reserve it.\nRowan',
    lunch:
      'Hi Alex,\nCould you choose somewhere for our welcome lunch? We need a quiet table for six and a couple of vegetarian choices. No rush today.\nLeah',
    delivery:
      'Your order has left our local depot. We expect delivery tomorrow between 10 am and 2 pm. Your tracking reference is DEMO-2408. Follow it at https://parcel.example/track/DEMO-2408',
    digest:
      'This week: make room for quiet work, write decisions down, and finish meetings with one clear next step. Read at your own pace.',
    receipt:
      'Thank you for shopping locally. Your total was $28.40. This demonstration receipt does not represent a real transaction.',
    workshop:
      'Thank you for joining the workshop. Here are the notes: start small, share early, and make the next step visible. I would love to hear how you use the exercises.\nAvery',
    museum:
      'The new exhibition looks wonderful. Shall we choose a Sunday afternoon once our calendars settle down?\nMira',
    newsletter:
      'The woodland loop is looking beautiful this month. Our latest walking notes include a short route, a hill route, and a cafe stop.',
    old: 'The old room reservation has been cancelled. The updated invitation has the correct room, so you can discard this message.\nEllis',
    spam: 'This is a synthetic unwanted message used to demonstrate the Spam folder. No links or offers here are real.',
    sent: 'Hi team,\nThanks for the thoughtful discussion. I will send the next draft on Thursday. Please add any remaining questions before then.\nAlex',
  };
  const summaries: Record<string, string> = {
    garden: 'Help plant the herb beds Saturday at 10 am, bring gloves',
    design: 'Two layout directions ready, wants your preference by tomorrow',
    trip: 'Cabin booked; Sam brings Friday dinner, you sort out breakfast',
    invoice: 'October illustrations finished, approve the invoice to close out',
    coffee: 'Sending two meeting times for next week',
    library: 'Two holds waiting at the front desk until the end of the week',
    review: 'Project review Friday at 2 pm in the Oak room, bring one question',
    class: 'A seat opened in the Tuesday evening class, reply to reserve it',
    lunch: 'Pick a quiet lunch spot for six with vegetarian choices',
    delivery: 'Parcel arrives tomorrow between 10 am and 2 pm',
    digest: 'Three team habits: quiet work, written decisions, clear next steps',
    receipt: '$28.40 receipt for your order',
    workshop: 'Workshop notes shared, wants to hear how the exercises go',
    museum: 'Suggests a Sunday afternoon at the new exhibition',
    newsletter: 'New autumn walks: a short loop, a hill route and a cafe stop',
    old: 'Old room booking cancelled; the updated invitation has the right room',
    spam: 'Unsolicited prize announcement',
    sent: 'Thanked the team and promised the next draft on Thursday',
  };
  // Original plans spread over the current week (Sunday first), so the combined calendar has something to show.
  const week = (day: number, hour: number, minute = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() - d.getDay() + day);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };
  const weekDay = (day: number) => due(day - now.getDay());
  const plans: Array<[string, string, string, string, string, string, Partial<CalendarEvent>?]> = [
    ...[1, 2, 3, 4, 5].map(
      day =>
        [
          `standup-${day}`,
          'work',
          'demo-work-team',
          'Standup',
          week(day, 9),
          week(day, 9, 15),
          { location: 'Video call' },
        ] as [string, string, string, string, string, string, Partial<CalendarEvent>],
    ),
    [
      'planning',
      'work',
      'demo-work-team',
      'Weekly planning',
      week(1, 9, 30),
      week(1, 10, 15),
      { description: 'Pick the three things that matter this week.' },
    ],
    [
      'critique',
      'work',
      'demo-work',
      'Design critique',
      week(1, 13),
      week(1, 14),
      {
        location: 'Studio, second floor',
        guests: ['jordan@studio.example', 'nadia@studio.example'],
      },
    ],
    [
      'layouts',
      'work',
      'demo-work',
      'Layout review with Jordan',
      week(2, 10),
      week(2, 11),
      { guests: ['jordan@studio.example'] },
    ],
    ['brief', 'work', 'demo-work-focus', 'Write the project brief', week(2, 10), week(2, 12)],
    ['one-on-one', 'work', 'demo-work-team', '1:1 with Nadia', week(2, 14, 30), week(2, 15)],
    [
      'deep-work',
      'work',
      'demo-work-focus',
      'Focus block',
      week(3, 9),
      week(3, 11, 30),
      { description: 'Notifications off.' },
    ],
    [
      'welcome-lunch',
      'work',
      'demo-work-team',
      'Welcome lunch for new starters',
      week(3, 12),
      week(3, 13),
      { location: 'Green Table', guests: ['leah@studio.example'] },
    ],
    [
      'invoice-check',
      'work',
      'demo-work',
      'Invoice check-in with Drew',
      week(4, 16),
      week(4, 16, 30),
      { location: 'Phone' },
    ],
    ['retro', 'work', 'demo-work-team', 'Team retro', week(5, 10), week(5, 10, 45)],
    ['polish', 'work', 'demo-work-focus', 'Prototype polish', week(5, 14), week(5, 16, 30)],
    ['offsite', 'work', 'demo-work', 'Offsite prep', weekDay(4), weekDay(6), { allDay: true }],
    [
      'run',
      'personal',
      'demo-personal-fitness',
      'Run club',
      week(1, 18, 30),
      week(1, 19, 30),
      { location: 'River path' },
    ],
    [
      'dinner',
      'personal',
      'demo-personal',
      'Dinner with Sam',
      week(2, 19),
      week(2, 21),
      { location: 'Lantern Kitchen', guests: ['sam@friends.example'] },
    ],
    ['swim', 'personal', 'demo-personal-fitness', 'Morning swim', week(3, 7), week(3, 8)],
    [
      'dentist',
      'personal',
      'demo-personal',
      'Dentist',
      week(3, 12, 30),
      week(3, 13, 15),
      { location: 'Bright Smile Dental' },
    ],
    ['yoga', 'personal', 'demo-personal-fitness', 'Yoga', week(4, 18), week(4, 19)],
    [
      'birthday',
      'personal',
      'demo-personal-family',
      'Rosa’s birthday',
      weekDay(4),
      weekDay(5),
      { allDay: true },
    ],
    [
      'cabin',
      'personal',
      'demo-personal-family',
      'Cabin weekend',
      weekDay(5),
      weekDay(8),
      { allDay: true, location: 'Pine Hollow', guests: ['sam@friends.example'] },
    ],
    [
      'market',
      'personal',
      'demo-personal',
      'Farmers market',
      week(0, 10),
      week(0, 11, 30),
      { location: 'Cedar Square' },
    ],
  ];
  const events: CalendarEvent[] = plans.map(
    ([id, accountId, calendarId, title, start, end, patch]) => ({
      id: `plan-${id}`,
      accountId,
      calendarId,
      title,
      start,
      end,
      allDay: false,
      location: '',
      description: '',
      guests: [],
      ...patch,
    }),
  );
  const threads: Thread[] = rows.map(([id, accountId, fromName, from, subject, patch], index) => {
    const date = stamp(-Math.floor(index / 3));
    const text = bodies[id];
    return {
      id,
      accountId,
      subject,
      summary: summaries[id] ?? text,
      date,
      unread: index < 8,
      status: 'new',
      importance: 'important',
      bookmarked: false,
      replyStatus: 'none',
      ...patch,
      messages: [
        {
          id: `message-${id}`,
          from,
          fromName,
          to: [
            id === 'sent'
              ? 'Studio team <team@studio.example>'
              : accountId === 'work'
                ? 'alex@studio.example'
                : 'alex@home.example',
          ],
          date,
          text,
          html: text
            .split('\n')
            .map(
              line =>
                `<p>${line.replace(/https:\/\/\S+/g, url => `<a href="${url}">${url}</a>`)}</p>`,
            )
            .join(''),
          attachments: files[id] ?? [],
          sent: id === 'sent',
        },
      ],
    };
  });
  return {
    version: 1,
    accounts: [
      {
        id: 'work',
        name: 'Alex Morgan',
        email: 'alex@studio.example',
        color: '#718878',
        provider: 'demo',
        connected: true,
        calendarConnected: true,
      },
      {
        id: 'personal',
        name: 'Alex Morgan',
        email: 'alex@home.example',
        color: '#b38b71',
        provider: 'demo',
        connected: true,
        calendarConnected: true,
      },
    ],
    threads,
    drafts: [
      {
        id: 'draft-welcome',
        accountId: 'work',
        to: 'jordan@studio.example',
        cc: '',
        bcc: '',
        subject: 'Re: A quieter home for our project',
        html: '<p>Hi Jordan,</p><p>I like the direction with more room for the story. A few thoughts to follow.</p>',
        attachments: [],
        threadId: 'design',
        mode: 'reply',
        updatedAt: now.toISOString(),
        signature: false,
        revision: 1,
      },
    ],
    events: [
      ...events,
      {
        id: 'event-review',
        accountId: 'work',
        threadId: 'review',
        calendarId: 'demo-work',
        title: 'Project review',
        start: stamp(2, 14),
        end: stamp(2, 15),
        allDay: false,
        location: 'Oak room',
        description: 'Review the prototype and agree on next steps.',
        guests: ['theo@studio.example'],
      },
    ],
    conversations: [],
    settings: structuredClone(defaultSettings),
    selectedAccountId: 'all',
    sync: { busy: false },
    blockedSenders: [],
  };
}
