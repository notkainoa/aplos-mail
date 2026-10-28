/**
 * Preview fixtures for lane `ui-ask`: every state the harness captures for the Ask dock, Today, the ⌘K palette and
 * the Search page (DESIGN §7.7, §7.9, §7.14, §7.15). Each state goes through the lane's real models (`dockView`,
 * `todayModel`, `paletteView` over the app registry, `searchPage`) and the presentational screens, from hand-written
 * contract values. Original demo data only: invented people on example domains, no real mail, addresses or keys.
 *
 * `layout` places the screen in the 1440 × 900 window: 'dock' is the 360 px second pane beside an empty main pane,
 * 'pane' fills the main pane (Search), 'overlay' draws the palette over an empty pane.
 */
import type { JSX } from 'react';
import {
  createAppRegistry,
  type CommandContext,
  type PaletteChild,
  type Registry,
  type TargetSummary,
} from '../../../commands';
import { COMMANDS, CONTROLS } from '../../../commands/internal';
import { DEFAULT_KEY_PREFS } from '../../../commands';
import type {
  AskTurn,
  Citation,
  Conversation,
  Event,
  ProgressFrame,
  Proposal,
  ThreadRow,
} from '../../../data';
import type { DictationState } from '../../../ui/props';
import { AskPanel, type AskPanelHandlers } from '../AskPanel';
import { dockView, initialAsk, setField, type AskInputs, type AskState } from '../ask.model';
import { Today } from '../../today/Today';
import { todayModel, type TodayCalendar } from '../../today/today.model';
import { PaletteScreen } from '../../palette/PaletteScreen';
import {
  applyRun,
  openPalette,
  paletteView,
  setQuery,
  type PaletteState,
  type RunTarget,
} from '../../palette/palette.model';
import { SearchPage } from '../../search/SearchPage';
import {
  initialSearch,
  remoteFrame,
  remoteStarted,
  resultRow,
  searchPage,
  submit as submitSearch,
  typeField,
  type LocalResults,
  type SearchState,
} from '../../search/search.model';

export type Layout = 'dock' | 'pane' | 'overlay';
export interface StateEntry {
  title: string;
  layout: Layout;
  render: () => JSX.Element;
}

const noop = () => undefined;
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
/** The harness clock: Thursday, October 29, 2026, 10:00 AM. */
const NOW = at(29, 10);
/** Recents and sources are shown relative to the real clock by the components, so their fixtures are too. */
const ago = (ms: number) => Date.now() - ms;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ───────────────────────── Ask ───────────────────────── */

const calendars = new Map<string, TodayCalendar>([
  ['work', { id: 'work', name: 'Work', color: 'hill' }],
  ['hollow', { id: 'hollow', name: 'Hollow Creek', color: 'ember' }],
  ['personal', { id: 'personal', name: 'Personal', color: 'sky' }],
]);

const providers = [
  { id: 'groq', label: 'Groq', local: false, status: 'ready' },
  { id: 'ollama', label: 'Ollama', local: true, status: 'ready' },
];

function message(
  n: number,
  fromName: string,
  subject: string,
  quote: string,
  when: number,
): Citation {
  return {
    kind: 'message',
    n,
    messageId: `m${n}`,
    threadId: `t${n}`,
    quote,
    fromName,
    date: when,
    subject,
  };
}

const REVIEW = message(
  1,
  'Mina Cho',
  'Hollow Creek review',
  'Let’s hold the design review Thursday from 2:00 to 2:30.',
  ago(DAY),
);
const LAYOUT = message(
  2,
  'Jordan Park',
  'Two layout directions',
  'Could you pick a layout by tomorrow?',
  ago(3 * HOUR),
);
const ANSWER =
  'Mina’s note puts the design review with you and Jordan at Thursday, 2:00–2:30 PM. Jordan also wants your layout pick by tomorrow. The review isn’t on your calendar yet.';
