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
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../ui/buttons-keys';
import { CalendarGrid, EventDetail, MiniMonth, ScopeChooser } from '../../ui/calendar';
import { formatClock, yearMonthOf } from '../../ui/calendar/dates';
import { eventDomId, stackDomId } from '../../ui/calendar/eventText';
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
  GridView,
} from './calendar.model';

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

export interface CalendarScreenProps {
  readonly vm: CalendarViewModel;
  readonly dispatch: (action: CalendarAction) => void;
  /** The shell's polite live region (DESIGN 11.3). */
  readonly announce?: Announce;
  readonly focus?: FocusRequest | null;
}

/** A Menu with its own keyboard cursor (Menu is controlled). */
function ScreenMenu(props: {
  open: boolean;
  anchor: Anchor;
  label: string;
  entries: readonly MenuEntry[];
  checkedId?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState<string | undefined>(undefined);
  const first = props.entries.find(
    (e): e is Extract<MenuEntry, { kind: 'item' }> => e.kind === 'item' && !e.disabled,
  );
  useEffect(() => {
    if (props.open) setActive(props.checkedId ?? first?.id);
    // Only on opening: the cursor starts on the checked item, else the first one.
  }, [props.open]);
  return (
    <Menu
      open={props.open}
      anchor={props.anchor}
      label={props.label}
      entries={props.entries}
      activeId={active}
      checkedId={props.checkedId}
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

export function CalendarScreen({ vm, dispatch, announce, focus }: CalendarScreenProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const opened = useRef(new Map<string, HTMLElement>());
  const stackAnchor = useRef<HTMLElement | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<Anchor>(null);
  const [anchors, setAnchors] = useState<{ popover: Anchor; stack: Anchor; scope: Anchor }>({
    popover: null,
    stack: null,
    scope: null,
  });

  // The pane's width decides the narrow agenda (DESIGN 7.8): measured, never guessed.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = (): void => dispatch({ type: 'width', px: Math.round(el.getBoundingClientRect().width) });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [dispatch]);

  // Anchors follow the model: the element a click handed over, else the entry's own element, else the stack that
  // folds it, else the grid. Resolved after layout, so a state opened from outside (a key, the preview) finds its event.
  const anchorFor = (id: string | null | undefined): Anchor => {
    if (!id) return null;
    const held = opened.current.get(id);
    if (held?.isConnected) return held;
    const own = document.getElementById(eventDomId(id));
    if (own) return own;
    if (stackAnchor.current?.isConnected) return stackAnchor.current;
    return rootRef.current?.querySelector<HTMLElement>('.ui-calendar-grid') ?? null;
  };
  const stackIds = vm.stack?.ids.join('\u0000') ?? '';
  useLayoutEffect(() => {
    const stackEl =
      vm.stack && vm.stack.ids.length > 0
        ? (stackAnchor.current?.isConnected ? stackAnchor.current : null) ??
          document.getElementById(stackDomId(vm.stack.ids))
        : null;
    if (stackEl) stackAnchor.current = stackEl;
    setAnchors({
      popover: vm.popover ? anchorFor(vm.popover.id) : null,
      stack: stackEl,
      scope: vm.scope ? anchorFor(vm.scope.entryId) : null,
    });
  }, [vm.popover?.id, vm.scope?.entryId, stackIds, vm.shown, vm.period.start]);

  // A ⋯ menu opened by a key (or the preview) has no click to hand over its button: find it in the open detail.
  useLayoutEffect(() => {
    if (!vm.moreOpen || moreAnchor?.isConnected) return;
    const button = rootRef.current?.querySelector<HTMLElement>(
      '.cal-screen__popover button[aria-haspopup="menu"], .cal-screen__rail button[aria-haspopup="menu"]',
    );
    if (button) setMoreAnchor(button);
  });

  useEffect(() => {
    if (!focus) return;
    const target =
      focus.target === 'rail'
        ? railRef.current
        : rootRef.current?.querySelector<HTMLElement>('.ui-calendar-grid');
    target?.focus({ preventScroll: true });
  }, [focus?.seq]);

  const detail = vm.popover ?? vm.rail;
  const reply =
    vm.reply && detail
      ? {
          answer: vm.reply.answer,
          commands: ANSWER_COMMANDS,
          onAnswer: (answer: 'yes' | 'maybe' | 'no') => dispatch({ type: 'answer', answer }),
          onSend: () => dispatch({ type: 'sendReply' }),
        }
      : undefined;
  const detailProps = detail
    ? {
        event: detail,
        reply,
        onOpenInvite: () => dispatch({ type: 'openInvite' }),
        onOpenVideo: () => dispatch({ type: 'openVideo' }),
        onConfirmPlan: () => dispatch({ type: 'confirmPlan' }),
        onOpenSource: () => dispatch({ type: 'openSource' }),
        onMore: (anchor: HTMLElement) => {
          setMoreAnchor(anchor);
          dispatch({ type: 'more', open: true });
        },
      }
    : null;

  const grid = (
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
        stackAnchor.current = anchor;
        dispatch({ type: 'openStack', ids });
      }}
      emptyAction={
        vm.emptyAction
          ? { label: 'New event', commandId: 'calendar.newEvent', onSelect: () => dispatch({ type: 'newEvent' }) }
          : undefined
      }
      agenda="full"
      label={vm.gridLabel}
      announce={announce}
    />
  );

  return (
    <div ref={rootRef} className="cal-screen" data-view={vm.shown}>
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
            selectedId={vm.view}
            onSelect={id => dispatch({ type: 'view', view: id as GridView })}
          />
        </span>
      </PageHead>

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
              <EventDetail {...detailProps} presentation="rail" />
            </aside>
          ) : null}
        </div>
      ) : (
        <div className="cal-screen__body">{grid}</div>
      )}

      <Popover
        open={vm.popover !== null && vm.scope === null && anchors.popover !== null}
        anchor={anchors.popover}
        label={vm.popover ? vm.popover.title : 'Event'}
        role="dialog"
        placement={vm.shown === 'month' || vm.shown === 'agenda' ? 'below-start' : sideOf(anchors.popover)}
        onClose={() => dispatch({ type: 'close' })}
      >
        {vm.popover && detailProps ? (
          <div className="cal-screen__popover">
            <EventDetail {...detailProps} presentation="popover" onClose={() => dispatch({ type: 'close' })} />
          </div>
        ) : null}
      </Popover>

      <ScreenMenu
        open={vm.moreOpen && moreAnchor !== null}
        anchor={moreAnchor}
        label="More"
        entries={vm.more}
        onSelect={id => dispatch({ type: 'menu', item: id as DetailMenuId })}
        onClose={() => dispatch({ type: 'more', open: false })}
      />

      <ScreenMenu
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
        label={vm.scope ? vm.scope.title : 'Repeating event'}
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

      {vm.editor ? <EventEditor editor={vm.editor} dispatch={dispatch} /> : null}
    </div>
  );
}

