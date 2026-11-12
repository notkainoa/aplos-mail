/**
 * Later (DESIGN 7.3): the groups Overdue, Today, This week and Someday, a Later | Bookmarks switch on the right of the
 * page head, re-dating on L or D through the date presets, and drag to reschedule with a ghost and named drop targets.
 * The keyboard never needs the drag. A thread that comes back from Later shows on Home under "Back from Later"; Clear
 * from Home sends it here again, to Overdue. Every key is the registry's.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, toIsoDate, useNow, useSettings, type AccountId } from '../../data';
import { dismissToast, pushToast } from '../../shell';
import { ListBox, ListGroup } from '../../ui/list';
import type { ListboxBinding } from '../../ui/props';
import { PageHead, Puck } from '../../ui/surfaces';
import { CommitTemplates } from '../CommitTemplates';
import { BOOKMARKS_CONFIG, LATER_CONFIG } from '../lists/listKinds';
import { useListKeys } from '../lists/listCommands';
import type { OpenKind } from '../lists/listRows';
import { ListEmpty } from '../lists/ListStates';
import { Reopenable } from '../lists/Reopenable';
import { MailListView, Row, runRowAction } from '../lists/MailListView';
import { rowDomId, useMailList, type MailListState } from '../lists/useMailList';
import { reschedule } from './laterActions';
import { guarded, useLaterKeys, type LaterActions } from './laterCommands';
import { dropTargets, headerDrop } from './laterDrag';
import {
  flatIds,
  keepEmptied,
  withDropZones,
  type LaterGroup,
  type LaterGroupKey,
  groupsOf,
} from './laterGroups';
import { CLOSED, pickerReducer } from './laterPickerState';
import { laterPresets, momentLabel } from './laterPresets';
import { LaterPicker } from './LaterPicker';
import { groupDomId, useLaterDrag } from './useLaterDrag';

/** Props for `LaterScreen`. */
export interface LaterScreenProps {
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
  /** Open a thread in the reader (the reader lane owns it; absent until it lands). */
  readonly onOpen?: (id: string, kind: OpenKind, listIds?: readonly string[]) => void;
}

type Which = 'later' | 'bookmarks';

const SWITCH_ITEMS = [
  { id: 'later', label: 'Later' },
  { id: 'bookmarks', label: 'Bookmarks' },
] as const;

/** While held, a group that emptied stays on screen at 0 until the hold releases. */
function useHeldGroups(next: LaterGroup[], held: boolean): LaterGroup[] {
  const shown = useRef<readonly LaterGroup[]>(next);
  const groups = keepEmptied(shown.current, next, held);
  shown.current = groups;
  return groups;
}

function BookmarksBody(props: LaterScreenProps) {
  const list = useMailList(BOOKMARKS_CONFIG, { ...props, returnKey: 'later' });
  useListKeys(list.actions);
  return <MailListView list={list} />;
}

function groupKeyOf(groups: readonly LaterGroup[]): (id: string) => LaterGroupKey | undefined {
  const byId = new Map(groups.flatMap(group => group.ids.map(id => [id, group.key] as const)));
  return id => byId.get(id);
}

