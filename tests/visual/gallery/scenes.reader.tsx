// ui-reader scenes: the reader, the inline reply, the compose page and every send state, drawn as the real screens inside
// the real app on the stand-in engine (the `demo` scenario on the frozen wall clock), like scenes.home.tsx. The stand-in
// keeps one plain-text message per thread, so a scene seeds what it needs through the fixture (earlier messages,
// attachments) and puts a small gate in front of the data layer's session for what the stand-in cannot say: an HTML
// body with remote images, a plain-text body, a body that is slow or fails. Mail here is original demo data. The
// dictation state cannot reach a microphone, so it draws the composer's own pieces with the dictation props directly.

import { useEffect, useRef, type ReactElement } from 'react';
import { createClient } from '@aplos/contract/client';
import type { EngineSession } from '@aplos/contract/client';
import {
  realClock,
  type FixtureClock,
  type FixtureEngine,
  type Scenario,
} from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { App, type AppClient } from '../../../apps/desktop/src/renderer/App';
import { connectDataLayer } from '../../../apps/desktop/src/renderer/data/connect';
import { inProcessTransport } from '../../../apps/desktop/src/renderer/data/client';
import { withNativeStubs } from '../../../apps/desktop/src/renderer/data/native-stub';
import { NEW_MESSAGE_DRAFT, seedNewMessageDraft } from './seedDraft';
import { connectStandIn } from '../../../apps/desktop/src/renderer/data/standin';
import { openCompose, openThread, updateToast } from '../../../apps/desktop/src/renderer/shell';
import { getToasts } from '../../../apps/desktop/src/renderer/shell/store-toast';
import {
  CardStyleContext,
  type CardStyle,
} from '../../../apps/desktop/src/renderer/screens/cardStyle';
import '../../../apps/desktop/src/renderer/shell/shell.css';
import '../../../apps/desktop/src/renderer/screens/screens.css';
import { DictatingScene, REPLY_TEXT } from './scenes.dictating';
import {
  ALEX,
  DEMO,
  REPLY_DRAFT,
  type DemoEvent,
  type DemoKey,
  type DemoMessage,
  type DemoThread,
} from './readerDemo';

type Fixture = FixtureEngine['fixture'];
type Pass = (method: string, args: unknown) => Promise<unknown>;

/* ------------------------------ the original demo mail ------------------------------ */

