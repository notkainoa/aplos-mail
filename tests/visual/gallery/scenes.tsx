// One scene per state in ../states.ts: the component tree, drawn with original demo data and no-op
// handlers. Scenes import only renderer/ui, never the data layer, the shell or the engine.

import { useState, type ReactElement, type ReactNode } from 'react';
import { createAppRegistry } from '../../../apps/desktop/src/renderer/commands';
import type {
  CalendarEventData,
  DueInfo,
  FocusLetterProps,
  ListRowProps,
  MenuEntry,
  PaletteSection,
  ProviderTableProps,
  StepButton,
  SummaryContent,
  SyncAccount,
  ToastData,
  TriageCommands,
} from '../../../apps/desktop/src/renderer/ui/props';
import { CalendarGrid } from '../../../apps/desktop/src/renderer/ui/calendar';
import {
  Composer,
  InlineReply,
  RecipientField,
} from '../../../apps/desktop/src/renderer/ui/compose';
import { Button } from '../../../apps/desktop/src/renderer/ui/buttons-keys';
import { Switch } from '../../../apps/desktop/src/renderer/ui/controls';
import {
  EmptyLine,
  ErrorLine,
  FocusLetter,
  FocusSlot,
  ListBox,
  ListGroup,
  ListRow,
  LowBand,
  SectionHeader,
} from '../../../apps/desktop/src/renderer/ui/list';
import { ChoiceRow, OnboardingStep } from '../../../apps/desktop/src/renderer/ui/onboarding';
import { Palette, SearchField } from '../../../apps/desktop/src/renderer/ui/ask';
import { ReaderHead } from '../../../apps/desktop/src/renderer/ui/reader';
import { ProviderTable, SettingRow } from '../../../apps/desktop/src/renderer/ui/settings';
import { ProgressSegments, StatusSlot } from '../../../apps/desktop/src/renderer/ui/status';
import { Confirm, Menu, NavHead, ToastStack } from '../../../apps/desktop/src/renderer/ui/surfaces';

export const registry = createAppRegistry();

const noop = () => {};

/* ------------------------------ shared demo data ------------------------------ */

const TOMORROW: DueInfo = { at: '2026-10-30T00:00:00-07:00', overdue: false, source: 'user' };
const OVERDUE: DueInfo = { at: '2026-10-28T00:00:00-07:00', overdue: true, source: 'structured' };

const TRIAGE: TriageCommands = {
  suggest: 'mail.suggested',
  later: 'mail.later',
  done: 'mail.done',
  more: 'list.more',
};

const SUMMARY: SummaryContent = {
  state: 'ready',
  text: 'Two layout directions for the Hollow Creek site are ready, and Jordan wants your pick by tomorrow so the build can start Monday.',
  subject: 'A quieter home for the Hollow Creek site',
  provenance: { provider: 'Groq', local: false },
};

const HOVER_ACTIONS = [
  { commandId: 'mail.later', icon: 'clock', label: 'Later' },
  { commandId: 'mail.done', icon: 'check', label: 'Done' },
] as const;

function row(over: Partial<ListRowProps> & Pick<ListRowProps, 'id'>): ListRowProps {
  return {
    layout: 'list',
    density: 'comfortable',
    sender: 'Leah Okafor',
    primary: 'Lunch for six tomorrow',
    unread: false,
    date: '2026-10-27T09:30:00-07:00',
    showAccountDot: false,
    cursor: false,
    picked: false,
    picking: false,
    hoverActions: HOVER_ACTIONS,
    onSelect: noop,
    onOpen: noop,
    onAction: noop,
    ...over,
  };
}

function letter(over: Partial<FocusLetterProps> = {}): FocusLetterProps {
  return {
    id: 'focus-jordan',
    sender: 'Jordan Park',
    due: TOMORROW,
    date: '2026-10-29T08:12:00-07:00',
    summary: SUMMARY,
    suggestion: { verb: 'Reply', icon: 'reply', isDone: false },
    commands: TRIAGE,
    demoted: false,
    onSuggestion: noop,
    onLater: noop,
    onDone: noop,
    onMore: noop,
    ...over,
  };
}

