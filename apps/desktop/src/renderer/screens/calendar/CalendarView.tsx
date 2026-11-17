/**
 * The Calendar screen, presentational (DESIGN 7.8; mockups calendar-week.html, calendar-day.html, calendar-event.html).
 * It draws the view model from `calendar.model.ts` with the calendar family and the shared surfaces, and reports
 * every intent as a `CalendarAction`. No data hooks, no contract calls, no keys of its own: the registry routes keys
 * (CalendarContainer attaches them), and the components handle their own widgets' keys.
 *
 * Layout: the PageHead row (the date label, then Today, previous and next and the D | W | M Puck), then the grid; the
 * day view adds the detail rail; week, month and agenda open the detail in a Popover anchored to the event. The
 * editor (N, E, a drag on an empty hour) is a Dialog. Pane-header tools belong to the shell: `CALENDAR_PANE_TOOLS`.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from 'react';
import { Button } from '../../ui/buttons-keys';
import { CalendarGrid, EventDetail, MiniMonth, ScopeChooser } from '../../ui/calendar';
import { formatClock, yearMonthOf } from '../../ui/calendar/dates';
import { eventDomId } from '../../ui/calendar/eventText';
import { TextField } from '../../ui/controls';
import type {
  Anchor,
  Announce,
  IsoYearMonth,
  MenuEntry,
  PaneTools,
  PuckItem,
} from '../../ui/props';
import { Dialog, Menu, PageHead, Popover, Puck, Text } from '../../ui/surfaces';
import type {
  CalendarAction,
  CalendarViewModel,
  DetailMenuId,
  EditorView,
  EmptyView,
  GridView,
} from './calendar.model';
import { EDITING_COPY } from './accountCalendarState';
import { FailedHolds } from './FailedHolds';
import { stackDomMatch } from './keys';

/** The one pane-header tool on Calendar (DESIGN 7.1): New event, N. Ask and the calendar button are the shell's. */
export const CALENDAR_PANE_TOOLS: PaneTools = [
  { commandId: 'calendar.newEvent', icon: 'plus', label: 'New event' },
];

const VIEWS: readonly PuckItem[] = [
  { id: 'day', label: 'Day', shortLabel: 'D', commandId: 'calendar.dayView' },
  { id: 'week', label: 'Week', shortLabel: 'W', commandId: 'calendar.weekView' },
  { id: 'month', label: 'Month', shortLabel: 'M', commandId: 'calendar.monthView' },
];

const ANSWER_COMMANDS = {
  yes: 'calendar.answerYes',
  maybe: 'calendar.answerMaybe',
  no: 'calendar.answerNo',
} as const;

/** A request from the container to move focus after a change (Return in day view, a delete, a closed popover). */
export interface FocusRequest {
  readonly target: 'grid' | 'rail';
  /** Bumped per request, so the same target can be asked for twice. */
  readonly seq: number;
}

export interface CalendarViewProps {
  readonly vm: CalendarViewModel;
  readonly dispatch: (action: CalendarAction) => void;
  /** The shell's polite live region (DESIGN 11.3). */
  readonly announce?: Announce;
  readonly focus?: FocusRequest | null;
}

/** A Menu with its own keyboard cursor (Menu is controlled). */
function ScreenMenu(props: {
  id?: string;
  open: boolean;
  anchor: Anchor;
  label: string;
  entries: readonly MenuEntry[];
  checkedId?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { open, checkedId } = props;
  const [active, setActive] = useState<string | undefined>(undefined);
  const firstId = props.entries.find(
    (e): e is Extract<MenuEntry, { kind: 'item' }> => e.kind === 'item' && !e.disabled,
  )?.id;
  // Only on opening: the cursor starts on the checked item, else the first one.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setActive(checkedId ?? firstId);
    wasOpen.current = open;
  }, [open, checkedId, firstId]);
  return (
    <Menu
      id={props.id}
      open={open}
      anchor={props.anchor}
      label={props.label}
      entries={props.entries}
      activeId={active}
      checkedId={checkedId}
      onActiveChange={setActive}
      onSelect={props.onSelect}
      onClose={props.onClose}
    />
  );
}

/** Where a popover for an event opens: away from the pane's edge it is nearer to, beside the event. */
function sideOf(anchor: Anchor): 'left' | 'right' | 'below-start' {
  if (!anchor || typeof window === 'undefined') return 'below-start';
  const r = anchor.getBoundingClientRect();
  return r.left + r.width / 2 > window.innerWidth / 2 ? 'left' : 'right';
}

