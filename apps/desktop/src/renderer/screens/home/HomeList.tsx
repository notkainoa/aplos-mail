/**
 * Home's list as DESIGN 7.2 draws it: one listbox of labelled groups. Do now (with Back from Later under it), Important
 * updates, the Low importance band, then Follow up. The row under the cursor is the focus letter in its fixed slot.
 * Presentational: rows, order and cursor come in as props; every change goes out through `HomeListHandlers`.
 */
import type { Account, HomeSectionView, HomeView, ThreadId, ThreadRow } from '../../data';
import type { CommandAction, Density, ListboxBinding, SectionHeaderProps } from '../../ui/props';
import { FocusLetter, FocusSlot, ListBox, ListGroup, ListRow, LowBand } from '../../ui/list';
import { useKeyPressed } from './useKeyPressed';
import { LOW_KEY, showsLowBand, type HomeLayout, type SectionKey } from './homeModel';
import {
  dateOf,
  dueOf,
  failurePhrase,
  listRowProps,
  senderOf,
  suggestionOf,
  summaryOf,
} from './homeRows';

/** The DOM id of a row's option; the pointer handlers read the thread id back from it. */
export const ROW_ID_PREFIX = 'home-row-';
export const LOW_DOM_ID = 'home-low';
export const LIST_ID = 'home-list';

export const rowDomId = (id: ThreadId): string => `${ROW_ID_PREFIX}${id}`;

/** The thread id in a row's DOM id, or null for anything else. */
export function threadIdOfDomId(domId: string): ThreadId | null {
  return domId.startsWith(ROW_ID_PREFIX) ? domId.slice(ROW_ID_PREFIX.length) : null;
}

/** The option the cursor is on, for `aria-activedescendant`. */
export function activeDomId(key: string | null): string | undefined {
  if (key === null) return undefined;
  return key === LOW_KEY ? LOW_DOM_ID : rowDomId(key);
}

/** What the list tells its screen. */
export interface HomeListHandlers {
  select(key: string): void;
  open(id: ThreadId): void;
  /** A hover icon button on the row with this cursor key. */
  rowAction(commandId: string, key: string): void;
  suggested(): void;
  later(): void;
  done(): void;
  more(anchor: HTMLElement): void;
  openLow(): void;
  oneByOne(): void;
  clearFromHome(): void;
}

/** Props for `HomeList`. */
export interface HomeListProps {
  readonly view: HomeView;
  readonly layout: HomeLayout;
  readonly cursorKey: string | null;
  readonly density: Density;
  readonly accounts: readonly Account[];
  /** Another surface owns the filled button (the Low sheet is open). */
  readonly demoted: boolean;
  /** The rows in the bulk pick. */
  readonly picked: ReadonlySet<ThreadId>;
  readonly handlers: HomeListHandlers;
}

const SECTION_LABELS = {
  do: 'Do now',
  fromLater: 'Back from Later',
  update: 'Important updates',
  follow: 'Follow up',
} as const;

function headerOf(
  section: HomeSectionView,
  extra: Partial<SectionHeaderProps> = {},
): SectionHeaderProps {
  return {
    id: `home-${section.key}`,
    label: SECTION_LABELS[section.key],
    variant: 'section',
    count: section.count,
    held: section.count === 0 && section.visible,
    ...extra,
  };
}

/** The rows of one block, each a `ListRow` or, under the cursor, the focus letter. */
function Rows(props: HomeListProps & { ids: readonly ThreadId[]; section: SectionKey }) {
  const { view, ids, section, cursorKey, density, accounts, handlers } = props;
  return ids.map(id => {
    const row = view.rows.get(id);
    if (!row) return null;
    const failure = view.failures.get(id);
    const rejected = failure
      ? { op: failurePhrase(failure.action), onRetry: () => void failure.retry() }
      : undefined;
    // While rows are picked the bar acts on the pick, so the cursor row is a plain checked row, not the card.
    const letter = id === cursorKey && props.picked.size === 0;
    if (letter)
      return <LetterSlot key={id} {...props} row={row} section={section} rejected={rejected} />;
    return (
      <ListRow
        key={id}
        {...listRowProps(row, {
          domId: rowDomId(id),
          layout: 'home',
          density,
          cursor: id === cursorKey,
          picked: props.picked.has(id),
          picking: props.picked.size > 0,
          accounts,
          rejected,
          handlers: {
            onSelect: () => handlers.select(id),
            onOpen: () => handlers.open(id),
            onAction: commandId => handlers.rowAction(commandId, id),
          },
        })}
      />
    );
  });
}

