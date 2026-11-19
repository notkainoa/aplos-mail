// ui-reader demo content: six fuller threads for the reader and compose states (states.reader.ts, scenes.reader.tsx).
// Everything here is original and invented: the people, the studio, the shops and the newsletter do not exist, every
// address is on a `.example` domain, and the links go nowhere. It is plain data; the scenes seed it into the stand-in
// engine's store and put the bodies in front of the data layer (see seedDemoThread in scenes.reader.tsx).

export interface DemoPerson {
  readonly name: string;
  readonly address: string;
}

export interface DemoFile {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

export interface DemoMessage {
  readonly from: DemoPerson;
  readonly to: readonly DemoPerson[];
  readonly cc?: readonly DemoPerson[];
  /** ISO time with the offset; the harness runs in Los Angeles time on Thursday 29 October 2026, 10:00. */
  readonly at: string;
  /** A plain-text body (follows the theme). Exactly one of `text` and `html`. */
  readonly text?: string;
  /** An HTML body as a sender wrote it (shown on light paper in the frame). */
  readonly html?: string;
  /** The HTML body holds remote pictures ("Images blocked", Load images from this sender). */
  readonly remoteImages?: boolean;
  readonly files?: readonly DemoFile[];
}

export interface DemoAction {
  readonly kind: 'reply' | 'attachment' | 'calendar';
  readonly label: string;
  readonly attachmentId?: string;
  readonly prompt?: string;
}

/** The calendar event an invitation carries (the stand-in's `Event` row; the thread's `eventId` points at it). */
export interface DemoEvent {
  readonly title: string;
  /** ISO times with the offset. */
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly organizer: DemoPerson;
  /** The guests other than the organiser. */
  readonly guests: readonly DemoPerson[];
}

export type DemoSummary =
  | { readonly state: 'ready'; readonly text: string; readonly action?: DemoAction }
  | { readonly state: 'pending' | 'failed' | 'none' };

export interface DemoThread {
  readonly key: string;
  readonly subject: string;
  readonly lane: 'do' | 'update' | 'low';
  readonly summary: DemoSummary;
  readonly unsubscribe?: boolean;
  /** An invitation: the event the latest message carries. */
  readonly event?: DemoEvent;
  /** Oldest first; the last one is the letter the reader opens on. */
  readonly messages: readonly DemoMessage[];
}

export const ALEX: DemoPerson = { name: 'Alex Morgan', address: 'alex@studio.example' };
const JORDAN: DemoPerson = { name: 'Jordan Park', address: 'jordan@studio.example' };
const MINA: DemoPerson = { name: 'Mina Cho', address: 'mina@studio.example' };
const PRIYA: DemoPerson = { name: 'Priya Nair', address: 'priya@northfield.example' };
const TOMAS: DemoPerson = { name: 'Tomas Reyes', address: 'tomas@studio.example' };
const NOOR: DemoPerson = { name: 'Noor Haddad', address: 'noor@studio.example' };
const SHOP: DemoPerson = { name: 'Fernhill Supply', address: 'orders@fernhill.example' };
const NOTES: DemoPerson = { name: 'Margin Notes', address: 'hello@marginnotes.example' };

/* ------------------------------ (a) the project thread: 5 messages, 3 people, 4 days ------------------------------ */

const BROCHURE_FIRST = `Hi Alex,

The first pass of the seed library brochure is ready for you to look at. I kept it to a single sheet folded in three, so it fits a coat pocket and can sit in the rack by the library door.

Here is where things stand:

- Cover: the pressed-leaf drawing, with the library name set large and nothing else on it.
- Inside left: how borrowing works, in three short steps.
- Inside middle: the autumn planting calendar, one line per month.
- Inside right: the map, the opening hours and a place for the volunteer stamp.
- Back: a short thank-you to the people who donate seed.

A few things I would like your view on. The calendar is the densest part, and I am torn between a table and a plain list. The table is easier to scan but looks busier against the drawing. I would also like to know whether the thank-you should name the donors or only say how many there are this year.

The working files and the PDF proof are in the shared folder: https://files.studio.example/seed-library/brochure

Mina, I have copied you because the folds and the paper weight are your call. I have assumed 150 gsm uncoated, but please say if the shop prefers something else.

No rush today. A reply by Wednesday would keep us on schedule.

Thanks,
Jordan
--
Jordan Park
Designer, Studio Hollow Creek`;

const BROCHURE_REPLY = `Thanks Jordan, this is a lovely start. The pocket size is right.

> The calendar is the densest part, and I am torn between a table
> and a plain list.

A plain list, I think. The drawing needs the air. On the donors: say how many, not who. Some people prefer not to be named.

Alex`;

const BROCHURE_PAPER = `Agreed on the list. Two notes from the print side:

> I have assumed 150 gsm uncoated, but please say if the shop
> prefers something else.

The shop suggests 170 gsm for a three-fold, because 150 can crack along the folds. It costs about eight percent more for a run of 400. I can ask for a sample sheet if you want to feel the difference.

Mina
--
Mina Cho
Production, Studio Hollow Creek`;

const BROCHURE_PROOFS =
  'Switched to the plain list and exported new proofs, same folder as before.';

const BROCHURE_SAMPLE = `Hi Alex,

The shop sent the sample sheet overnight and the 170 gsm folds cleanly. They can hold Monday's print slot if we confirm by noon tomorrow.

> Switched to the plain list and exported new proofs, same folder as
> before.

I checked the new proofs against the shop's template. Everything lines up, with two small things left:

- the back panel text sits 2 mm too close to the fold
- the map needs the shop's bleed on the right edge

Jordan, can you fix both today? Alex, a yes on the paper stock is all I need from you.

Mina
--
Mina Cho
Production, Studio Hollow Creek`;

const project: DemoThread = {
  key: 'brochure',
  subject: 'Seed library brochure: layout, paper and print run',
  lane: 'do',
  summary: {
    state: 'ready',
    text: "Proofs checked; Mina needs your yes on 170 gsm paper by noon tomorrow to hold Monday's print slot",
    action: {
      kind: 'reply',
      label: 'Reply',
      prompt: 'Approve the 170 gsm paper and ask Jordan to fix the back panel',
    },
  },
  messages: [
    {
      from: JORDAN,
      to: [ALEX],
      cc: [MINA],
      at: '2026-10-26T09:14:00-07:00',
      text: BROCHURE_FIRST,
    },
    { from: ALEX, to: [JORDAN], cc: [MINA], at: '2026-10-26T16:40:00-07:00', text: BROCHURE_REPLY },
    { from: MINA, to: [ALEX, JORDAN], at: '2026-10-27T11:05:00-07:00', text: BROCHURE_PAPER },
    {
      from: JORDAN,
      to: [ALEX],
      cc: [MINA],
      at: '2026-10-28T08:52:00-07:00',
      text: BROCHURE_PROOFS,
    },
    {
      from: MINA,
      to: [ALEX],
      cc: [JORDAN],
      at: '2026-10-29T08:31:00-07:00',
      text: BROCHURE_SAMPLE,
    },
  ],
};

/* ------------------------------ (b) three attachments of three kinds ------------------------------ */

const PLAN_ASK = `Priya, could you send the latest studio plan, the photos from your site visit and the Q4 budget numbers? I would like to read them before Thursday.

Alex`;

const PLAN_ANSWER = `Hi Alex,

Everything you asked for is attached.

- Studio plan v3.pdf is the floor plan with the new desk layout and the lighting notes. The north wall is unchanged.
- site-photos.zip has 42 photos from Monday's visit, named by room. The loading door ones are the ones Tomas flagged.
- budget-q4.xlsx has the four quarters side by side. The tab at the end is the one with the lighting quote.

The photos archive is large, so give it a minute to download. Tell me if it will not open and I will send a link instead.

Priya`;

export const PLAN_FILES: readonly DemoFile[] = [
  { id: 'att-plan', name: 'Studio plan v3.pdf', mime: 'application/pdf', size: 1_200_000 },
  { id: 'att-photos', name: 'site-photos.zip', mime: 'application/zip', size: 8_400_000 },
  {
    id: 'att-budget',
    name: 'budget-q4.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 86_000,
  },
];

const files: DemoThread = {
  key: 'studio-plan',
  subject: 'Studio plan v3, site photos and the Q4 budget',
  lane: 'do',
  summary: {
    state: 'ready',
    text: 'Priya sent the v3 plan, 42 site photos and the Q4 budget; the lighting quote is on the last tab',
    action: { kind: 'attachment', label: 'View plan', attachmentId: 'att-plan' },
  },
  messages: [
    { from: ALEX, to: [PRIYA], cc: [TOMAS], at: '2026-10-27T15:10:00-07:00', text: PLAN_ASK },
    {
      from: PRIYA,
      to: [ALEX],
      cc: [TOMAS],
      at: '2026-10-29T07:48:00-07:00',
      text: PLAN_ANSWER,
      files: PLAN_FILES,
    },
  ],
};

/* ------------------------------ (c) a calendar invitation ------------------------------ */

const INVITE_HTML = `<div style="font-family:Georgia,serif;color:#2b2a27;max-width:560px">
<p style="margin:0 0 6px;color:#6b675f;font-size:14px">Invitation from Noor Haddad</p>
<h2 style="margin:0 0 16px;font-size:24px">Brand review</h2>
<table style="width:100%;border-collapse:collapse;font-size:15px">
<tr><td style="padding:8px 16px 8px 0;color:#6b675f;width:96px;vertical-align:top">When</td><td style="padding:8px 0">Thursday 5 November 2026, 2:00 to 2:45 PM (Pacific Time)</td></tr>
<tr><td style="padding:8px 16px 8px 0;color:#6b675f;vertical-align:top">Where</td><td style="padding:8px 0">Oak room, second floor</td></tr>
<tr><td style="padding:8px 16px 8px 0;color:#6b675f;vertical-align:top">Organiser</td><td style="padding:8px 0">Noor Haddad (noor@studio.example)</td></tr>
<tr><td style="padding:8px 16px 8px 0;color:#6b675f;vertical-align:top">Guests</td><td style="padding:8px 0">Alex Morgan (you), Jordan Park, Tomas Reyes, Priya Nair</td></tr>
</table>
<p style="margin:16px 0 8px">We will go through the three logo routes and the colour palette, then agree what goes to the client on Friday. Please bring one route you would defend and one you would drop.</p>
<p style="margin:0 0 20px"><a href="https://calendar.studio.example/respond?e=brand-review&r=yes" style="font-weight:bold">Yes</a> &nbsp;&middot;&nbsp; <a href="https://calendar.studio.example/respond?e=brand-review&r=maybe">Maybe</a> &nbsp;&middot;&nbsp; <a href="https://calendar.studio.example/respond?e=brand-review&r=no">No</a></p>
<p style="margin:0;color:#6b675f;font-size:13px">You are receiving this because you are on the guest list. The invitation file is attached, so it can be added to any calendar.</p>
</div>`;

const invite: DemoThread = {
  key: 'brand-review',
  subject: 'Invitation: Brand review, Thu 2:00-2:45 PM',
  lane: 'do',
  summary: {
    state: 'ready',
    text: 'Noor invites you to the brand review on Thursday 2:00 to 2:45 PM in the Oak room',
    action: { kind: 'calendar', label: 'Add to calendar' },
  },
  event: {
    title: 'Brand review',
    start: '2026-11-05T14:00:00-08:00',
    end: '2026-11-05T14:45:00-08:00',
    location: 'Oak room, second floor',
    organizer: NOOR,
    guests: [ALEX, JORDAN, TOMAS, PRIYA],
  },
  messages: [
    {
      from: NOOR,
      to: [ALEX, JORDAN],
      cc: [TOMAS, PRIYA],
      at: '2026-10-26T13:20:00-07:00',
      html: INVITE_HTML,
      files: [{ id: 'att-invite', name: 'invite.ics', mime: 'text/calendar', size: 1_900 }],
    },
  ],
};

/* ------------------------------ (d) a one-liner ------------------------------ */

const oneliner: DemoThread = {
  key: 'walkthrough',
  subject: 'Thursday walkthrough',
  lane: 'update',
  summary: { state: 'pending' },
  messages: [
    {
      from: ALEX,
      to: [TOMAS],
      cc: [NOOR],
      at: '2026-10-27T14:02:00-07:00',
      text: 'Can we do the walkthrough on Thursday at 11? I will book the Oak room.\n\nAlex',
    },
    {
      from: TOMAS,
      to: [ALEX],
      cc: [NOOR],
      at: '2026-10-27T14:09:00-07:00',
      text: 'Sounds good, see you Thursday.',
    },
  ],
};

/* ------------------------------ (e) a receipt: one blocked picture and one tracking pixel ------------------------------ */

const CELL = 'padding:5px 0;border-bottom:1px solid #e4dfd5';

const RECEIPT_HTML = `<div style="font-family:Georgia,serif;color:#2b2a27;max-width:560px">
<img src="https://img.fernhill.example/logo.png" alt="Fernhill Supply" width="132" height="32" style="display:block;margin:0 0 12px;background:#ece8df">
<h2 style="margin:0 0 4px;font-size:22px">Thanks for your order</h2>
<p style="margin:0 0 10px;color:#6b675f">Order F-20418, placed on 28 October</p>
<table style="width:100%;border-collapse:collapse;font-size:15px">
<tr><td style="${CELL}">Seed tray, 24 cell &times; 2</td><td style="${CELL};text-align:right">$14.00</td></tr>
<tr><td style="${CELL}">Hand trowel</td><td style="${CELL};text-align:right">$12.50</td></tr>
<tr><td style="${CELL}">Cedar plant labels, pack of 50</td><td style="${CELL};text-align:right">$6.00</td></tr>
<tr><td style="${CELL};color:#6b675f">Delivery</td><td style="${CELL};text-align:right;color:#6b675f">$4.50</td></tr>
<tr><td style="padding:8px 0;font-weight:bold">Total</td><td style="padding:8px 0;text-align:right;font-weight:bold">$37.00</td></tr>
</table>
<p style="margin:14px 0 14px"><a href="https://fernhill.example/orders/F-20418" style="display:inline-block;padding:10px 20px;background:#2f4a6b;color:#ffffff;text-decoration:none;border-radius:6px">View your order</a></p>
<p style="margin:0;color:#6b675f;font-size:13px">You are receiving this because you placed an order. <a href="https://fernhill.example/unsubscribe">Unsubscribe</a> from order notes.</p>
<img src="https://t.fernhill.example/o.gif?id=F-20418" width="1" height="1" alt="">
</div>`;

const receipt: DemoThread = {
  key: 'receipt',
  subject: 'Receipt for your Fernhill order F-20418',
  lane: 'low',
  summary: { state: 'failed' },
  unsubscribe: true,
  messages: [
    {
      from: SHOP,
      to: [ALEX],
      at: '2026-10-28T19:36:00-07:00',
      html: RECEIPT_HTML,
      remoteImages: true,
    },
  ],
};

/* ------------------------------ (f) a long newsletter: heading, three sections, links, a pull quote ------------------------------ */

const P = 'margin:0 0 14px;line-height:1.55';
const H = 'margin:28px 0 8px;font-size:19px';

const NEWSLETTER_HTML = `<div style="font-family:Georgia,serif;color:#2b2a27;max-width:560px">
<p style="margin:0 0 4px;color:#6b675f;font-size:13px;letter-spacing:0.04em">MARGIN NOTES &middot; NUMBER 42</p>
<h1 style="margin:0 0 16px;font-size:30px;line-height:1.2">Slower mornings, shorter meetings</h1>
<p style="${P}">This week we looked at how small teams protect the first hours of the day, why the best meetings are the ones that end early, and what is worth reading while the clocks go back. Pour something warm. This one takes about six minutes.</p>
<h2 style="${H}">1. A slower first hour</h2>
<p style="${P}">Three of the teams we spoke to keep their first hour free of messages. Nobody writes, nobody expects an answer, and the calendar is blocked in a plain colour so no one has to ask why. The surprise was not the extra work done; it was how many people said they felt less behind by lunch.</p>
<p style="${P}">The habit is easier to start than to keep. The teams that lasted past a month agreed one exception in advance, usually a phone number for real emergencies, and then stopped discussing it. You can read the full interviews on <a href="https://marginnotes.example/issues/42/first-hour">the notes page</a>.</p>
<blockquote style="margin:24px 0;padding:4px 0 4px 18px;border-left:3px solid #2f4a6b;font-size:21px;line-height:1.4;font-style:italic">A meeting that ends ten minutes early is a small gift to everyone in it.</blockquote>
<h2 style="${H}">2. Meetings that end early</h2>
<p style="${P}">Booking twenty-five minutes instead of thirty gives people time to stand up, refill a glass and arrive at the next thing awake. A studio in the north of England has done this for two years and now treats the five minutes as part of the agenda. Their rule: if the decision is made, the meeting is over.</p>
<p style="${P}">Try it for a fortnight and count how often the last five minutes were actually used. We would like to hear the number, so <a href="https://marginnotes.example/reply">tell us</a> and we will share the tally in the next issue.</p>
<h2 style="${H}">3. What we are reading</h2>
<p style="${P}">A short essay on keeping a commonplace book, a long one on why paper calendars persist, and a field guide to winter hedgerows with excellent drawings. All three are linked below, along with the reader mail we could not fit in last time.</p>
<p style="${P}"><a href="https://marginnotes.example/reading/commonplace">The commonplace book</a><br><a href="https://marginnotes.example/reading/paper-calendars">Why paper calendars persist</a><br><a href="https://marginnotes.example/reading/hedgerows">A field guide to winter hedgerows</a></p>
<p style="margin:32px 0 0;color:#6b675f;font-size:13px;line-height:1.5">You are receiving Margin Notes because you subscribed at marginnotes.example. <a href="https://marginnotes.example/unsubscribe">Unsubscribe</a> or choose how often it arrives.</p>
</div>`;

const newsletter: DemoThread = {
  key: 'margin-notes',
  subject: 'Margin Notes No. 42: Slower mornings, shorter meetings',
  lane: 'low',
  summary: { state: 'none' },
  unsubscribe: true,
  messages: [
    {
      from: NOTES,
      to: [ALEX],
      at: '2026-10-29T06:00:00-07:00',
      html: NEWSLETTER_HTML,
    },
  ],
};

/* ------------------------------ (f) a crowd: many recipients, to pin the "to …" line and the details popover ------------------------------ */

/** `count` invented guests on a `.example` domain, in a fixed order. */
function guests(count: number): DemoPerson[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Guest ${index + 1} Example`,
    address: `guest${index + 1}@crowd.example`,
  }));
}

function crowdThread(key: string, subject: string, count: number): DemoThread {
  return {
    key,
    subject,
    lane: 'update',
    summary: { state: 'none' },
    messages: [
      {
        from: TOMAS,
        to: [ALEX, ...guests(count)],
        at: '2026-10-28T09:15:00-07:00',
        text: 'The studio is open to everyone on Saturday from ten. Bring a friend, and a mug.\n\nTomas',
      },
    ],
  };
}

/** Six recipients besides you: three circles and "+4" (the circles cap at three). */
const crowd = crowdThread('crowd', 'Studio open day', 6);

/** Five hundred recipients: the circles still stop at three and the details popover scrolls inside the window. */
const crowd500 = crowdThread('crowd500', 'Studio open day, everyone', 500);

/* ------------------------------ the set ------------------------------ */

export const DEMO = {
  project,
  files,
  invite,
  oneliner,
  receipt,
  newsletter,
  crowd,
  crowd500,
} as const;

export type DemoKey = keyof typeof DEMO;

/** The compose states' text: three sentences for the inline reply, a 120-word note for the new message. */
export const REPLY_DRAFT =
  'Yes to the 170 gsm stock, please hold Monday’s print slot. I will look at the sample sheet this afternoon and confirm by noon tomorrow. Jordan, thank you for turning the proofs around so quickly.';

export const NEW_MESSAGE = {
  to: 'Priya Nair <priya@northfield.example>',
  subject: 'Studio plan v3: three questions before Thursday',
  body: `Hi Priya,

Thank you for sending the plan and the photos so quickly. I have been through all of it and the new desk layout works well. Before Thursday I would like to settle three things.

First, can the lighting quote cover the north wall as well as the desks? Second, do the loading door photos mean the delivery route has to change? Third, is the budget tab for the fourth quarter final, or should I wait for a second version?

I will forward your answers to Tomas so the studio and the budget stay in step.

If it is easier to talk, I am free after two tomorrow and happy to walk through the plan together at the studio.

Thanks again,
Alex`,
};