interface AnchorRefs {
  readonly root: RefObject<HTMLDivElement | null>;
  /** The element a click handed over, by entry id. */
  readonly opened: RefObject<Map<string, HTMLElement>>;
  readonly stack: RefObject<HTMLElement | null>;
}

/** An entry's anchor: the element a click handed over, else the entry's own element, else the stack that folds it, else the grid. */
function anchorFor(id: string | null, refs: AnchorRefs): Anchor {
  if (!id) return null;
  const held = refs.opened.current.get(id);
  if (held?.isConnected) return held;
  const own = document.getElementById(eventDomId(id));
  if (own) return own;
  if (refs.stack.current?.isConnected) return refs.stack.current;
  return refs.root.current?.querySelector<HTMLElement>('.ui-calendar-grid') ?? null;
}

interface Anchors {
  readonly popover: Anchor;
  readonly stack: Anchor;
  readonly scope: Anchor;
}

const STACK_KEY_SEP = '\u0000';

/** Anchors follow the model, resolved after layout, so a state opened from outside (a key, the preview) finds its event. */
function useAnchors(vm: CalendarViewModel, refs: AnchorRefs): Anchors {
  const [anchors, setAnchors] = useState<Anchors>({ popover: null, stack: null, scope: null });
  const popoverId = vm.popover?.id ?? null;
  const scopeId = vm.scope?.entryId ?? null;
  const stackKey = vm.stack?.ids.join(STACK_KEY_SEP) ?? '';
  const { shown } = vm;
  const periodStart = vm.period.start;
  useLayoutEffect(() => {
    let stackEl: HTMLElement | null = null;
    if (stackKey) {
      const held = refs.stack.current?.isConnected ? refs.stack.current : null;
      const ids = stackKey.split(STACK_KEY_SEP);
      // Month renders its "+N" as `day:firstId`, so a programmatic open also tries that form (review1 9).
      const match = held
        ? null
        : stackDomMatch(
            ids,
            [...document.querySelectorAll('[id^="ui-stack-"]')].map(el => el.id),
          );
      stackEl = held ?? (match ? document.getElementById(match) : null);
    }
    if (stackEl) refs.stack.current = stackEl;
    setAnchors({
      popover: anchorFor(popoverId, refs),
      stack: stackEl,
      scope: anchorFor(scopeId, refs),
    });
  }, [popoverId, scopeId, stackKey, shown, periodStart, refs]);
  return anchors;
}

/** The pane's width decides the narrow agenda (DESIGN 7.8): measured, never guessed. */
function usePaneWidth(
  root: RefObject<HTMLDivElement | null>,
  dispatch: (action: CalendarAction) => void,
): void {
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = (): void =>
      dispatch({ type: 'width', px: Math.round(el.getBoundingClientRect().width) });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [root, dispatch]);
}

/** A ⋯ menu opened by a key (or the preview) has no click to hand over its button: find it in the open detail. */
function useMoreAnchor(root: RefObject<HTMLDivElement | null>, vm: CalendarViewModel) {
  const [moreAnchor, setMoreAnchor] = useState<Anchor>(null);
  const detailId = (vm.popover ?? vm.rail)?.id ?? null;
  useLayoutEffect(() => {
    if (!vm.moreOpen || moreAnchor?.isConnected) return;
    const button = root.current?.querySelector<HTMLElement>(
      '.cal-screen__popover button[aria-haspopup="menu"], .cal-screen__rail button[aria-haspopup="menu"]',
    );
    if (button) setMoreAnchor(button);
  }, [root, vm.moreOpen, moreAnchor, detailId]);
  return [moreAnchor, setMoreAnchor] as const;
}

/** Moves focus when the container asks (Return in day view, a delete, a closed popover). */
function useFocusRequest(
  focus: FocusRequest | null | undefined,
  root: RefObject<HTMLDivElement | null>,
  rail: RefObject<HTMLElement | null>,
): void {
  const seq = focus?.seq;
  const target = focus?.target;
  useEffect(() => {
    if (seq === undefined) return;
    const el =
      target === 'rail'
        ? rail.current
        : root.current?.querySelector<HTMLElement>('.ui-calendar-grid');
    el?.focus({ preventScroll: true });
  }, [seq, target, root, rail]);
}

type DetailProps = Omit<ComponentProps<typeof EventDetail>, 'presentation' | 'onClose'>;