function LetterSlot(
  props: HomeListProps & {
    row: ThreadRow;
    section: SectionKey;
    rejected: { op: string; onRetry: () => void } | undefined;
  },
) {
  const { row, section, density, demoted, handlers, rejected } = props;
  const summary = summaryOf(row);
  return (
    <FocusSlot density={density} fit={summary.state === 'absent' ? 'content' : 'fixed'}>
      <FocusLetter
        id={rowDomId(row.id)}
        sender={senderOf(row)}
        due={dueOf(row)}
        date={dateOf(row)}
        marks={{ bookmarked: row.workflow.bookmarked, attachment: row.hasAttachments }}
        summary={summary}
        suggestion={suggestionOf(row, section)}
        commands={{
          suggest: 'mail.suggested',
          later: 'mail.later',
          done: 'mail.done',
          more: 'list.more',
        }}
        demoted={demoted}
        picked={props.picked.has(row.id)}
        rejected={rejected}
        onSuggestion={handlers.suggested}
        onLater={handlers.later}
        onDone={handlers.done}
        onMore={handlers.more}
      />
    </FocusSlot>
  );
}

function oneByOneAction(props: HomeListProps): CommandAction | undefined {
  const section = props.view.sections[0];
  if (!section || section.count === 0) return undefined;
  return { label: 'Go one by one', commandId: 'home.oneByOne', onSelect: props.handlers.oneByOne };
}

function DoNow(props: HomeListProps) {
  const section = props.view.sections.find(s => s.key === 'do');
  if (!section) return null;
  const { fromLater } = section;
  // The label counts the rows listed right under it; Back from Later carries its own count below.
  const listed = fromLater?.visible ? section.count - fromLater.count : section.count;
  return (
    <ListGroup
      header={headerOf(section, {
        count: Math.max(0, listed),
        waitingNew: section.waiting,
        action: oneByOneAction(props),
      })}
    >
      <Rows {...props} ids={props.layout.do} section="do" />
      {fromLater?.visible ? (
        <ListGroup
          header={{
            id: 'home-fromLater',
            label: SECTION_LABELS.fromLater,
            variant: 'sub',
            count: fromLater.count,
            held: fromLater.count === 0,
            action: {
              label: 'Clear from Home',
              commandId: 'home.clearFromHome',
              onSelect: props.handlers.clearFromHome,
            },
          }}
        >
          <Rows {...props} ids={props.layout.fromLater} section="fromLater" />
        </ListGroup>
      ) : null}
    </ListGroup>
  );
}

function Section(props: HomeListProps & { name: 'update' | 'follow' }) {
  const section = props.view.sections.find(s => s.key === props.name);
  if (!section) return null;
  return (
    <ListGroup header={headerOf(section)}>
      <Rows {...props} ids={props.layout[props.name]} section={props.name} />
    </ListGroup>
  );
}

function Band(props: HomeListProps & { cursorShown: boolean }) {
  const { low } = props.view;
  if (!showsLowBand(props.layout)) return null;
  return (
    <LowBand
      id={LOW_DOM_ID}
      senders={low.names}
      moreSenders={low.moreSenders}
      count={low.count}
      cursor={props.cursorKey === LOW_KEY && props.cursorShown}
      density={props.density}
      commandId="mail.open"
      onOpen={props.handlers.openLow}
    />
  );
}

/** Every thread has left Do now, Important updates and Follow up; only the Low band may remain. */
export function isCleared(layout: HomeLayout): boolean {
  const rows = [layout.do, layout.fromLater, layout.update, layout.follow];
  return rows.every(ids => ids.length === 0) && showsLowBand(layout);
}

/** The cleared state: Do now keeps its place, with a calm line where the letter was (DESIGN 7.14). */
function Cleared() {
  return (
    <ListGroup header={{ id: 'home-do', label: SECTION_LABELS.do, variant: 'section' }}>
      <p className="aplos-home-cleared__line">Nothing needs you right now.</p>
      <p className="aplos-home-cleared__detail">Mail that needs you will show up here.</p>
    </ListGroup>
  );
}

/** The Home listbox. */
export function HomeList(props: HomeListProps) {
  const cleared = isCleared(props.layout);
  const keyed = useKeyPressed(cleared);
  const binding: ListboxBinding = {
    id: LIST_ID,
    label: 'Home',
    activeDescendantId: activeDomId(props.cursorKey),
  };
  return (
    <ListBox binding={binding} multiselectable={props.picked.size > 0}>
      {cleared ? <Cleared /> : <DoNow {...props} />}
      <Section {...props} name="update" />
      <Band {...props} cursorShown={!cleared || keyed} />
      <Section {...props} name="follow" />
    </ListBox>
  );
}