const TITLE_FIELD_ID = 'cal-editor-title';

/** The editor: title, day, start and end, calendar; Save and Cancel; Delete only on a stored event (DESIGN 7.8 Fixes). */
function EventEditor({ editor, dispatch }: { editor: EditorView; dispatch: (a: CalendarAction) => void }) {
  const { draft } = editor;
  const [picker, setPicker] = useState<'date' | 'start' | 'end' | 'calendar' | null>(null);
  const [month, setMonth] = useState<IsoYearMonth>(yearMonthOf(draft.date));
  const dateRef = useRef<HTMLButtonElement | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const endRef = useRef<HTMLButtonElement | null>(null);
  const calendarRef = useRef<HTMLButtonElement | null>(null);
  const titleProblem = draft.error === 'Give the event a title.' ? draft.error : undefined;
  const otherProblem = draft.error && !titleProblem ? draft.error : undefined;
  const save = () => dispatch({ type: 'editorSave' });

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
          <Button variant="text" label="Cancel" keys="Esc" onPress={() => dispatch({ type: 'editorCancel' })} />
          <Button variant="filled" label="Save" keys="Return" keyHint="always" onPress={save} />
        </div>
      }
    >
      <div className="cal-editor">
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
                  popup={{ kind: 'menu', expanded: picker === 'start', controls: 'cal-editor-start' }}
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
            ) : (
              <Button
                ref={calendarRef}
                variant="text"
                label={editor.calendar?.name ?? 'Choose a calendar'}
                trailingIcon="chevron-down"
                popup={{ kind: 'menu', expanded: picker === 'calendar', controls: 'cal-editor-calendar' }}
                onPress={() => setPicker('calendar')}
              />
            )}
          </span>
        </div>
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
        open={picker === 'start'}
        anchor={startRef.current}
        label="Start"
        checkedId={draft.start}
        entries={editor.startChoices.map(t => ({ kind: 'item', id: t, label: formatClock(t) }))}
        onSelect={start => dispatch({ type: 'editor', patch: { start } })}
        onClose={() => setPicker(null)}
      />
      <ScreenMenu
        open={picker === 'end'}
        anchor={endRef.current}
        label="End"
        checkedId={draft.end}
        entries={editor.endChoices.map(c => ({ kind: 'item', id: c.time, label: formatClock(c.time), aside: c.length }))}
        onSelect={end => dispatch({ type: 'editor', patch: { end } })}
        onClose={() => setPicker(null)}
      />
      <ScreenMenu
        open={picker === 'calendar'}
        anchor={calendarRef.current}
        label="Calendar"
        checkedId={draft.calendarId ?? undefined}
        entries={editor.calendars.map(c => ({ kind: 'item', id: c.id, label: c.name, swatch: c.color }))}
        onSelect={calendarId => dispatch({ type: 'editor', patch: { calendarId } })}
        onClose={() => setPicker(null)}
      />
    </Dialog>
  );
}