const STEPS = [
  { id: 's1', text: 'Searched mail for “design review”', state: 'done' },
  { id: 's2', text: 'Read 14 emails from Jordan', state: 'done', count: 14 },
  { id: 's3', text: 'Checked your Work and Hollow Creek calendars', state: 'done' },
];
const EVENT_PROPOSAL: Proposal = {
  kind: 'addEvent',
  id: 'p-review',
  consequence: 'Add to Calendar · Thu 2:00–2:30 PM · Hollow Creek',
  state: 'open',
  calendarId: 'hollow',
  event: {
    title: 'Design review',
    start: { type: 'utc', utc: at(29, 14) },
    end: { type: 'utc', utc: at(29, 14, 30) },
    allDay: false,
  },
};

function turn(id: string, question: string, rest: Partial<AskTurn>): AskTurn {
  return {
    id,
    question,
    citations: [],
    noSource: true,
    proposals: [],
    steps: [],
    createdAt: NOW,
    model: { provider: 'groq', model: 'demo' },
    ...rest,
  };
}

function conversation(turns: AskTurn[]): Conversation {
  return { id: 'conv-1', rev: 1, title: turns[0]?.question ?? '', updatedAt: NOW, turns };
}

function inputs(extra: Partial<AskInputs> = {}): AskInputs {
  return {
    frames: [],
    providers,
    askReady: true,
    askModel: { provider: 'groq', model: 'demo' },
    calendars,
    accountNames: new Map([['acc-work', 'Work']]),
    suggestions: [
      'What needs a reply from me today?',
      'When am I free tomorrow afternoon?',
      'Summarize this week’s mail from Jordan',
    ],
    recents: [
      { id: 'c1', title: 'Is the Saturday dinner still on?', updatedAt: ago(20 * 60_000) },
      { id: 'c2', title: 'Invoices from Drew this month', updatedAt: ago(DAY) },
      { id: 'c3', title: 'What did Priya send about the deck?', updatedAt: ago(3 * DAY) },
    ],
    ...extra,
  };
}

const handlers: AskPanelHandlers = {
  onTabChange: noop,
  onClose: noop,
  onWidthChange: noop,
  onOpenSettings: noop,
  onChange: noop,
  onSubmit: noop,
  onStop: noop,
  onQueuedChange: noop,
  onSendQueuedNow: noop,
  onPickSuggestion: noop,
  onOpenRecent: noop,
  onToggleSteps: noop,
  onOpenCitation: noop,
  onOpenEventCitation: noop,
  onRetry: noop,
  onUseAnotherProvider: noop,
  onConfirmProposal: noop,
  onDismissProposal: noop,
};

function dock(
  state: AskState,
  input: AskInputs,
  options: { tab?: 'ask' | 'today'; dictation?: DictationState } = {},
) {
  return (
    <AskPanel
      view={dockView(state, input)}
      tab={options.tab ?? 'ask'}
      width={360}
      today={<TodayFixture events={busyDay()} />}
      dictation={options.dictation}
      handlers={handlers}
    />
  );
}

let seq = 0;
function frame(kind: ProgressFrame['kind'], extra: Partial<ProgressFrame> = {}): ProgressFrame {
  seq += 1;
  return {
    frame: 'progress',
    dbEpoch: 'demo',
    seq,
    runId: 'r',
    source: 'ask',
    kind,
    turnId: 'live',
    ...extra,
  } as ProgressFrame;
}

/** A run on its way, with these frames so far. */
function running(question: string, field = '', queued: string[] = []): AskState {
  return {
    ...setField(initialAsk, field),
    conversationId: 'conv-1',
    run: {
      clientId: 'ask-1',
      question,
      searchAll: false,
      runId: 'r',
      stopped: false,
      settled: false,
    },
    queued: queued.map((text, i) => ({ id: `q${i}`, text, searchAll: false })),
  };
}

const answered = { ...initialAsk, conversationId: 'conv-1' };