function LaterBody(props: LaterScreenProps) {
  const [picker, dispatch] = useReducer(pickerReducer, CLOSED);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const list = useMailList(LATER_CONFIG, {
    ...props,
    returnKey: 'later',
    modal: picker.open ? 'datePicker' : null,
    drawnIds: drawn => flatIds(groupsOf(drawn.ids, drawn.sections, drawn.position)),
  });
  const nowMs = useNow({ granularity: 'minute' });
  const weekStart = useSettings()?.ui.calendar?.weekStart ?? 1;
  const presets = useMemo(() => laterPresets(nowMs, weekStart), [nowMs, weekStart]);
  const targets = useMemo(() => dropTargets(presets, nowMs), [presets, nowMs]);
  const { view } = list;
  const groups = useHeldGroups(groupsOf(view.ids, view.sections, view.position), list.hold.isHeld);

  const move = (id: string, until: number | undefined, label: string) =>
    reschedule(
      {
        act: args => api.thread.act(args),
        push: pushToast,
        dismiss: dismissToast,
        hold: ids => list.hold.extend(ids),
      },
      id,
      until,
      label,
    );
  const openPicker = (key?: string) => {
    const id = key ?? list.cursor.key;
    if (id === null) return;
    setAnchor(document.getElementById(rowDomId(LATER_CONFIG, id)));
    dispatch({ type: 'open', id, today: toIsoDate(nowMs), first: presets[0]?.id ?? 'tomorrow' });
  };
  const latestPicker = useRef(openPicker);
  useEffect(() => {
    latestPicker.current = openPicker;
  });
  const openLatestPicker = useCallback((key?: string) => latestPicker.current(key), []);
  const lifted = useRef(false);
  const actions = useMemo<LaterActions>(
    () => guarded({ ...list.actions, openPicker: openLatestPicker }, () => lifted.current),
    [list.actions, openLatestPicker],
  );
  useLaterKeys(actions);

  const { drag, handlers } = useLaterDrag({
    config: LATER_CONFIG,
    groupOf: groupKeyOf(groups),
    targets,
    onDrop: drop => move(drop.id, drop.until, drop.label),
  });
  lifted.current = drag.phase === 'lifted';
  const rowAction = (commandId: string, id: string) =>
    commandId === 'mail.setDate' ? openPicker(id) : runRowAction(list.actions, commandId, id);

  if (view.status === 'live' && view.total === 0 && groups.length === 0)
    return <ListEmpty text={LATER_CONFIG.empty} icon={LATER_CONFIG.emptyIcon} state={list.empty} />;
  return (
    <div
      data-screen="later"
      data-dragging={drag.phase === 'lifted' ? 'true' : undefined}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={event => {
        list.pointer.onPointerMove(event);
        handlers.onPointerMove(event);
      }}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onPointerLeave={list.pointer.onPointerLeave}
    >
      <LaterGroups
        list={list}
        groups={drag.phase === 'lifted' ? withDropZones(groups) : groups}
        nowMs={nowMs}
        drag={{ drag, targets }}
        onAction={rowAction}
      />
      <CommitTemplates forwardedRef={list.templates} />
      <LaterPicker
        state={picker}
        dispatch={dispatch}
        anchor={anchor}
        presets={presets}
        today={toIsoDate(nowMs)}
        nowMs={nowMs}
        onChoose={choice => move(choice.id, choice.until, choice.label)}
        nameOf={until => momentLabel(until, nowMs)}
      />
    </div>
  );
}

interface LaterGroupsProps {
  readonly list: MailListState;
  readonly groups: readonly LaterGroup[];
  readonly nowMs: number;
  readonly drag: {
    readonly drag: Parameters<typeof headerDrop>[1];
    readonly targets: Parameters<typeof headerDrop>[2];
  };
  readonly onAction: (commandId: string, id: string) => void;
}

function LaterGroups({ list, groups, nowMs, drag, onAction }: LaterGroupsProps) {
  const binding: ListboxBinding = {
    id: LATER_CONFIG.id,
    label: LATER_CONFIG.name,
    activeDescendantId:
      list.cursor.key === null ? undefined : rowDomId(LATER_CONFIG, list.cursor.key),
  };
  return (
    <ListBox binding={binding}>
      {groups.map(group => (
        <ListGroup
          key={group.key}
          header={{
            id: groupDomId(group.key),
            label: group.label,
            variant: 'section',
            count: group.count,
            held: group.held,
            tone: group.key === 'overdue' ? 'overdue' : 'default',
            dropTarget: headerDrop(group.key, drag.drag, drag.targets),
          }}
        >
          {group.ids.map(id => (
            <Row key={id} list={list} id={id} nowMs={nowMs} onAction={onAction} />
          ))}
        </ListGroup>
      ))}
    </ListBox>
  );
}

export function LaterScreen(props: LaterScreenProps) {
  const [which, setWhich] = useState<Which>('later');
  return (
    <div className="aplos-list-column">
      <PageHead>
        <Puck
          kind="segmented"
          role="tabs"
          label="Later view"
          items={SWITCH_ITEMS}
          selectedId={which}
          onSelect={id => setWhich(id === 'bookmarks' ? 'bookmarks' : 'later')}
        />
      </PageHead>
      <Reopenable key={which}>
        {which === 'later' ? <LaterBody {...props} /> : <BookmarksBody {...props} />}
      </Reopenable>
    </div>
  );
}
