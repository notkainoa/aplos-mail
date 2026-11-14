// One scene per state in ../states.ts: the component tree, drawn with original demo data and no-op
// handlers. Scenes import only renderer/ui, never the data layer, the shell or the engine.

import { useState, type ReactElement, type ReactNode } from 'react';
import { createAppRegistry } from '../../../apps/desktop/src/renderer/commands';
import type {
  DueInfo,
  FocusLetterProps,
  MenuEntry,
  PaletteSection,
  SummaryContent,
  ToastData,
  TriageCommands,
} from '../../../apps/desktop/src/renderer/ui/props';
import {
  Composer,
  InlineReply,
  RecipientField,
} from '../../../apps/desktop/src/renderer/ui/compose';
import { Button } from '../../../apps/desktop/src/renderer/ui/buttons-keys';
import {
  FocusLetter,
  FocusSlot,
  ListBox,
  ListGroup,
  ListRow,
  LowBand,
  SectionHeader,
} from '../../../apps/desktop/src/renderer/ui/list';
import { Palette, SearchField } from '../../../apps/desktop/src/renderer/ui/ask';
import { ReaderActions, ReaderHead } from '../../../apps/desktop/src/renderer/ui/reader';
import { Confirm, Menu, ToastStack } from '../../../apps/desktop/src/renderer/ui/surfaces';

import { Column, noop, row } from './scenes.shared';
import {
  CalendarScene,
  ChoiceGroupScene,
  EmptyScene,
  ErrorScene,
  FirstSyncScene,
  OnboardingScene,
  SettingsScene,
  StatusScene,
} from './scenes.more';
import { shellScenes } from './scenes.shell';
import { homeScenes } from './scenes.home';
import { readerScenes } from './scenes.reader';
import { crowdScenes } from './scenes.reader.crowd';
import { calendarScenes } from './scenes.calendar';

export const registry = createAppRegistry();

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

/** A button the floating surfaces anchor to; hands the element up once it mounts. */
function useAnchor(): [(el: HTMLElement | null) => void, HTMLElement | null] {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return [setAnchor, anchor];
}

/* ------------------------------ scenes ------------------------------ */

/** The focus card in the three summary states (owner decision 2026-11-13): ready, being written, none coming. */
function HomeFocus({ summary = SUMMARY }: { summary?: FocusLetterProps['summary'] }): ReactElement {
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
          <FocusSlot density="comfortable" fit={summary.state === 'absent' ? 'content' : 'fixed'}>
            <FocusLetter {...letter({ summary })} />
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
            action={{ label: 'Clear from Home', commandId: 'home.clearFromHome', onSelect: noop }}
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

/** The worst Done row: the three marks and the account dot before a stamp from last year, beside a plain one. */
function DoneRowsCrowded(): ReactElement {
  const move = [{ commandId: 'done.moveToHome', icon: 'home', label: 'Move to Home' }] as const;
  return (
    <Column>
      <ListBox binding={{ id: 'done-crowded', label: 'Done' }}>
        <ListGroup header={{ id: 'sec-year', label: 'October 2025', variant: 'section', count: 2 }}>
          <ListRow
            {...row({
              id: 'c-1',
              layout: 'done',
              sender: 'Priya Raman',
              primary: 'Print run for November, with the proofs attached for the whole group',
              doneAt: '2025-10-22T08:03:00-07:00',
              marks: { replied: true, bookmarked: true, attachment: true },
              account: { label: 'Studio' },
              cursor: true,
              hoverActions: [...move],
            })}
          />
          <ListRow
            {...row({
              id: 'c-2',
              layout: 'done',
              sender: 'Leah Okafor',
              primary: 'Lunch for six tomorrow',
              doneAt: '2025-10-22T08:52:00-07:00',
              hoverActions: [...move],
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
      <ReaderHead due={TOMORROW} summary={summary} />
      <ReaderActions
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
            <p>
              Thanks Jordan. Direction two reads better to me, with the quieter header.
              <span className="stage__suggestion"> I can review the final pass on Thursday.</span>
            </p>
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

export const scenes: Record<string, () => ReactElement> = {
  'home-focus': () => <HomeFocus />,
  'home-focus-pending': () => (
    <HomeFocus summary={{ state: 'pending', subject: SUMMARY.subject }} />
  ),
  'home-focus-no-summary': () => (
    <HomeFocus summary={{ state: 'absent', subject: SUMMARY.subject }} />
  ),
  'home-held-zero': HomeHeldZero,
  'list-rows': ListRows,
  'done-rows': DoneRows,
  'done-rows-crowded': DoneRowsCrowded,
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
  'onboarding-choice-group': ChoiceGroupScene,
  'progress-first-sync': FirstSyncScene,
  // ui-shell
  ...shellScenes,
  // ui-home
  ...homeScenes,
  // ui-reader
  ...readerScenes,
  ...crowdScenes,
  // ui-calendar
  ...calendarScenes,
};