/** Offsets just after each sentence's full stop, where an engine puts its chips. */
function sentenceEnds(text: string): number[] {
  return [...text.matchAll(/[。.]/g)].map(m => m.index + 1);
}

/* ───────────────────────── Today ───────────────────────── */

let eventSeq = 0;
function event(
  title: string,
  calendarId: string,
  start: number,
  end: number,
  extra: Partial<Event> = {},
): Event {
  eventSeq += 1;
  return {
    id: `e${eventSeq}`,
    rev: 1,
    accountId: 'acc',
    calendarId,
    recurring: false,
    exception: false,
    title,
    start: { type: 'utc', utc: start },
    end: { type: 'utc', utc: end },
    allDay: false,
    attendees: [],
    status: 'confirmed',
    can: { edit: true, move: true, delete: true, rsvp: false, editGuests: true },
    sync: 'synced',
    ...extra,
  };
}

function busyDay(): Event[] {
  return [
    event('Northwind Dental', 'personal', at(29, 9, 30), at(29, 10)),
    event('Standup', 'work', at(29, 11), at(29, 11, 15)),
    event('Design review with Mina and Jordan', 'hollow', at(29, 14), at(29, 14, 30)),
    event('Climbing with Theo', 'personal', at(29, 17, 30), at(29, 19)),
    event('Budget sync', 'work', at(29, 12), at(29, 13), { myResponse: 'declined' }),
  ];
}

function TodayFixture({ events }: { events: Event[] }) {
  return (
    <Today
      model={todayModel(events, calendars, NOW)}
      onSelect={noop}
      onOpenEvent={noop}
      onOpenCalendar={noop}
      onNewEvent={noop}
    />
  );
}

/* ───────────────────────── Palette ───────────────────────── */

const LABELS: PaletteChild[] = [
  { id: 'label-receipts', label: 'Receipts', detail: 'alex@example.com', run: noop },
  { id: 'label-hollow', label: 'Hollow Creek', detail: 'alex@example.com', run: noop },
  { id: 'label-family', label: 'Family', detail: 'alex@example.com', run: noop },
  { id: 'label-travel', label: 'Travel', detail: 'alex@example.com', run: noop },
];

function registry(): Registry {
  const r = createAppRegistry();
  for (const spec of [...COMMANDS, ...CONTROLS]) {
    if (spec.id === 'mail.suggested')
      r.attach(spec.id, { run: noop, labelFor: () => 'Approve the invoice' });
    else if (spec.id === 'mail.moveToLabel')
      r.attach(spec.id, { run: noop, children: () => LABELS });
    else if ('page' in spec && spec.page) r.attach(spec.id, { run: noop, children: () => [] });
    else if (spec.id === 'ask.open') {
      r.attach(spec.id, {
        run: noop,
        labelFor: ctx => (ctx.target?.kind === 'thread' ? 'Ask about this email' : undefined),
        suggested: ctx => ctx.target?.kind === 'thread',
      });
    } else r.attach(spec.id, { run: noop });
  }
  return r;
}

const DREW: TargetSummary = {
  kind: 'thread',
  id: 't-drew',
  title: 'Drew Bell',
  detail: 'Invoice 412 · October illustrations',
};

function context(
  target: TargetSummary | null,
  stack: CommandContext['stack'] = ['global', 'list', 'home', 'palette'],
): CommandContext {
  return { stack, target, selection: [], conditions: {}, prefs: DEFAULT_KEY_PREFS, focus: 'text' };
}

function palette(
  state: PaletteState,
  ctx: CommandContext,
  reg = registry(),
  recents: string[] = [],
) {
  const view = paletteView(state, { ctx, entries: reg.commandsForPalette(ctx), recents });
  return (
    <PaletteScreen
      state={state}
      view={view}
      handlers={{
        onQueryChange: noop,
        onActiveChange: noop,
        onRun: noop,
        onBack: noop,
        onClose: noop,
        onConfirm: noop,
        onCancelConfirm: noop,
      }}
    />
  );
}