/** The open detail's props, shared by the day rail and the popover. */
function detailPropsFor(
  vm: CalendarViewModel,
  dispatch: (action: CalendarAction) => void,
  onMore: (anchor: HTMLElement) => void,
): DetailProps | null {
  const detail = vm.popover ?? vm.rail;
  if (!detail) return null;
  const reply = vm.reply
    ? {
        answer: vm.reply.answer,
        commands: ANSWER_COMMANDS,
        onAnswer: (answer: 'yes' | 'maybe' | 'no') => dispatch({ type: 'answer', answer }),
        onSend: () => dispatch({ type: 'sendReply' }),
      }
    : undefined;
  return {
    event: detail,
    reply,
    onOpenInvite: () => dispatch({ type: 'openInvite' }),
    onOpenVideo: () => dispatch({ type: 'openVideo' }),
    onConfirmPlan: () => dispatch({ type: 'confirmPlan' }),
    onOpenSource: () => dispatch({ type: 'openSource' }),
    onMore,
  };
}

/** The PageHead row: the date label, then Today, previous and next and the D | W | M Puck. */
function ViewControls({
  vm,
  dispatch,
}: {
  vm: CalendarViewModel;
  dispatch: (action: CalendarAction) => void;
}) {
  return (
    <PageHead lead={{ kind: 'dateLabel', label: vm.head.label, range: vm.head.range }}>
      <Button
        variant="text"
        label="Today"
        commandId="calendar.today"
        onPress={() => dispatch({ type: 'today' })}
      />
      <Button
        variant="icon"
        icon="chevron-left"
        label={`Previous ${vm.periodWord}`}
        commandId="calendar.previousPeriod"
        onPress={() => dispatch({ type: 'period', dir: -1 })}
      />
      <Button
        variant="icon"
        icon="chevron-right"
        label={`Next ${vm.periodWord}`}
        commandId="calendar.nextPeriod"
        onPress={() => dispatch({ type: 'period', dir: 1 })}
      />
      <span className="cal-screen__views">
        <Puck
          kind="segmented"
          role="tabs"
          label="View"
          items={VIEWS}
          selectedId={vm.viewSelected}
          onSelect={id => dispatch({ type: 'view', view: id as GridView })}
        />
      </span>
    </PageHead>
  );
}

function Grid(props: {
  vm: CalendarViewModel;
  dispatch: (action: CalendarAction) => void;
  announce?: Announce;
  opened: RefObject<Map<string, HTMLElement>>;
  stack: RefObject<HTMLElement | null>;
}) {
  const { vm, dispatch, opened, stack } = props;
  return (
    <CalendarGrid
      view={vm.shown}
      start={vm.period.start}
      events={vm.entries}
      now={vm.now}
      weekStartsOn={vm.weekStartsOn}
      selectedId={vm.selectedId}
      onSelect={id => dispatch({ type: 'select', id })}
      onOpen={(id, anchor) => {
        opened.current.set(id, anchor);
        dispatch({ type: 'open', id });
      }}
      onCreate={range => dispatch({ type: 'createRange', start: range.start, end: range.end })}
      onMove={(id, range) => dispatch({ type: 'move', id, start: range.start, end: range.end })}
      onResize={(id, end) => dispatch({ type: 'resize', id, end })}
      onOpenStack={(ids, anchor) => {
        stack.current = anchor;
        dispatch({ type: 'openStack', ids });
      }}
      emptyAction={
        // The empty panel replaces the grid's own empty line on day and week, so the message sits in the
        // visible window instead of the clipped track and is announced once.
        vm.emptyAction && vm.empty === null
          ? {
              label: 'New event',
              commandId: 'calendar.newEvent',
              onSelect: () => dispatch({ type: 'newEvent' }),
            }
          : undefined
      }
      agenda="full"
      label={vm.gridLabel}
      announce={props.announce}
    />
  );
}