function Column({
  width,
  children,
}: {
  width?: 'reader' | 'narrow' | 'full';
  children: ReactNode;
}): ReactElement {
  return (
    <div className="stage__column" data-width={width}>
      {children}
    </div>
  );
}

/** A button the floating surfaces anchor to; hands the element up once it mounts. */
function useAnchor(): [(el: HTMLElement | null) => void, HTMLElement | null] {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return [setAnchor, anchor];
}

/* ------------------------------ scenes ------------------------------ */

function HomeFocus(): ReactElement {
  return (
    <Column>
      <ListBox binding={{ id: 'home', label: 'Home', activeDescendantId: 'focus-jordan' }}>
        <ListGroup
          header={{
            id: 'sec-do',
            label: 'Do now',
            variant: 'section',
            count: 4,
            action: { label: 'Go one by one', commandId: 'home.oneByOne', onSelect: noop },
          }}
        >
          <FocusSlot density="comfortable">
            <FocusLetter {...letter()} />
          </FocusSlot>
          <ListRow
            {...row({
              id: 'do-priya',
              layout: 'home',
              sender: 'Priya Raman',
              primary: 'Priya needs the revised Q4 deck today so finance can sign off before noon.',
              unread: true,
              due: OVERDUE,
              date: '2026-10-29T07:45:00-07:00',
            })}
          />
          <ListRow
            {...row({
              id: 'do-leah',
              layout: 'home',
              sender: 'Leah Okafor',
              primary: 'Lunch for six tomorrow. Leah asks you to pick somewhere quiet.',
              date: '2026-10-28T16:20:00-07:00',
            })}
          />
          <SectionHeader
            id="sub-back"
            label="Back from Later"
            variant="sub"
            count={1}
            action={{ label: 'Clear from Home', onSelect: noop }}
          />
          <ListRow
            {...row({
              id: 'do-theo',
              layout: 'home',
              sender: 'Theo Lindgren',
              primary: 'Climbing on Thursday evening if the weather holds.',
              date: '2026-10-26T18:05:00-07:00',
            })}
          />
        </ListGroup>
        <ListGroup
          header={{ id: 'sec-updates', label: 'Important updates', variant: 'section', count: 2 }}
        >
          <ListRow
            {...row({
              id: 'up-mina',
              layout: 'home',
              sender: 'Mina Cho',
              primary: 'The design review moved to Thursday, 2:00 to 2:30 PM.',
              unread: true,
              date: '2026-10-29T09:12:00-07:00',
            })}
          />
          <ListRow
            {...row({
              id: 'up-hana',
              layout: 'home',
              sender: 'Hana Sato',
              primary: 'Studio Kettle confirmed the print run for November.',
              date: '2026-10-28T11:02:00-07:00',
            })}
          />
        </ListGroup>
        <LowBand
          id="low-band"
          senders={['Fernworks Weekly', 'Northwind Dental', 'Parcel Trail']}
          count={14}
          cursor={false}
          density="comfortable"
          commandId="list.select"
          onOpen={noop}
        />
      </ListBox>
    </Column>
  );
}

function HomeHeldZero(): ReactElement {
  return (
    <Column>
      <ListBox binding={{ id: 'home', label: 'Home', activeDescendantId: 'do-priya' }}>
        <ListGroup header={{ id: 'sec-do', label: 'Do now', variant: 'section', count: 1 }}>
          <ListRow
            {...row({
              id: 'do-priya',
              layout: 'home',
              sender: 'Priya Raman',
              primary: 'Priya needs the revised Q4 deck today so finance can sign off before noon.',
              unread: true,
              cursor: true,
              date: '2026-10-29T07:45:00-07:00',
            })}
          />
        </ListGroup>
        <ListGroup
          header={{
            id: 'sec-updates',
            label: 'Important updates',
            variant: 'section',
            count: 0,
            held: true,
          }}
        >
          {null}
        </ListGroup>
      </ListBox>
    </Column>
  );
}