function ran(state: PaletteState, id: string, ctx: CommandContext, reg = registry()): PaletteState {
  const target: RunTarget = { kind: 'command', id };
  return applyRun(state, target, reg.run(id, ctx)).state;
}

/* ───────────────────────── Search ───────────────────────── */

function thread(
  id: string,
  fromName: string,
  subject: string,
  snippet: string,
  lastDate: number,
  extra: Partial<ThreadRow> = {},
): ThreadRow {
  return {
    id,
    accountId: 'acc',
    rev: 1,
    subject,
    snippet,
    fromName,
    participants: [],
    lastDate,
    messageCount: 2,
    unreadCount: 0,
    partial: false,
    unread: false,
    flagged: false,
    hasAttachments: false,
    labels: [],
    workflow: { status: 'new', bookmarked: false, hiddenFromHome: false },
    rank: { lane: 'update', importance: 'normal', source: 'heuristic', dueBand: 3 },
    summary: { state: 'none' },
    fromLater: false,
    unsubscribe: false,
    ...extra,
  } as ThreadRow;
}

const THREADS: ThreadRow[] = [
  thread(
    't1',
    'Jordan Park',
    'A quieter home for the Hollow Creek site',
    'Two layout directions are ready, one quieter and one bolder.',
    at(29, 10),
    { unread: true, hasAttachments: true },
  ),
  thread(
    't2',
    'Jordan Park',
    'Kicking off Hollow Creek',
    'Here is the brief we agreed on Friday, with the layout notes.',
    at(20, 9),
    { hasAttachments: true },
  ),
  thread(
    't3',
    'Jordan Park',
    'Sitemap v2',
    'Updated site map with the booking form on the first page.',
    at(14, 16),
    { hasAttachments: true },
  ),
  thread(
    't4',
    'Jordan Park',
    'Logo files',
    'The layout grid and logo files for the trail map, as promised.',
    at(8, 11),
    { hasAttachments: true },
  ),
];
const REMOTE: ThreadRow[] = [
  thread(
    'g1',
    'Jordan Park',
    'Layout feedback from the board',
    'The board liked the quieter layout for the landing page.',
    at(2, 15),
    { partial: true, hasAttachments: true },
  ),
];

function rowsById(list: ThreadRow[]) {
  return new Map(list.map(t => [t.id, t]));
}

function search(state: SearchState, local: LocalResults, rows: Map<string, ThreadRow>, now = NOW) {
  const model = searchPage(state, local, now);
  const toRow = (id: string, remote: boolean) => {
    const t = rows.get(id);
    return t ? resultRow(t, model.query, remote) : null;
  };
  return (
    <SearchPage
      model={model}
      localRows={model.localIds.map(id => toRow(id, false)).filter(r => r !== null)}
      remoteRows={model.remoteIds.map(id => toRow(id, true)).filter(r => r !== null)}
      cursorId={model.localIds.length > 0 ? `search-row-${model.localIds[0]}` : undefined}
      density="comfortable"
      showAccountDot={false}
      scopeLabel="All accounts"
      handlers={{
        onChange: noop,
        onRemoveToken: noop,
        onSubmit: noop,
        onLeaveToList: noop,
        onSelectRow: noop,
        onOpenRow: noop,
        onRowAction: noop,
      }}
    />
  );
}

function typed(text: string): SearchState {
  return typeField(initialSearch, text).state;
}

function asked(state: SearchState, localIds: string[], now: number): SearchState {
  const stepped = submitSearch(state, { now, supported: true, localIds });
  const effect = stepped.effects[0];
  return effect?.kind === 'remote'
    ? remoteStarted(stepped.state, effect.key, 'search-run')
    : stepped.state;
}

/* ───────────────────────── the table ───────────────────────── */

const live = (ids: string[], total = ids.length): LocalResults => ({ status: 'live', ids, total });