/** The detail popover, the ⋯ and "+N" menus, and the scope question. */
function Surfaces(props: {
  vm: CalendarViewModel;
  dispatch: (action: CalendarAction) => void;
  anchors: Anchors;
  moreAnchor: Anchor;
  detailProps: DetailProps | null;
}) {
  const { vm, dispatch, anchors, moreAnchor, detailProps } = props;
  const close = () => dispatch({ type: 'close' });
  const listPlacement = vm.shown === 'month' || vm.shown === 'agenda';
  return (
    <>
      <Popover
        open={vm.popover !== null && vm.scope === null && anchors.popover !== null}
        anchor={anchors.popover}
        label={vm.popover?.title ?? 'Event'}
        role="dialog"
        placement={listPlacement ? 'below-start' : sideOf(anchors.popover)}
        onClose={close}
      >
        {vm.popover && detailProps ? (
          <div className="cal-screen__popover">
            <EventDetail {...detailProps} presentation="popover" onClose={close} />
            {vm.editing ? <EditingNote editing={vm.editing} dispatch={dispatch} /> : null}
          </div>
        ) : null}
      </Popover>

      <ScreenMenu
        id="cal-menu-more"
        open={vm.moreOpen && moreAnchor !== null}
        anchor={moreAnchor}
        label="More"
        entries={vm.more}
        onSelect={id => dispatch({ type: 'menu', item: id as DetailMenuId })}
        onClose={() => dispatch({ type: 'more', open: false })}
      />

      <ScreenMenu
        id="cal-menu-stack"
        open={vm.stack !== null && anchors.stack !== null}
        anchor={anchors.stack}
        label={vm.stack?.label ?? 'More events'}
        entries={vm.stack?.entries ?? []}
        onSelect={id => dispatch({ type: 'open', id })}
        onClose={() => dispatch({ type: 'closeStack' })}
      />

      <Popover
        open={vm.scope !== null && anchors.scope !== null}
        anchor={anchors.scope}
        label={vm.scope?.title ?? 'Repeating event'}
        role="dialog"
        placement={sideOf(anchors.scope)}
        onClose={() => dispatch({ type: 'scopeCancel' })}
      >
        {vm.scope ? (
          <ScopeChooser
            action={vm.scope.action}
            title={vm.scope.title}
            onChoose={scope => dispatch({ type: 'scope', scope })}
            onCancel={() => dispatch({ type: 'scopeCancel' })}
          />
        ) : null}
      </Popover>
    </>
  );
}

/**
 * The open detail's 'Turn on editing' line and its Enable editing action (shape 3): one small dim line
 * under the detail, the same pattern the accounts block uses for a state and its action — contextual to
 * the event, so a read-only account carries no banner and no standing nag.
 */
function EditingNote({
  editing,
  dispatch,
}: {
  editing: { accountId: string };
  dispatch: (action: CalendarAction) => void;
}) {
  return (
    <div className="cal-editing">
      <span className="cal-editing__line">{EDITING_COPY.notice}</span>
      <Button
        variant="text"
        size="sm"
        label={EDITING_COPY.action}
        ariaLabel={EDITING_COPY.action}
        onPress={() => dispatch({ type: 'enableEditing', accountId: editing.accountId })}
      />
    </div>
  );
}

/**
 * The calm panel for an empty day or week (DESIGN 7.14): centred in the visible scroll window on a quiet card,
 * one plain sentence, what comes next, and the one action. Pointer events pass through except on the card, so a
 * click-drag on the grid around it still creates an event.
 */
function EmptyPanel({
  empty,
  dispatch,
}: {
  empty: EmptyView;
  dispatch: (action: CalendarAction) => void;
}) {
  return (
    <div className="cal-screen__empty">
      <div className="cal-screen__empty-box">
        <div role="status" className="cal-screen__empty-lines">
          <Text variant="title" as="p">
            {empty.sentence}
          </Text>
          <Text variant="small" as="p">
            {empty.next}
          </Text>
        </div>
        <Button
          variant="filled"
          label="New event"
          commandId="calendar.newEvent"
          keyHint="always"
          onPress={() => dispatch({ type: 'newEvent' })}
        />
      </div>
    </div>
  );
}