function ListRows(): ReactElement {
  return (
    <Column>
      <ListBox binding={{ id: 'all', label: 'All mail', activeDescendantId: 'r-cursor' }}>
        <ListRow
          {...row({
            id: 'r-unread',
            sender: 'Priya Raman',
            primary: 'Q4 review deck',
            secondary: 'Can you send the revised numbers before noon today',
            unread: true,
            date: '2026-10-29T07:45:00-07:00',
          })}
        />
        <ListRow
          {...row({
            id: 'r-read',
            sender: 'Leah Okafor',
            primary: 'Lunch for six tomorrow',
            secondary: 'Somewhere quiet, with vegetarian options if possible',
            marks: { replied: true },
          })}
        />
        <ListRow
          {...row({
            id: 'r-cursor',
            sender: 'Mina Cho',
            primary: 'Design review moved to Thursday',
            secondary: 'Two to two thirty, same room as last time',
            unread: true,
            cursor: true,
            date: '2026-10-29T09:12:00-07:00',
            marks: { attachment: true },
          })}
        />
        <ListRow
          {...row({
            id: 'r-picked',
            sender: 'Hana Sato',
            primary: 'Print run for November',
            secondary: 'Studio Kettle confirmed the paper and the date',
            picking: true,
            picked: true,
            date: '2026-10-28T11:02:00-07:00',
          })}
        />
        <ListRow
          {...row({
            id: 'r-error',
            sender: 'Theo Lindgren',
            primary: 'Climbing on Thursday evening',
            secondary: 'If the weather holds we meet at the gym at six',
            date: '2026-10-26T18:05:00-07:00',
            rejected: { op: 'move to Later', onRetry: noop },
          })}
        />
      </ListBox>
    </Column>
  );
}

function DoneRows(): ReactElement {
  return (
    <Column>
      <ListBox binding={{ id: 'done', label: 'Done' }}>
        <ListGroup header={{ id: 'sec-today', label: 'Today', variant: 'section', count: 2 }}>
          <ListRow
            {...row({
              id: 'd-1',
              layout: 'done',
              sender: 'Priya Raman',
              primary: 'Q4 review deck',
              doneAt: '2026-10-29T09:41:00-07:00',
              hoverActions: [{ commandId: 'done.moveToHome', icon: 'home', label: 'Move to Home' }],
            })}
          />
          <ListRow
            {...row({
              id: 'd-2',
              layout: 'done',
              sender: 'Studio Kettle',
              primary: 'Print run for November',
              doneAt: '2026-10-29T08:03:00-07:00',
              cursor: true,
              hoverActions: [{ commandId: 'done.moveToHome', icon: 'home', label: 'Move to Home' }],
            })}
          />
        </ListGroup>
        <ListGroup header={{ id: 'sec-earlier', label: 'Earlier', variant: 'section', count: 1 }}>
          <ListRow
            {...row({
              id: 'd-3',
              layout: 'done',
              sender: 'Leah Okafor',
              primary: 'Lunch for six tomorrow',
              doneAt: '2026-10-28T08:52:00-07:00',
              hoverActions: [{ commandId: 'done.moveToHome', icon: 'home', label: 'Move to Home' }],
            })}
          />
        </ListGroup>
      </ListBox>
    </Column>
  );
}

function ReaderHeadScene({ summary }: { summary: SummaryContent }): ReactElement {
  return (
    <Column width="reader">
      <ReaderHead
        sender={{
          name: 'Jordan Park',
          address: 'jordan@parkandpine.example',
          accountLabel: 'alex.moreno@example.test',
          history: '14 emails both ways since March',
        }}
        recipientsLabel="to you and Mina Cho"
        due={TOMORROW}
        date="2026-10-29T08:12:00-07:00"
        summary={summary}
        suggestion={{ verb: 'Reply', icon: 'reply', isDone: false }}
        commands={{ suggest: 'mail.suggested', later: 'mail.later', done: 'mail.done' }}
        demoted={false}
        onSuggestion={noop}
        onLater={noop}
        onDone={noop}
      />
    </Column>
  );
}