export const states: Record<string, StateEntry> = {
  'ask-empty': {
    title: 'Ask: empty, three suggestions and recent chats',
    layout: 'dock',
    render: () => dock(initialAsk, inputs()),
  },
  'ask-working': {
    title: 'Ask: one steady step line, a follow-up queued as an editable card',
    layout: 'dock',
    render: () =>
      dock(
        running('When is the Hollow Creek design review?', '', ['And is Mina free then?']),
        inputs({
          frames: [
            frame('step', {
              step: { id: 's1', text: 'Searched mail for “design review”', state: 'done' },
            }),
            frame('step', {
              step: {
                id: 's2',
                text: 'Reading 14 emails from Jordan',
                state: 'running',
                count: 14,
              },
            }),
          ],
        }),
      ),
  },
  'ask-streaming': {
    title: 'Ask: the answer streaming with one caret, a chip already placed',
    layout: 'dock',
    render: () =>
      dock(
        running('When is the Hollow Creek design review?'),
        inputs({
          frames: [
            ...STEPS.map(step => frame('step', { step })),
            frame('text', {
              delta:
                'Mina’s note puts the design review with you and Jordan at Thursday, 2:00–2:30 PM.',
            }),
            frame('citation', { citation: REVIEW }),
            frame('text', { delta: ' Jordan also wants' }),
          ],
        }),
      ),
  },
  'ask-answer': {
    title: 'Ask: serif answer, decisive fact, citations, folded step log, the proposal card',
    layout: 'dock',
    render: () =>
      dock(
        answered,
        inputs({
          conversation: conversation([
            turn('t-1', 'When is the Hollow Creek design review?', {
              answer: {
                blocks: [
                  {
                    text: ANSWER,
                    strong: [{ start: 58, end: 80 }],
                    cites: [
                      { at: 81, n: 1 },
                      { at: 129, n: 2 },
                    ],
                  },
                ],
              },
              citations: [REVIEW, LAYOUT],
              noSource: false,
              steps: STEPS,
              proposals: [EVENT_PROPOSAL],
            }),
          ]),
        }),
      ),
  },
  'ask-no-source': {
    title: 'Ask: an answer with no source says so',
    layout: 'dock',
    render: () =>
      dock(
        answered,
        inputs({
          conversation: conversation([
            turn('t-1', 'Did anyone mention the dentist?', {
              answer: { blocks: [{ text: 'Nothing in your mail mentions a dentist this month.' }] },
              steps: [{ id: 's1', text: 'Searched mail for “dentist”', state: 'done', count: 0 }],
            }),
          ]),
        }),
      ),
  },
  'ask-stopped': {
    title: 'Ask: stopped with Esc, the partial answer kept',
    layout: 'dock',
    render: () => {
      const state = running('Summarize this week’s mail from Jordan');
      return dock(
        { ...state, run: { ...state.run!, stopped: true, settled: true } },
        inputs({
          frames: [
            ...STEPS.map(step => frame('step', { step })),
            frame('text', {
              delta: 'Jordan sent two layout directions and asked for a pick by tomorrow.',
            }),
            frame('citation', { citation: LAYOUT }),
            frame('text', { delta: ' He also shared' }),
          ],
        }),
      );
    },
  },
  'ask-no-provider': {
    title: 'Ask: no provider, before any question',
    layout: 'dock',
    render: () => dock(initialAsk, inputs({ askReady: false })),
  },
  'ask-provider-error': {
    title: 'Ask: Groq didn’t answer, with Retry and Use another provider',
    layout: 'dock',
    render: () =>
      dock(
        running('What did I miss this week?'),
        inputs({
          frames: [
            frame('step', {
              step: { id: 's1', text: 'Searching this week’s mail', state: 'running' },
            }),
            frame('error', { problem: { reasonCode: 'ai.unreachable' } }),
          ],
        }),
      ),
  },
  'ask-dictating': {
    title: 'Ask: hold A to dictate, the level meter and the Listening line',
    layout: 'dock',
    render: () => dock(initialAsk, inputs(), { dictation: { holdKey: 'A', level: 0.6 } }),
  },
  'ask-worst-case': {
    title:
      'Ask worst case: a very long question, 30 citations, non-Latin text, an account left out',
    layout: 'dock',
    render: () => {
      const many = Array.from({ length: 30 }, (_, i) =>
        message(
          i + 1,
          i % 3 === 0 ? '山田 花子' : i % 3 === 1 ? 'Ünal Kaya-Øvergaard' : 'Мария Иванова',
          `Thread ${i + 1} — ハイキング計画`,
          `引用 ${i + 1}: 土曜日の朝8時に駅で集合しましょう。`,
          ago(i * DAY),
        ),
      );
      const text =
        '土曜日のハイキングは朝8時に駅で集合です。Ünal confirmed the trail, and Мария will bring the map. '.repeat(
          3,
        );
      return dock(
        answered,
        inputs({
          conversation: conversation([
            turn(
              't-1',
              `Can you check every message from the hiking group since September, including the ones in other languages, and tell me who is driving, who is bringing food, and whether anyone mentioned the weather or a change of trail ${'and the parking '.repeat(6)}?`,
              {
                answer: {
                  blocks: [
                    {
                      text,
                      strong: [{ start: 0, end: 21 }],
                      cites: sentenceEnds(text).flatMap((end, i) => [
                        { at: end, n: 2 * i + 1 },
                        { at: end, n: 2 * i + 2 },
                      ]),
                    },
                  ],
                },
                citations: many,
                noSource: false,
                steps: STEPS,
                excludedAccountIds: ['acc-work'],
              },
            ),
          ]),
        }),
      );
    },
  },
  today: {
    title: 'Today: next event, the following two, gaps, now line',
    layout: 'dock',
    render: () => dock(initialAsk, inputs(), { tab: 'today' }),
  },
  'today-busy': {
    title: 'Today: a busy day, the rest folded as "3 more", a declined event left out',
    layout: 'dock',
    render: () => (
      <AskPanel
        view={dockView(initialAsk, inputs())}
        tab="today"
        width={360}
        handlers={handlers}
        today={
          <TodayFixture
            events={[
              ...busyDay(),
              event('Offsite planning', 'work', at(29, 0), at(30, 0), {
                allDay: true,
                start: { type: 'date', date: '2026-10-29' },
                end: { type: 'date', date: '2026-10-30' },
              }),
              event('Call with the landlord', 'personal', at(29, 19, 30), at(29, 20)),
              event('Dinner at Harbor Table', 'personal', at(29, 20, 30), at(29, 22)),
              event('Read the Q4 plan', 'work', at(29, 22), at(29, 22, 30)),
              event('Focus time', 'work', at(29, 15), at(29, 16), { transparency: 'transparent' }),
            ]}
          />
        }
      />
    ),
  },
  'today-empty': {
    title: 'Today: nothing scheduled',
    layout: 'dock',
    render: () => (
      <AskPanel
        view={dockView(initialAsk, inputs())}
        tab="today"
        width={360}
        handlers={handlers}
        today={<TodayFixture events={[]} />}
      />
    ),
  },
  'palette-first-open': {
    title: 'Palette: context line, Suggested and Go to, numbered',
    layout: 'overlay',
    render: () => palette(openPalette(), context(DREW)),
  },
  'palette-filtered': {
    title: 'Palette: typing "lat", one ranked list with groups on the right, the Ask row last',
    layout: 'overlay',
    render: () => palette(openPalette('lat'), context(DREW)),
  },
  'palette-nested': {
    title: 'Palette: "Move to label…" page with its breadcrumb',
    layout: 'overlay',
    render: () => {
      const ctx = context(DREW);
      return palette(ran(setQuery(openPalette(), 'label'), 'mail.moveToLabel', ctx), ctx);
    },
  },
  'palette-confirm-destructive': {
    title: 'Palette: discard a draft, Cancel is the default',
    layout: 'overlay',
    render: () => {
      const ctx = context(
        { kind: 'draft', id: 'd1', title: 'Re: October illustrations', detail: 'to Drew Bell' },
        ['global', 'compose', 'palette'],
      );
      return palette(ran(openPalette('discard'), 'compose.discard', ctx), ctx);
    },
  },
  'palette-no-match-ask-row': {
    title: 'Palette: no command matches, the Ask row offers the question',
    layout: 'overlay',
    render: () => palette(openPalette('when is the dentist appointment'), context(DREW)),
  },
  'palette-worst-case': {
    title: 'Palette worst case: a very long target, non-Latin text in the query',
    layout: 'overlay',
    render: () =>
      palette(
        openPalette('予定'),
        context({
          kind: 'thread',
          id: 't',
          title: 'Ünal Kaya-Øvergaard and the Hollow Creek Trail Restoration Committee',
          detail:
            'Re: Re: Fwd: 土曜日のハイキング計画 — the final, final version of the trail map with parking notes',
        }),
      ),
  },
  'search-results': {
    title: 'Search: operator tokens, local rows, the Google offer',
    layout: 'pane',
    render: () =>
      search(
        typed('from:jordan has:attachment layout'),
        live(['t1', 't2', 't3', 't4']),
        rowsById(THREADS),
      ),
  },
  'search-no-match': {
    title: 'Search: no mail matches, with the Google offer',
    layout: 'pane',
    render: () => search(typed('dentist'), live([], 0), rowsById([])),
  },
  'search-remote-running': {
    title: 'Search: Return pressed, "Searching Google…" after 150 ms',
    layout: 'pane',
    render: () => {
      const state = asked(typed('from:jordan layout'), ['t1', 't2', 't3', 't4'], NOW - 400);
      return search(state, live(['t1', 't2', 't3', 't4']), rowsById(THREADS));
    },
  },
  'search-remote-done': {
    title: 'Search: Google answered, "From Google" lists only new threads',
    layout: 'pane',
    render: () => {
      let state = asked(typed('from:jordan layout'), ['t1', 't2', 't3', 't4'], NOW - 2_000);
      state = remoteFrame(state, {
        frame: 'progress',
        dbEpoch: 'demo',
        seq: 1,
        runId: 'search-run',
        source: 'search',
        kind: 'done',
      });
      return search(state, live(['t1', 't2', 't3', 't4', 'g1']), rowsById([...THREADS, ...REMOTE]));
    },
  },
  'search-remote-paused': {
    title: 'Search: Google paused, the plain pause line with the resume time',
    layout: 'pane',
    render: () => {
      const state = submitSearch(typed('from:jordan layout'), {
        now: NOW,
        supported: true,
        localIds: ['t1', 't2'],
        pausedUntil: at(29, 14, 14),
      }).state;
      return search(state, live(['t1', 't2']), rowsById(THREADS));
    },
  },
  'search-worst-case': {
    title: 'Search worst case: long tokens, non-Latin and long subjects',
    layout: 'pane',
    render: () =>
      search(
        typed(
          'from:"Ünal Kaya-Øvergaard" subject:"土曜日のハイキング計画 and the trail" in:"Hollow Creek Trail Restoration" before:2026-10-20 ハイキング',
        ),
        live(['w1', 'w2']),
        rowsById([
          thread(
            'w1',
            'Ünal Kaya-Øvergaard of the Hollow Creek Trail Restoration Committee',
            '土曜日のハイキング計画 and the trail: the final, final version with parking notes for everyone',
            'ハイキング の 集合 は 朝 8 時 です。Please bring water, a map, and the permit we printed last week.',
            at(18, 8),
            { unread: true, hasAttachments: true },
          ),
          thread('w2', 'Мария Иванова', 'ハイキング', 'Короткое сообщение.', at(10, 8)),
        ]),
      ),
  },
};