export function CalendarView({ vm, dispatch, announce, focus }: CalendarViewProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const opened = useRef(new Map<string, HTMLElement>());
  const stackAnchor = useRef<HTMLElement | null>(null);
  const refs = useMemo<AnchorRefs>(() => ({ root: rootRef, opened, stack: stackAnchor }), []);

  usePaneWidth(rootRef, dispatch);
  const anchors = useAnchors(vm, refs);
  const [moreAnchor, setMoreAnchor] = useMoreAnchor(rootRef, vm);
  useFocusRequest(focus, rootRef, railRef);

  const detailProps = detailPropsFor(vm, dispatch, anchor => {
    setMoreAnchor(anchor);
    dispatch({ type: 'more', open: true });
  });
  const grid = (
    <Grid vm={vm} dispatch={dispatch} announce={announce} opened={opened} stack={stackAnchor} />
  );

  return (
    <div ref={rootRef} className="cal-screen" data-view={vm.shown}>
      <ViewControls vm={vm} dispatch={dispatch} />
      <FailedHolds
        holds={vm.failedHolds.items}
        open={vm.failedHolds.open}
        dispatch={dispatch}
        announce={announce}
      />

      {vm.shown === 'day' ? (
        <div className="cal-screen__day" data-rail={vm.rail ? 'true' : undefined}>
          {grid}
          {vm.rail && detailProps ? (
            <aside
              ref={railRef}
              className="cal-screen__rail"
              aria-label="Event details"
              tabIndex={-1}
            >
              <EventDetail
                {...detailProps}
                presentation="rail"
                onClose={() => dispatch({ type: 'close' })}
              />
              {vm.editing ? <EditingNote editing={vm.editing} dispatch={dispatch} /> : null}
            </aside>
          ) : null}
          {vm.empty ? <EmptyPanel empty={vm.empty} dispatch={dispatch} /> : null}
        </div>
      ) : (
        <div className="cal-screen__body">
          {grid}
          {vm.empty ? <EmptyPanel empty={vm.empty} dispatch={dispatch} /> : null}
        </div>
      )}

      <Surfaces
        vm={vm}
        dispatch={dispatch}
        anchors={anchors}
        moreAnchor={moreAnchor}
        detailProps={detailProps}
      />

      {vm.editor ? <EventEditor editor={vm.editor} dispatch={dispatch} /> : null}
    </div>
  );
}

const TITLE_FIELD_ID = 'cal-editor-title';
/** Said once, in the dialog, when every calendar is read-only (the demo's are): no silent disabled Save. */
const NOTHING_WRITABLE = 'None of your calendars can take new events here.';