const COMPOSE_COMMANDS = {
  send: 'compose.send',
  attach: 'compose.attach',
  more: 'compose.format',
  cc: 'compose.ccBcc',
} as const;

const JORDAN = { id: 'jordan', name: 'Jordan Park', address: 'jordan@parkandpine.example' };
const MINA = { id: 'mina', name: 'Mina Cho', address: 'mina@parkandpine.example' };

function Editor({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="stage__editor" contentEditable suppressContentEditableWarning>
      {children}
    </div>
  );
}

function InlineReplyScene(): ReactElement {
  return (
    <Column width="reader">
      <InlineReply
        recipients={
          <RecipientField
            label="To"
            recipients={[JORDAN]}
            query=""
            onQueryChange={noop}
            onCommit={noop}
            onRemove={noop}
            listboxId="reply-to"
          />
        }
        onPopOut={noop}
        editor={
          <Editor>
            <p>Thanks Jordan. Direction two reads better to me, with the quieter header.</p>
          </Editor>
        }
        suggestion={{ kind: 'draft', onKeep: noop, onDismiss: noop }}
        draftState="saved"
        onRetrySave={noop}
        commands={COMPOSE_COMMANDS}
        onSend={noop}
        onAttach={noop}
        onMore={noop}
      />
    </Column>
  );
}

function ComposeScene(): ReactElement {
  const [subject, setSubject] = useState('Hollow Creek launch plan');
  return (
    <Column width="reader">
      <Composer
        recipients={
          <RecipientField
            label="To"
            recipients={[JORDAN, MINA]}
            query=""
            onQueryChange={noop}
            onCommit={noop}
            onRemove={noop}
            listboxId="compose-to"
            ccButton={{ onSelect: noop, commandId: 'compose.ccBcc' }}
          />
        }
        subject={subject}
        onSubjectChange={setSubject}
        editor={
          <Editor>
            <p>Jordan, Mina,</p>
            <p>Here is the plan for the launch week. Build starts Monday, review on Thursday.</p>
          </Editor>
        }
        draftState="saved"
        onRetrySave={noop}
        commands={COMPOSE_COMMANDS}
        onSend={noop}
        onAttach={noop}
        onFormat={noop}
      />
    </Column>
  );
}

const PALETTE_SECTIONS: readonly PaletteSection[] = [
  {
    id: 'suggested',
    label: 'Suggested',
    items: [
      { id: 'p-reply', commandId: 'mail.reply', label: 'Reply', icon: 'reply', matches: [0, 1] },
      { id: 'p-later', commandId: 'mail.later', label: 'Move to Later', icon: 'clock' },
      { id: 'p-done', commandId: 'mail.done', label: 'Mark as Done', icon: 'check' },
    ],
  },
  {
    id: 'goto',
    label: 'Go to',
    items: [
      { id: 'p-home', commandId: 'nav.home', label: 'Go to Home', icon: 'home' },
      { id: 'p-cal', commandId: 'nav.calendar', label: 'Go to Calendar', icon: 'calendar' },
      {
        id: 'p-trash',
        commandId: 'mail.trash',
        label: 'Move to Trash',
        icon: 'trash',
        destructive: true,
      },
    ],
  },
];

function PaletteScene(): ReactElement {
  return (
    <div className="stage__window">
      <Palette
        open
        query="re"
        onQueryChange={noop}
        context="Jordan Park · A quieter home for the Hollow Creek site"
        sections={PALETTE_SECTIONS}
        activeId="p-reply"
        onActiveChange={noop}
        onRun={noop}
        listboxId="palette-list"
        onBack={noop}
        onClose={noop}
      />
    </div>
  );
}