const WORK = 'demo-work';
const DESIGN = `${WORK}:design`;
const SENT = `${WORK}:sent`;
const JORDAN = { name: 'Jordan Park', address: 'jordan@studio.example' };
const MINA = { name: 'Mina Cho', address: 'mina@studio.example' };
const ME = { name: 'Alex Morgan', address: 'alex@studio.example' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Person {
  readonly name: string;
  readonly address: string;
}

interface Earlier {
  readonly from: Person;
  readonly body: string;
}

const CHAT: readonly Earlier[] = [
  {
    from: JORDAN,
    body: 'Hi Alex,\nI started on the home page for the Hollow Creek site. Before I go further, do you want the story first or the weekly plan first?\nJordan',
  },
  {
    from: ME,
    body: 'Jordan, the story first, with the plan one scroll below. Mina, can you check the copy length?\nAlex',
  },
  {
    from: MINA,
    body: 'The story section is about 120 words, which fits. I would keep the plan under four lines.\nMina',
  },
  {
    from: JORDAN,
    body: 'Thanks both. Two directions coming tomorrow: one quieter, one denser.\nJordan',
  },
  {
    from: ME,
    body: 'Perfect. I will look first thing and answer by lunch.\nAlex',
  },
  {
    from: MINA,
    body: 'Printing the two directions at A3 for the wall, if that helps.\nMina',
  },
  {
    from: JORDAN,
    body: 'That would help a lot, thank you. I will export them as soon as the grid is settled.\nJordan',
  },
  {
    from: ME,
    body: 'Let me know if the export needs a bigger frame. The print shop closes at five.\nAlex',
  },
];

function addressOf(person: Person) {
  return { name: person.name, address: person.address };
}

/** Earlier messages of `threadId`, oldest first, each a day apart and all before the thread's own first message. */
function seedEarlier(fx: Fixture, threadId: string, earlier: readonly Earlier[]): void {
  const thread = fx.store.get('Thread', threadId);
  const last = fx.store.get('Message', `${threadId}.m1`);
  if (!thread || !last) return;
  earlier.forEach((item, index) => {
    const id = `${threadId}.e${index + 1}`;
    const mine = item.from === ME;
    const others = [JORDAN, MINA].filter(p => p !== item.from);
    fx.bodies[id] = item.body;
    fx.write({ kind: 'Fixture/control' }, tx => {
      tx.put('Message', {
        ...last,
        id,
        rev: 0,
        from: addressOf(item.from),
        to: mine ? [addressOf(JORDAN)] : [addressOf(ME)],
        cc: mine ? [addressOf(MINA)] : [addressOf(others[0] ?? MINA)],
        snippet: item.body.replace(/\s+/g, ' ').slice(0, 140),
        date: last.date - (earlier.length - index) * DAY,
        seen: true,
        fromMe: mine,
        attachments: [],
        bodyKind: 'text',
      });
    });
  });
  fx.write({ kind: 'Fixture/control' }, tx => {
    tx.put('Thread', {
      ...thread,
      messageCount: earlier.length + 1,
      participants: [
        { ...addressOf(JORDAN) },
        { ...addressOf(MINA) },
        { ...addressOf(ME), me: true },
      ],
    });
  });
}

interface FileSeed {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly state?: 'present' | 'failed';
}

/** Gives the first message of a thread attachments; present ones can be fetched. */
function seedFiles(fx: Fixture, threadId: string, files: readonly FileSeed[]): void {
  const message = fx.store.get('Message', `${threadId}.m1`);
  const thread = fx.store.get('Thread', threadId);
  if (!message || !thread) return;
  const bytes = new TextEncoder().encode('Original demo file.\n') as Uint8Array<ArrayBuffer>;
  for (const file of files)
    fx.files[`${message.id}/${file.id}`] = { bytes, mime: file.mime, name: file.name };
  fx.write({ kind: 'Fixture/control' }, tx => {
    tx.put('Message', {
      ...message,
      attachments: files.map(f => ({
        id: f.id,
        name: f.name,
        mime: f.mime,
        size: f.size,
        inline: false,
        state: f.state ?? 'present',
      })),
    });
    tx.put('Thread', { ...thread, hasAttachments: true });
  });
}

const LAYOUTS: readonly FileSeed[] = [
  {
    id: 'att-direction-1',
    name: 'direction-one-quiet.pdf',
    mime: 'application/pdf',
    size: 482_113,
  },
  {
    id: 'att-direction-2',
    name: 'direction-two-dense.pdf',
    mime: 'application/pdf',
    size: 611_902,
  },
  { id: 'att-notes', name: 'review-notes.txt', mime: 'text/plain', size: 2_204 },
];

/** An original newsletter: one remote picture, two tracking pixels, a data: picture, text, a link. */
const NEWSLETTER_HTML = `<div style="font-family:Georgia,serif;color:#2b2a27;max-width:560px">
<h2 style="margin:0 0 8px">Hollow Creek studio notes</h2>
<p>The autumn open day is on Saturday. Come and see the new print room, the quiet corner for reading and the
finished layouts for the garden project.</p>
<img src="https://pictures.hollowcreek.example/open-day/print-room.jpg" alt="The print room" width="520" height="150" style="display:block;background:#ece8df">
<p>Doors open at ten. There is tea and there are seed cakes. <a href="https://hollowcreek.example/open-day">Details and map</a></p>
<img src="https://stats.hollowcreek.example/open.gif?u=1" width="1" height="1" alt="">
<img src="https://stats.hollowcreek.example/open.gif?u=2" width="1" height="1" alt="">
<p style="color:#6b675f;font-size:13px">You are receiving this because you joined the studio list.</p></div>`;

/** The same note after its pictures are allowed: the pixels still go, the data: picture stays. */
const CLEAN_HTML = `<div style="font-family:Georgia,serif;color:#2b2a27;max-width:560px">
<h2 style="margin:0 0 8px">Hollow Creek studio notes</h2>
<p>The autumn open day is on Saturday. Come and see the new print room, the quiet corner for reading and the
finished layouts for the garden project.</p>
<img alt="A paper-coloured banner" width="520" height="60" style="display:block" src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='520' height='60'%3E%3Crect width='520' height='60' fill='%23ece8df'/%3E%3C/svg%3E">
<p>Doors open at ten. There is tea and there are seed cakes. <a href="https://hollowcreek.example/open-day">Details and map</a></p>
<img src="https://stats.hollowcreek.example/open.gif?u=1" width="1" height="1" alt="">
<img src="https://stats.hollowcreek.example/open.gif?u=2" width="1" height="1" alt="">
<img src="https://stats.hollowcreek.example/open.gif?u=3" width="1" height="1" alt="">
<p style="color:#6b675f;font-size:13px">You are receiving this because you joined the studio list.</p></div>`;

const PLAIN_TEXT =
  'Hi Alex,\n\nThe two layout directions are ready for your review.\n\n1. Quiet: the story first, with room around it.\n2. Dense: the weekly plan first, the story below.\n\nThe notes are plain text on purpose, so they read the same on any screen.\n\nCan you send me your preference by tomorrow?\n\nJordan';

/* ------------------------------ the gate in front of the data layer ------------------------------ */

/** What the gate changes about one message's body. */
interface BodyPatch {
  /** Plain text: the body is escaped host text, not a frame. */
  readonly text?: string;
  /** HTML for the frame, as a sender wrote it. */
  readonly html?: string;
  /** The body holds remote images (the "Load images from this sender" line). */
  readonly remoteImages?: boolean;
  /** The body never arrives (the loading line). */
  readonly stall?: boolean;
  /** The body cannot be loaded. */
  readonly fail?: boolean;
}

const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

type Calls = Record<string, (args: Record<string, unknown>, pass: Pass) => Promise<unknown>>;

function gateCalls(patches: Readonly<Record<string, BodyPatch>>): Calls {
  const patchOf = (args: Record<string, unknown>) => patches[String(args['messageId'])];
  return {
    'MessageBody/get': async (args, pass) => {
      const patch = patchOf(args);
      if (patch?.fail) throw new Error('The body could not be fetched.');
      if (patch?.stall) return new Promise<never>(() => undefined);
      const body = (await pass('MessageBody/get', args)) as Record<string, unknown>;
      if (!patch) return body;
      const text = patch.text ?? body['text'];
      const bodyKind = patch.text !== undefined ? 'text' : 'html';
      return { ...body, bodyKind, text, hasRemoteImages: patch.remoteImages === true };
    },
    'Mail/frame': async (args, pass) => {
      const frame = (await pass('Mail/frame', args)) as Record<string, unknown>;
      const html = patchOf(args)?.html;
      if (html === undefined) return frame;
      const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;
      return {
        ...frame,
        srcdoc: `<!doctype html><meta charset="utf-8">${meta}<body>${html}</body>`,
      };
    },
  };
}

function gated(session: EngineSession, calls: Calls): EngineSession {
  const pass: Pass = (method, args) => session.call(method, args);
  return {
    call(method, args, options) {
      const call = calls[method];
      if (!call) return session.call(method, args, options);
      return call((args ?? {}) as Record<string, unknown>, pass);
    },
    subscribe: listener => session.subscribe(listener),
    close: () => session.close(),
  };
}

/* ------------------------------ the scenes ------------------------------ */

/** One thing the scene does once the screen has painted. */
type Step =
  | {
      readonly key: string;
      readonly times?: number;
      readonly meta?: boolean;
      readonly shift?: boolean;
    }
  | { readonly click: string; readonly text?: string }
  | { readonly type: string; readonly into: string }
  | { readonly press: string; readonly on: string }
  | { readonly wait: number }
  | { readonly run: (world: World) => Promise<void> };

interface ReaderScene {
  readonly scenario?: Scenario;
  /** The engine's long timers (a held send's undo window) never fire, so the state stays as drawn however long it is looked at. */
  readonly steady?: boolean;
  /** The thread the reader opens on; absent: the compose page opens. */
  readonly thread?: string;
  /** The ids J and K walk, as a list screen would hand them over. */
  readonly list?: readonly string[];
  readonly seed?: (fx: Fixture) => void;
  readonly bodies?: Readonly<Record<string, BodyPatch>>;
  /** What the screen has when it is ready; the scene waits for it before the steps. */
  readonly ready?: string;
  readonly steps?: readonly Step[];
  /** The compose page opens on this saved draft. */
  readonly draftId?: string;
  /** The card treatment the reader and the compose page draw (CardStyleContext); absent: 'a', the default. */
  readonly cards?: CardStyle;
}

interface World {
  readonly engine: FixtureEngine;
  readonly client: AppClient;
}

let booted: World | null = null;

/** The wall clock, except that nothing five seconds or more away ever comes due. */
function steadyClock(): FixtureClock {
  const real = realClock();
  return { ...real, after: (ms, fn) => (ms >= 5_000 ? () => undefined : real.after(ms, fn)) };
}

function boot(scene: ReaderScene): World {
  if (booted) return booted;
  const clock = scene.steady ? steadyClock() : 'real';
  const standIn = connectStandIn({ scenario: scene.scenario ?? 'demo', clock });
  const engine = standIn.engine as FixtureEngine;
  scene.seed?.(engine.fixture);
  const session = gated(withNativeStubs(inProcessTransport(engine)), gateCalls(scene.bodies ?? {}));
  connectDataLayer({ session });
  booted = { engine, client: createClient(engine.connect()) };
  return booted;
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await nextFrame();
}

async function until(selector: string, limit = 400): Promise<void> {
  for (let i = 0; i < limit && !document.querySelector(selector); i += 1) await nextFrame();
}

function setValue(selector: string, text: string): void {
  const field = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
  if (!field) return;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickMatching(selector: string, text: string | undefined): void {
  const named = (el: HTMLElement) =>
    `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find(
    el => text === undefined || named(el).includes(text),
  );
  found?.click();
}

async function runStep(step: Step, world: World): Promise<void> {
  if ('key' in step) {
    for (let i = 0; i < (step.times ?? 1); i += 1) {
      const init = { key: step.key, metaKey: step.meta, shiftKey: step.shift, bubbles: true };
      window.dispatchEvent(new KeyboardEvent('keydown', init));
      await frames(2);
    }
  } else if ('click' in step) {
    clickMatching(step.click, step.text);
  } else if ('type' in step) {
    setValue(step.into, step.type);
  } else if ('press' in step) {
    const init = { key: step.press, bubbles: true };
    document.querySelector(step.on)?.dispatchEvent(new KeyboardEvent('keydown', init));
  } else if ('wait' in step) {
    await new Promise(resolve => setTimeout(resolve, step.wait));
  } else {
    await step.run(world);
  }
  await frames(8);
  // The engine's frames land on timers, not frames.
  await new Promise(resolve => setTimeout(resolve, 400));
}

function useScene(scene: ReaderScene): AppClient {
  const world = boot(scene);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void (async () => {
      await until(scene.ready ?? '.aplos-reader__letter[data-paper="true"] .ui-thread-message');
      await frames(12);
      for (const step of scene.steps ?? [])
        await runStep(step, world).catch((error: unknown) => console.error('step failed', error));
      document.querySelector('[data-gallery-pending]')?.removeAttribute('data-gallery-pending');
    })();
  }, [scene, world]);
  return world.client;
}

function sceneOf(scene: ReaderScene): () => ReactElement {
  return function ReaderStateScene(): ReactElement {
    const client = useScene(scene);
    if (scene.thread)
      openThread(scene.thread, { from: 'home', ...(scene.list ? { listIds: scene.list } : {}) });
    else if (scene.draftId) openCompose({ draftId: scene.draftId });
    else openCompose();
    return (
      <CardStyleContext.Provider value={scene.cards ?? 'a'}>
        <App client={client} />
        <div hidden data-gallery-pending="" />
      </CardStyleContext.Provider>
    );
  };
}

/* ------------------------------ steps ------------------------------ */

/** The submission the composer just made. */
function lastSubmission(world: World) {
  return world.engine.fixture.store.all('Submission').at(-1);
}

function forceSubmission(
  state: 'failed' | 'uncertain' | 'suspended',
  problem?: { reasonCode: string; untilInMs?: number },
): Step {
  return {
    run: async world => {
      const row = lastSubmission(world);
      if (!row) return;
      await fixtureControl(world.engine).setSubmissionState({
        submissionId: row.id,
        state,
        ...(problem
          ? {
              problem: {
                reasonCode: problem.reasonCode,
                ...(problem.untilInMs ? { until: Date.now() + problem.untilInMs } : {}),
              },
            }
          : {}),
      });
    },
  };
}

/** R on the open thread, the stand-in's saved reply draft in the card, then Send. */
const TYPE_REPLY: Step = { type: REPLY_TEXT, into: '.ui-inline-reply textarea' };

/**
 * The harness freezes `Date`, but the loading line counts 1.5 s on it. This moves the page's clock on by two seconds
 * (timers keep their own time), as if the wanted body had been awaited that long.
 */
const LET_TWO_SECONDS_PASS: Step = {
  run: async () => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + 2_000;
  },
};

/** A toast stays until the shot is taken, however long the state is looked at (plain toasts last 4 s, Undo toasts 8 s). */
const KEEP_TOASTS: Step = {
  run: async () => {
    for (const toast of getToasts()) updateToast(toast.id, { persistent: true });
  },
};

/** Send at once (no undo window), so a send from an offline account is queued where the toast says so. */
const NO_UNDO_WINDOW: Step = {
  run: async world => {
    await world.client.api.settings.set({
      opId: 'visual-undo-window',
      patch: { mail: { undoSendSeconds: 0 } },
    });
  },
};

const SEND_REPLY: readonly Step[] = [
  { key: 'r' },
  { wait: 300 },
  TYPE_REPLY,
  { key: 'Enter', meta: true },
  { wait: 400 },
];

const THREE_WAY: readonly Earlier[] = [CHAT[0]!, CHAT[1]!, CHAT[2]!];

/* ------------------------------ the fuller demo threads (readerDemo.ts) ------------------------------ */

const richThreadId = (def: DemoThread) => `${WORK}:rich-${def.key}`;
const richMessageId = (def: DemoThread, index: number) => `${richThreadId(def)}.m${index + 1}`;

/** The words of an HTML body, for the stand-in's plain copy (snippets, search). */
function wordsOfHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A snippet the way a list shows it: no quoted lines, one line of words. */
function snippetOf(message: DemoMessage): string {
  const plain = message.text ?? wordsOfHtml(message.html ?? '');
  const own = plain
    .split('\n')
    .filter(line => !line.startsWith('>'))
    .join(' ');
  return own.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function personOf(person: Person) {
  return { name: person.name, address: person.address };
}

interface RichOptions {
  /** Draw the thread with no AI summary at all. */
  readonly noSummary?: boolean;
  /** Attachment ids whose download has failed. */
  readonly failedFiles?: readonly string[];
}

function attachmentsOf(def: DemoThread, message: DemoMessage, failed: readonly string[]) {
  return (message.files ?? []).map(file => ({
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size,
    inline: false,
    state: failed.includes(file.id) ? ('failed' as const) : ('present' as const),
  }));
}

/** A demo invitation as the stand-in's `Event` row, carried by the thread's latest message (the demo invite as template). */
function seedRichEvent(fx: Fixture, def: DemoThread, event: DemoEvent): string | undefined {
  const template = fx.store.get('Event', `${WORK}:ev-review`);
  if (!template) return undefined;
  const id = `${WORK}:ev-rich-${def.key}`;
  const organizer = {
    ...personOf(event.organizer),
    response: 'accepted',
    organizer: true,
    self: false,
  };
  const guests = event.guests.map(p => ({
    ...personOf(p),
    response: 'needsAction',
    organizer: false,
    self: p.address === ALEX.address,
  }));
  fx.write({ kind: 'Fixture/control' }, tx => {
    tx.put('Event', {
      ...template,
      id,
      rev: 0,
      title: event.title,
      start: { type: 'utc', utc: Date.parse(event.start) },
      end: { type: 'utc', utc: Date.parse(event.end) },
      location: event.location,
      description:
        'Three logo routes and the colour palette, then what goes to the client on Friday.',
      organizer,
      attendees: [organizer, ...guests],
      invite: {
        threadId: richThreadId(def),
        messageId: richMessageId(def, def.messages.length - 1),
        fromName: event.organizer.name,
      },
    });
  });
  return id;
}

/** One demo thread into the stand-in's store: its messages (oldest first), their bodies and files, and the thread row. */
function seedRichThread(fx: Fixture, def: DemoThread, options: RichOptions = {}): void {
  const base = fx.store.get('Thread', DESIGN);
  const template = fx.store.get('Message', `${DESIGN}.m1`);
  if (!base || !template) return;
  const failed = options.failedFiles ?? [];
  const bytes = new TextEncoder().encode('Original demo file.\n') as Uint8Array<ArrayBuffer>;
  const labels = [`${WORK}:INBOX`, `${WORK}:IMPORTANT`];
  def.messages.forEach((message, index) => {
    const id = richMessageId(def, index);
    const plain = message.text ?? wordsOfHtml(message.html ?? '');
    fx.bodies[id] = plain;
    for (const file of message.files ?? [])
      fx.files[`${id}/${file.id}`] = { bytes, mime: file.mime, name: file.name };
    fx.write({ kind: 'Fixture/control' }, tx => {
      tx.put('Message', {
        ...template,
        id,
        threadId: richThreadId(def),
        rev: 0,
        from: personOf(message.from),
        to: message.to.map(personOf),
        cc: (message.cc ?? []).map(personOf),
        subject: def.subject,
        snippet: snippetOf(message),
        date: Date.parse(message.at),
        seen: true,
        fromMe: message.from.address === ALEX.address,
        labels,
        attachments: attachmentsOf(def, message, failed),
        bodyKind: message.text !== undefined ? 'text' : 'html',
      });
    });
  });
  const last = def.messages[def.messages.length - 1]!;
  const people = new Map<string, Person>();
  for (const message of def.messages)
    for (const person of [message.from, ...message.to, ...(message.cc ?? [])])
      people.set(person.address, person);
  const summary = options.noSummary ? { state: 'none' as const } : def.summary;
  const eventId = def.event ? seedRichEvent(fx, def, def.event) : undefined;
  fx.write({ kind: 'Fixture/control' }, tx => {
    tx.put('Thread', {
      ...base,
      id: richThreadId(def),
      rev: 0,
      subject: def.subject,
      snippet: snippetOf(last),
      fromName: last.from.name,
      participants: [...people.values()].slice(0, 6).map(p => ({
        ...personOf(p),
        ...(p.address === ALEX.address ? { me: true } : {}),
      })),
      lastDate: Date.parse(last.at),
      lastInboundDate: Date.parse(last.at),
      messageCount: def.messages.length,
      unreadCount: 0,
      unread: false,
      hasAttachments: def.messages.some(m => (m.files ?? []).length > 0),
      labels,
      workflow: { status: 'new', bookmarked: false, hiddenFromHome: false, replyStatus: 'none' },
      rank: { lane: def.lane, importance: 'important', source: 'ai', dueBand: 3 },
      summary: {
        ...summary,
        ...(summary.state === 'ready' ? { provider: 'groq', model: 'openai/gpt-oss-120b' } : {}),
      },
      unsubscribe: def.unsubscribe === true,
      ...(eventId ? { eventId } : {}),
    });
  });
}

/** What the gate says about each message of a demo thread: the text or HTML it was written in. */
function richBodies(def: DemoThread, stalled: boolean): Record<string, BodyPatch> {
  const patches: Record<string, BodyPatch> = {};
  def.messages.forEach((message, index) => {
    const body: BodyPatch =
      message.text !== undefined
        ? { text: message.text }
        : { html: message.html ?? '', remoteImages: message.remoteImages === true };
    patches[richMessageId(def, index)] = stalled ? { ...body, stall: true } : body;
  });
  return patches;
}

interface RichScene extends Omit<ReaderScene, 'thread' | 'seed' | 'bodies' | 'list'>, RichOptions {
  /** The demo thread the reader opens on. */
  readonly open?: DemoKey;
  /** Further demo threads in the store (J walks from `open` to the next of `walk`). */
  readonly also?: readonly DemoKey[];
  readonly walk?: readonly DemoKey[];
  /** The demo thread whose bodies never arrive. */
  readonly stalled?: DemoKey;
}

export function richScene(options: RichScene): () => ReactElement {
  const { open, also = [], walk, stalled, noSummary, failedFiles, ...scene } = options;
  const keys: readonly DemoKey[] = open ? [open, ...also] : also;
  const patches = keys.reduce<Record<string, BodyPatch>>(
    (all, key) => ({ ...all, ...richBodies(DEMO[key], key === stalled) }),
    {},
  );
  return sceneOf({
    ...scene,
    ...(open ? { thread: richThreadId(DEMO[open]) } : {}),
    ...(walk ? { list: walk.map(key => richThreadId(DEMO[key])) } : {}),
    seed: fx => {
      for (const key of keys) seedRichThread(fx, DEMO[key], { noSummary, failedFiles });
      if (scene.draftId === NEW_MESSAGE_DRAFT) seedNewMessageDraft(fx);
    },
    bodies: patches,
  });
}

/** Scrolls the pane the open letter sits in to its end, where the Reply stub is. */
export const OPEN_DETAILS: Step = { click: '.aplos-recipients__button' };
const SCROLL_TO_END: Step = {
  run: async () => {
    const letter = document.querySelector('.aplos-reader__letter[data-paper="true"]');
    for (let el = letter?.parentElement; el; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
      el.scrollTop = el.scrollHeight;
      return;
    }
  },
};

/** Waits (up to 6 s) until the draft line no longer says "Saving…", so a shot never catches the transient. */
const LET_THE_DRAFT_SETTLE: Step = {
  run: async () => {
    for (
      let i = 0;
      i < 360 && document.querySelector('.ui-draft-state[data-state="saving"]');
      i += 1
    )
      await nextFrame();
  },
};

const REPLY_TO_PROJECT: readonly Step[] = [
  { key: 'r' },
  { wait: 300 },
  { type: REPLY_DRAFT, into: '.ui-inline-reply textarea' },
  { wait: 300 },
  LET_THE_DRAFT_SETTLE,
];

export const readerScenes: Record<string, () => ReactElement> = {
  'reader-full': sceneOf({
    thread: DESIGN,
    seed: fx => seedEarlier(fx, DESIGN, [CHAT[1]!]),
  }),
  'reader-no-summary': sceneOf({ scenario: 'ai-off', thread: DESIGN }),
  'reader-plain-text': sceneOf({
    thread: DESIGN,
    bodies: { [`${DESIGN}.m1`]: { text: PLAIN_TEXT } },
  }),
  'reader-long-thread': sceneOf({
    thread: DESIGN,
    seed: fx => seedEarlier(fx, DESIGN, CHAT),
  }),
  'reader-earlier-collapsed': sceneOf({
    thread: DESIGN,
    seed: fx => seedEarlier(fx, DESIGN, THREE_WAY),
  }),
  'reader-earlier-expanded': sceneOf({
    thread: DESIGN,
    seed: fx => seedEarlier(fx, DESIGN, THREE_WAY),
    steps: [{ key: 'ArrowUp' }, { key: 'o' }],
  }),
  'reader-attachments': sceneOf({
    thread: DESIGN,
    seed: fx => seedFiles(fx, DESIGN, LAYOUTS),
  }),
  'reader-attachment-failed': sceneOf({
    thread: DESIGN,
    seed: fx =>
      seedFiles(fx, DESIGN, [LAYOUTS[0]!, { ...LAYOUTS[1]!, state: 'failed' }, LAYOUTS[2]!]),
  }),
  'reader-images-blocked': sceneOf({
    thread: DESIGN,
    bodies: { [`${DESIGN}.m1`]: { html: NEWSLETTER_HTML, remoteImages: true } },
  }),
  'reader-trackers-removed': sceneOf({
    thread: DESIGN,
    bodies: { [`${DESIGN}.m1`]: { html: CLEAN_HTML } },
  }),
  'reader-find': sceneOf({
    thread: DESIGN,
    steps: [
      { key: 'f', meta: true },
      { wait: 200 },
      { type: 'layout', into: '.aplos-reader__find input' },
    ],
  }),
  'reader-loading-line': sceneOf({
    thread: DESIGN,
    bodies: { 'demo-personal:garden.m1': { stall: true } },
    steps: [{ key: 'j' }, LET_TWO_SECONDS_PASS, { wait: 1_900 }],
  }),
  'reader-body-failed': sceneOf({
    thread: DESIGN,
    bodies: { [`${DESIGN}.m1`]: { fail: true } },
    ready: '.aplos-reader .ui-error-line',
  }),
  'reader-thread-gone': sceneOf({
    thread: `${WORK}:no-such-thread`,
    ready: '.aplos-reader .ui-empty-line, .aplos-reader p',
  }),
  'inline-reply-open': sceneOf({
    thread: DESIGN,
    steps: [{ key: 'r' }, { wait: 300 }, TYPE_REPLY, { wait: 300 }],
  }),
  'inline-reply-ai-draft': sceneOf({
    thread: SENT,
    steps: [{ key: ' ' }, { wait: 600 }],
  }),
  'inline-reply-dictating': DictatingScene,
  'inline-reply-discard-confirm': sceneOf({
    thread: DESIGN,
    steps: [
      { key: 'r' },
      { wait: 300 },
      TYPE_REPLY,
      { wait: 300 },
      { click: '.ui-inline-reply button', text: 'More' },
      { wait: 200 },
      { click: '[role="menuitem"]', text: 'Discard draft' },
      { wait: 300 },
    ],
  }),
  'compose-new': sceneOf({ ready: '.ui-composer' }),
  'compose-schedule-menu': sceneOf({
    ready: '.ui-composer',
    steps: [{ key: '/', meta: true }, { wait: 300 }],
  }),
  'send-held-tray': sceneOf({ steady: true, thread: DESIGN, steps: SEND_REPLY }),
  'send-scheduled-toast': sceneOf({
    steady: true,
    thread: DESIGN,
    steps: [
      { key: 'r' },
      { wait: 300 },
      TYPE_REPLY,
      { wait: 300 },
      { click: '.ui-inline-reply button', text: 'More' },
      { wait: 200 },
      { click: '[role="menuitem"]', text: 'Tomorrow' },
      { wait: 600 },
      KEEP_TOASTS,
    ],
  }),
  'send-offline': sceneOf({
    steady: true,
    scenario: 'offline',
    thread: DESIGN,
    steps: [NO_UNDO_WINDOW, ...SEND_REPLY, KEEP_TOASTS],
  }),
  'send-failed': sceneOf({
    steady: true,
    thread: DESIGN,
    steps: [...SEND_REPLY, forceSubmission('failed', { reasonCode: 'send.failed' })],
  }),
  'send-deferred': sceneOf({
    steady: true,
    thread: DESIGN,
    steps: [
      ...SEND_REPLY,
      forceSubmission('failed', { reasonCode: 'rate.day', untilInMs: 4 * HOUR }),
    ],
  }),
  'send-uncertain': sceneOf({
    steady: true,
    thread: DESIGN,
    steps: [...SEND_REPLY, forceSubmission('uncertain')],
  }),
  'send-suspended': sceneOf({
    steady: true,
    thread: DESIGN,
    steps: [...SEND_REPLY, forceSubmission('suspended')],
  }),
  'reader-rich-project': richScene({ open: 'project' }),
  'reader-rich-project-expanded': richScene({
    open: 'project',
    steps: [
      { click: '.ui-thread-message__toggle', text: 'Agreed on the list' },
      { key: 'ArrowUp' },
      { key: 'o' },
    ],
  }),
  'reader-rich-details': richScene({ open: 'project', steps: [OPEN_DETAILS] }),
  'reader-rich-attachments': richScene({ open: 'files' }),
  'reader-rich-attachment-failed': richScene({
    open: 'files',
    failedFiles: ['att-photos'],
    steps: [SCROLL_TO_END],
  }),
  'reader-rich-invite': richScene({ open: 'invite' }),
  'reader-rich-oneliner': richScene({ open: 'oneliner' }),
  'reader-rich-receipt': richScene({ open: 'receipt' }),
  'reader-rich-newsletter': richScene({ open: 'newsletter' }),
  'reader-rich-newsletter-bottom': richScene({ open: 'newsletter', steps: [SCROLL_TO_END] }),
  'reader-rich-no-attachments': richScene({ open: 'oneliner', steps: [{ key: 'o' }] }),
  'reader-rich-loading': richScene({
    open: 'oneliner',
    also: ['project'],
    walk: ['oneliner', 'project'],
    stalled: 'project',
    steps: [{ key: 'j' }, LET_TWO_SECONDS_PASS, { wait: 1_900 }],
  }),
  'reader-rich-no-summary': richScene({ open: 'project', noSummary: true }),
  'compose-rich-reply-draft': richScene({ open: 'project', steps: REPLY_TO_PROJECT }),
  'compose-rich-new': richScene({
    ready: '.ui-composer',
    draftId: NEW_MESSAGE_DRAFT,
  }),
  'compose-rich-empty': richScene({ ready: '.ui-composer' }),
  ...offScenes(),
};

/** The card-less column behind the switch (`cards: 'off'`): the project thread and the new-message page. */
function offScenes(): Record<string, () => ReactElement> {
  const cards = 'off';
  return {
    'reader-card-off-project': richScene({ cards, open: 'project' }),
    'compose-card-off-new': richScene({
      cards,
      ready: '.ui-composer',
      draftId: NEW_MESSAGE_DRAFT,
    }),
  };
}
