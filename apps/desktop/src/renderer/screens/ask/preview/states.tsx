/**
 * Preview fixtures for lane `ui-ask` package A: every state the harness captures for the Ask dock and the Today tab
 * (DESIGN §7.7, §7.14, §7.15). Each state goes through the real models (`dockView`, `todayModel`) and the
 * presentational screens, from hand-written contract values. Original demo data only: invented people on example
 * domains, no real mail, addresses or keys.
 */
import type { JSX } from 'react';
import type {
  AskTurn,
  Citation,
  Conversation,
  Event,
  ProgressFrame,
  Proposal,
} from '../../../data';
import type { DictationState } from '../../../ui/props';
import { AskPanel, type AskPanelHandlers } from '../AskPanel';
import { ConsentLine } from '../AskConsent';
import {
  dockView,
  initialAsk,
  runRefused,
  setField,
  type AskInputs,
  type AskState,
} from '../ask.model';
import { Today } from '../../today/Today';
import { todayModel, type TodayCalendar } from '../../today/today.model';
import { at, NOW, noop } from './shared';

export interface StateEntry {
  title: string;
  render: () => JSX.Element;
}

const ago = (ms: number) => Date.now() - ms;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
  options: { tab?: 'ask' | 'today'; dictation?: DictationState; consent?: JSX.Element } = {},
) {
  return (
    <AskPanel
      view={dockView(state, input)}
      tab={options.tab ?? 'ask'}
      width={360}
      today={<TodayFixture events={busyDay()} />}
      consent={options.consent}
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

const consent = (
  <ConsentLine
    provider="Groq"
    model="llama-3.3-70b-versatile"
    local={false}
    onAllow={noop}
    onNotNow={noop}
  />
);

export const states: Record<string, StateEntry> = {
  'ask-empty': {
    title: 'Ask: empty, three suggestions and recent chats',
    render: () => dock(initialAsk, inputs()),
  },
  'ask-consent': {
    title: 'Ask: first-use consent line naming provider and model',
    render: () => dock(initialAsk, inputs(), { consent }),
  },
  'ask-working': {
    title: 'Ask: one steady step line, a follow-up queued as an editable card',
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
  'ask-list': {
    title: 'Ask: a numbered answer and a bulleted one render as lists, not one run-on paragraph',
    render: () =>
      dock(
        answered,
        inputs({
          conversation: conversation([
            turn('t-1', 'What do I need to do before Thursday?', {
              answer: {
                blocks: [
                  {
                    text: 'Three things are open before Thursday:\n1. Send Jordan your layout pick.\n2. Confirm the review time with Mina.\n3. Upload the signed proofs to the shared folder.',
                    cites: [{ at: 83, n: 1 }],
                  },
                  { text: 'Also worth bringing:\n- The printed proofs\n- Your laptop charger' },
                ],
              },
              citations: [REVIEW],
              noSource: false,
            }),
          ]),
        }),
      ),
  },
  'ask-answer': {
    title: 'Ask: serif answer, decisive fact, citations, folded step log, the proposal card',
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
    render: () => dock(initialAsk, inputs({ askReady: false })),
  },
  'ask-provider-error': {
    title: 'Ask: Groq didn’t answer, with Retry and Use another provider',
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
  'ask-daily-limit': {
    title: 'Ask: the model is paused for today',
    render: () =>
      dock(
        running('What did I miss this week?'),
        inputs({ frames: [frame('error', { problem: { reasonCode: 'ai.dailyCap' } })] }),
      ),
  },
  'ask-excluded': {
    title: 'Ask: this account is turned off for AI, with Open Settings',
    render: () =>
      dock(
        runRefused(running('What did I miss this week?'), 'ask-1', {
          type: 'forbidden',
          reasonCode: 'ai.accountExcluded',
          message: 'account excluded',
        }),
        inputs(),
      ),
  },
  'ask-dictating': {
    title: 'Ask: hold A to dictate, the level meter and the Listening line',
    render: () => dock(initialAsk, inputs(), { dictation: { holdKey: 'A', level: 0.6 } }),
  },
  today: {
    title: 'Today: next event, the following two, gaps, now line',
    render: () => dock(initialAsk, inputs(), { tab: 'today' }),
  },
  'today-busy': {
    title: 'Today: a busy day, the rest folded as "3 more", a declined event left out',
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
};