function SearchScene(): ReactElement {
  return (
    <Column>
      <SearchField
        value="invoice"
        onChange={noop}
        tokens={[
          { operator: 'from', value: 'Priya' },
          { operator: 'has', value: 'attachment' },
          { operator: 'after', value: 'Oct 1' },
        ]}
        onRemoveToken={noop}
        onSubmit={noop}
        scopeLabel="All accounts"
        resultsId="results"
        onLeaveToList={noop}
      />
    </Column>
  );
}

const TOASTS: readonly ToastData[] = [
  {
    id: 't-done',
    kind: 'done',
    message: 'Done',
    actions: [{ id: 'undo', label: 'Undo', commandId: 'app.undo' }],
    undoable: true,
  },
  {
    id: 't-later',
    kind: 'later',
    message: 'Moved to Later',
    actions: [
      { id: 'setDate', label: 'Set a date', commandId: 'mail.setDate' },
      { id: 'undo', label: 'Undo', commandId: 'app.undo' },
    ],
    undoable: true,
  },
  { id: 't-pending', kind: 'pending', message: 'Archiving…', undoable: false },
];

function ToastScene(): ReactElement {
  return (
    <div className="stage__window">
      <ToastStack toasts={TOASTS} onAction={noop} onDismiss={noop} />
    </div>
  );
}

const MENU_ENTRIES: readonly MenuEntry[] = [
  { kind: 'item', id: 'm-reply', label: 'Reply', icon: 'reply', commandId: 'mail.reply' },
  { kind: 'item', id: 'm-fwd', label: 'Forward', icon: 'forward', commandId: 'mail.forward' },
  {
    kind: 'item',
    id: 'm-mark',
    label: 'Mark as unread',
    icon: 'mail',
    commandId: 'mail.toggleRead',
  },
  { kind: 'separator' },
  { kind: 'item', id: 'm-why', label: 'Why it’s here', commandId: 'mail.why' },
  {
    kind: 'item',
    id: 'm-trash',
    label: 'Move to Trash',
    icon: 'trash',
    commandId: 'mail.trash',
    danger: true,
  },
];

function MenuScene(): ReactElement {
  const [ref, anchor] = useAnchor();
  return (
    <div className="stage__window">
      <div className="stage__anchor">
        <Button
          ref={ref}
          variant="text"
          label="More"
          trailingIcon="chevron-down"
          popup={{ kind: 'menu', expanded: true, controls: 'demo-menu' }}
          onPress={noop}
        />
      </div>
      <Menu
        open={anchor !== null}
        anchor={anchor}
        label="More actions"
        entries={MENU_ENTRIES}
        activeId="m-fwd"
        onSelect={noop}
        onClose={noop}
      />
    </div>
  );
}

function ConfirmScene(): ReactElement {
  return (
    <div className="stage__window">
      <Confirm
        question="Move 14 emails to Trash?"
        consequence="You can restore them from Trash for 30 days."
        confirmLabel="Move to Trash"
        destructive
        presentation="dialog"
        onConfirm={noop}
        onCancel={noop}
      />
    </div>
  );
}

const GM: SyncAccount = { address: 'alex.moreno@gmail.com', color: 'sky' };

function StatusScene(): ReactElement {
  return (
    <Column width="narrow">
      <StatusSlot
        status={{
          kind: 'ok',
          lastSyncedAt: '2026-10-29T09:58:00-07:00',
          reconnectBy: '2026-10-29T18:00:00-07:00',
        }}
        account={GM}
        onAction={noop}
      />
      <div className="stage__gap" />
      <StatusSlot
        status={{ kind: 'paused', reason: 'throttle', resumeAt: '2026-10-29T14:14:00-07:00' }}
        account={GM}
        onAction={noop}
      />
      <div className="stage__gap" />
      <StatusSlot status={{ kind: 'offline', changesWaiting: 3 }} onAction={noop} />
    </Column>
  );
}

function EmptyScene(): ReactElement {
  return (
    <Column>
      <EmptyLine
        text="You handled 12 emails."
        size="display"
        detail="Nothing else needs you today."
        action={{ label: 'Go to Later', commandId: 'nav.later', emphasis: 'text', onSelect: noop }}
      />
    </Column>
  );
}