/** The editor: title, day, start and end, calendar; Save and Cancel; Delete only on a stored event (DESIGN 7.8 Fixes). */
function EventEditor({
  editor,
  dispatch,
}: {
  editor: EditorView;
  dispatch: (a: CalendarAction) => void;
}) {
  const { draft } = editor;
  const [picker, setPicker] = useState<'date' | 'start' | 'end' | 'calendar' | null>(null);
  const [month, setMonth] = useState<IsoYearMonth>(yearMonthOf(draft.date));
  const dateRef = useRef<HTMLButtonElement | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const endRef = useRef<HTMLButtonElement | null>(null);
  const calendarRef = useRef<HTMLButtonElement | null>(null);
  const titleProblem = draft.error === 'Give the event a title.' ? draft.error : undefined;
  const otherProblem = draft.error && !titleProblem ? draft.error : undefined;
  // No calendar here can take a new event (a demo or read-only account): say so, not a silent disabled Save.
  const nothingWritable = !editor.calendarFixed && editor.calendars.length === 0;
  // Editing off for this calendar's account: the note at the top says so and Save waits (no refusal after the form).
  const locked = editor.editing !== null;
  const save = () => {
    if (!locked) dispatch({ type: 'editorSave' });
  };

  return (
    <Dialog
      open
      title={editor.title}
      size="md"
      initialFocusId={TITLE_FIELD_ID}
      onClose={() => dispatch({ type: 'editorCancel' })}
      footer={
        <div className="cal-editor__footer">
          {editor.showDelete ? (
            <Button
              variant="text"
              tone="danger"
              label="Delete"
              commandId="calendar.delete"
              onPress={() => dispatch({ type: 'delete' })}
            />
          ) : null}
          <span className="cal-editor__spacer" />
          <Button
            variant="text"
            label="Cancel"
            keys="Esc"
            onPress={() => dispatch({ type: 'editorCancel' })}
          />
          <Button
            variant="filled"
            label="Save"
            keys="Return"
            keyHint="always"
            disabled={locked || nothingWritable || draft.title.trim() === ''}
            disabledReason={
              locked ? EDITING_COPY.notice : nothingWritable ? NOTHING_WRITABLE : undefined
            }
            onPress={save}
          />
        </div>
      }
    >
      <div className="cal-editor">
        {editor.editing ? <EditingNote editing={editor.editing} dispatch={dispatch} /> : null}
        <TextField
          id={TITLE_FIELD_ID}
          label="Title"
          placeholder="Title"
          value={draft.title}
          error={titleProblem}
          onChange={title => dispatch({ type: 'editor', patch: { title } })}
          onSubmit={save}
        />
        <div className="cal-editor__rows">
          <Text variant="label" as="span">
            Day
          </Text>
          <span className="cal-editor__controls">
            <Button
              ref={dateRef}
              variant="text"
              label={editor.dateLabel}
              trailingIcon="chevron-down"
              popup={{ kind: 'dialog', expanded: picker === 'date', controls: 'cal-editor-date' }}
              onPress={() => {
                setMonth(yearMonthOf(draft.date));
                setPicker('date');
              }}
            />
          </span>
          {draft.allDay ? null : (
            <>
              <Text variant="label" as="span">
                Time
              </Text>
              <span className="cal-editor__controls">
                <Button
                  ref={startRef}
                  variant="text"
                  label={editor.startLabel}
                  trailingIcon="chevron-down"
                  popup={{
                    kind: 'menu',
                    expanded: picker === 'start',
                    controls: 'cal-editor-start',
                  }}
                  onPress={() => setPicker('start')}
                />
                <Text variant="label" as="span">
                  to
                </Text>
                <Button
                  ref={endRef}
                  variant="text"
                  label={editor.endLabel}
                  trailingIcon="chevron-down"
                  popup={{ kind: 'menu', expanded: picker === 'end', controls: 'cal-editor-end' }}
                  onPress={() => setPicker('end')}
                />
              </span>
            </>
          )}
          <Text variant="label" as="span">
            Calendar
          </Text>
          <span className="cal-editor__controls">
            {editor.calendarFixed ? (
              <Button
                variant="text"
                label={editor.calendar?.name ?? 'No calendar'}
                disabled
                disabledReason="An event stays on the calendar it was made on."
                onPress={() => undefined}
              />
            ) : nothingWritable ? (
              <Button
                variant="text"
                label="No calendar to add to"
                disabled
                disabledReason={NOTHING_WRITABLE}
                onPress={() => undefined}
              />
            ) : (
              <Button
                ref={calendarRef}
                variant="text"
                label={editor.calendar?.name ?? 'Choose a calendar'}
                trailingIcon="chevron-down"
                popup={{
                  kind: 'menu',
                  expanded: picker === 'calendar',
                  controls: 'cal-editor-calendar',
                }}
                onPress={() => setPicker('calendar')}
              />
            )}
          </span>
        </div>
        {nothingWritable ? (
          <div role="status" className="cal-editor__problem">
            <Text variant="small" as="span" tone="ink-2">
              {NOTHING_WRITABLE}
            </Text>
          </div>
        ) : null}
        {otherProblem ? (
          <div role="alert" className="cal-editor__problem">
            <Text variant="small" as="span" tone="ink-2">
              {otherProblem}
            </Text>
          </div>
        ) : null}
      </div>

      <Popover
        open={picker === 'date'}
        anchor={dateRef.current}
        label="Choose a day"
        role="dialog"
        onClose={() => setPicker(null)}
      >
        <div className="cal-editor__month" id="cal-editor-date">
          <MiniMonth
            month={month}
            today={editor.today}
            range={{ start: draft.date, end: draft.date }}
            weekStartsOn={editor.weekStartsOn}
            onMonthChange={setMonth}
            onPick={date => {
              dispatch({ type: 'editor', patch: { date } });
              setPicker(null);
              dateRef.current?.focus({ preventScroll: true });
            }}
          />
        </div>
      </Popover>
      <ScreenMenu
        id="cal-menu-start"
        open={picker === 'start'}
        anchor={startRef.current}
        label="Start"
        checkedId={draft.start}
        entries={editor.startChoices.map(t => ({ kind: 'item', id: t, label: formatClock(t) }))}
        onSelect={start => dispatch({ type: 'editor', patch: { start } })}
        onClose={() => setPicker(null)}
      />
      <ScreenMenu
        id="cal-menu-end"
        open={picker === 'end'}
        anchor={endRef.current}
        label="End"
        checkedId={draft.end}
        entries={editor.endChoices.map(c => ({
          kind: 'item',
          id: c.time,
          label: formatClock(c.time),
          aside: c.length,
        }))}
        onSelect={end => dispatch({ type: 'editor', patch: { end } })}
        onClose={() => setPicker(null)}
      />
      <ScreenMenu
        id="cal-menu-calendar"
        open={picker === 'calendar'}
        anchor={calendarRef.current}
        label="Calendar"
        checkedId={draft.calendarId ?? undefined}
        entries={editor.calendars.map(c => ({
          kind: 'item',
          id: c.id,
          label: c.name,
          swatch: c.color,
        }))}
        onSelect={calendarId => dispatch({ type: 'editor', patch: { calendarId } })}
        onClose={() => setPicker(null)}
      />
    </Dialog>
  );
}