function ErrorScene(): ReactElement {
  return (
    <Column>
      <ListBox binding={{ id: 'sent', label: 'Sent' }}>
        <ListRow
          {...row({
            id: 'e-1',
            sender: 'Jordan Park',
            primary: 'Re: A quieter home for the Hollow Creek site',
            date: '2026-10-29T09:55:00-07:00',
          })}
        />
      </ListBox>
      <div className="stage__gap" />
      <ErrorLine kind="sendFailed" recipient="Jordan" placement="column" onAction={noop} />
    </Column>
  );
}

const FEATURES: ProviderTableProps = {
  kind: 'features',
  onChange: noop,
  rows: [
    {
      feature: 'ask',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      providerOptions: ['groq', 'openai', 'ollama'],
      modelOptions: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    },
    {
      feature: 'summaries',
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      providerOptions: ['groq'],
      modelOptions: ['llama-3.1-8b-instant'],
    },
    {
      feature: 'drafts',
      provider: 'openai',
      model: 'gpt-5-mini',
      providerOptions: ['groq', 'openai'],
      modelOptions: ['gpt-5-mini'],
    },
    {
      feature: 'voice',
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      providerOptions: ['groq', 'openai'],
      modelOptions: ['whisper-large-v3-turbo'],
    },
  ],
};

const HOSTED: ProviderTableProps = {
  kind: 'hosted',
  onAction: noop,
  rows: [
    {
      provider: 'groq',
      isDefault: true,
      keySource: { kind: 'environment', variable: 'GROQ_API_KEY' },
      status: { kind: 'works', latencyMs: 400 },
    },
    {
      provider: 'openai',
      isDefault: false,
      keySource: { kind: 'keychain' },
      status: { kind: 'ready' },
    },
    {
      provider: 'anthropic',
      isDefault: false,
      keySource: { kind: 'none', variable: 'ANTHROPIC_API_KEY' },
      status: { kind: 'needsKey' },
    },
  ],
};

function SettingsScene(): ReactElement {
  return (
    <div className="stage__window stage__settings">
      <aside className="stage__settings-nav">
        <NavHead label="Settings" />
      </aside>
      <div className="stage__settings-body">
        <SectionHeader id="set-ai" label="AI" variant="section" />
        <SettingRow
          id="set-private"
          label="Send mail text to a provider"
          description="Summaries and Ask send the text of the mail they read to the provider you pick."
          control={<Switch checked label="Send mail text to a provider" onChange={noop} />}
        />
        <SettingRow
          id="set-feature"
          label="Provider for each feature"
          below={<ProviderTable {...FEATURES} />}
        />
        <SettingRow id="set-hosted" label="Providers" below={<ProviderTable {...HOSTED} />} />
      </div>
    </div>
  );
}

const CAL = {
  work: { id: 'work', name: 'Work', color: 'hill' },
  personal: { id: 'personal', name: 'Personal', color: 'sky' },
  hollow: { id: 'hollow', name: 'Hollow Creek', color: 'ember' },
} as const;

function ev(
  id: string,
  title: string,
  start: string,
  end: string,
  extra: Partial<CalendarEventData> = {},
): CalendarEventData {
  return { id, title, start, end, calendar: CAL.work, kind: 'event', persisted: true, ...extra };
}

const EVENTS: readonly CalendarEventData[] = [
  ev('dental', 'Northwind Dental', '2026-10-29T09:30:00', '2026-10-29T10:30:00', {
    calendar: CAL.personal,
  }),
  ev('standup', 'Standup', '2026-10-29T11:00:00', '2026-10-29T11:15:00'),
  ev('design', 'Design review', '2026-10-29T14:00:00', '2026-10-29T14:30:00', {
    calendar: CAL.hollow,
  }),
  ev('climb', 'Climbing with Theo', '2026-10-29T17:30:00', '2026-10-29T19:00:00', {
    calendar: CAL.personal,
  }),
  ev('q4', 'Q4 review', '2026-10-30T11:00:00', '2026-10-30T12:00:00', { unanswered: true }),
  ev('lunch', 'Lunch with Leah', '2026-10-30T12:30:00', '2026-10-30T13:30:00', {
    calendar: CAL.personal,
  }),
  ev('launch', 'Launch prep', '2026-10-30T15:00:00', '2026-10-30T16:30:00', {
    calendar: CAL.hollow,
    kind: 'plan',
    persisted: false,
  }),
  ev('offsite', 'Team offsite', '2026-10-27T00:00:00', '2026-10-28T00:00:00', { allDay: true }),
];

function CalendarScene(): ReactElement {
  return (
    <Column width="full">
      <CalendarGrid
        view="week"
        start="2026-10-26"
        events={EVENTS}
        now="2026-10-29T10:00:00"
        weekStartsOn={1}
        selectedId="design"
        onSelect={noop}
        onOpen={noop}
        onCreate={noop}
        onMove={noop}
        onResize={noop}
        onOpenStack={noop}
        label="Week of October 26"
      />
    </Column>
  );
}

const quiet = (label: string, extra: Partial<StepButton> = {}): StepButton => ({
  label,
  emphasis: 'text',
  onSelect: noop,
  ...extra,
});

function OnboardingScene(): ReactElement {
  return (
    <OnboardingStep
      layout="step"
      title="Add your mail"
      titleId="onb-title"
      lede="Aplos reads your mail on this Mac. Pick an account to connect."
      onTryDemo={noop}
      actions={[
        {
          label: 'Continue with Google',
          emphasis: 'filled',
          keys: 'Return',
          keyHint: 'always',
          onSelect: noop,
        },
      ]}
      footer={{
        dashes: { step: 2, of: 4 },
        note: 'setupContinues',
        buttons: [quiet('Back', { keys: 'Esc', keyHint: 'hint' })],
      }}
    >
      <ChoiceRow
        id="acc-google"
        role="link"
        label="Google"
        detail="Gmail and Google Calendar"
        icon="mail"
      />
      <ChoiceRow
        id="acc-ms"
        role="link"
        label="Microsoft"
        detail="Outlook and Microsoft 365"
        icon="mail"
      />
    </OnboardingStep>
  );
}

function FirstSyncScene(): ReactElement {
  return (
    <OnboardingStep
      layout="step"
      title="Getting your mail ready"
      titleId="sync-title"
      footer={{
        dashes: { step: 3, of: 4 },
        note: 'setupContinues',
        buttons: [quiet('Open Aplos', { keys: 'Return', keyHint: 'always' })],
      }}
    >
      <ProgressSegments
        variant="checkpoints"
        account={GM}
        checkpoints={[
          { step: 'connect', state: 'done' },
          { step: 'find', state: 'done', estimate: 4200 },
          { step: 'read', state: 'current', read: 1380, of: 4200 },
          { step: 'sort', state: 'pending', sorted: 0, of: 4200 },
        ]}
      />
    </OnboardingStep>
  );
}

export const scenes: Record<string, () => ReactElement> = {
  'home-focus': HomeFocus,
  'home-held-zero': HomeHeldZero,
  'list-rows': ListRows,
  'done-rows': DoneRows,
  'reader-head': () => <ReaderHeadScene summary={SUMMARY} />,
  'reader-head-pending': () => (
    <ReaderHeadScene summary={{ state: 'pending', subject: SUMMARY.subject }} />
  ),
  'inline-reply': InlineReplyScene,
  'compose-page': ComposeScene,
  palette: PaletteScene,
  'search-operators': SearchScene,
  'toast-stack': ToastScene,
  'menu-open': MenuScene,
  'dialog-confirm-destructive': ConfirmScene,
  'status-slot': StatusScene,
  'empty-inbox-zero': EmptyScene,
  'error-send-failed': ErrorScene,
  'settings-providers': SettingsScene,
  'calendar-week': CalendarScene,
  'onboarding-step': OnboardingScene,
  'progress-first-sync': FirstSyncScene,
};
