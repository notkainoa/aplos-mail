/**
 * The shared list as DESIGN 7.4 draws it: one listbox of rows with no focus letter, optional date groups in section
 * labels, the neutral keyboard cursor, hover actions over the date column, the empty sentence, and a confirmation for
 * the destructive verbs. Presentational over `MailListState`: every change goes out through its actions.
 */
import { useEffect, useState } from 'react';
import { useNow } from '../../data';
import { CommitTemplates } from '../CommitTemplates';
import { ListBox, ListGroup, ListRow } from '../../ui/list';
import { LoadingLine } from '../../ui/reader';
import type { ListboxBinding } from '../../ui/props';
import { failurePhrase } from '../home/homeRows';
import type { ListActions } from './listActions';
import { groupByDate } from './listModel';
import { dateMsOf, listRowPropsFor } from './listRows';
import { BulkMenu } from './BulkMenu';
import { ListConfirm, ListEmpty, ListFailed } from './ListStates';
import { rowDomId, type MailListState } from './useMailList';

/** The hover buttons' commands, routed to the row they sit on. */
export function runRowAction(actions: ListActions, commandId: string, id: string): void {
  switch (commandId) {
    case 'mail.done':
      return actions.done(id);
    case 'mail.later':
      return actions.later(id);
    case 'mail.restore':
      return actions.restore(id);
    case 'done.moveToHome':
      return actions.moveToHome(id);
  }
}

/** Props for one row of a list. */
export interface RowProps {
  readonly list: MailListState;
  readonly id: string;
  /** The clock, for the Later chip's overdue flag. */
  readonly nowMs?: number;
  /** A hover button was pressed; default routes it to the list's actions. */
  readonly onAction?: (commandId: string, id: string) => void;
}

export function Row({ list, id, nowMs, onAction }: RowProps) {
  const { config, view, actions, cursor } = list;
  const row = list.rowOf(id);
  if (!row) return null;
  const failure = view.failures.get(id);
  const rejected = failure
    ? { op: failurePhrase(failure.action), onRetry: () => void failure.retry() }
    : undefined;
  return (
    <ListRow
      key={id}
      {...listRowPropsFor(row, {
        config,
        nowMs,
        domId: rowDomId(config, id),
        density: list.density,
        cursor: cursor.key === id,
        accounts: list.accounts,
        picked: list.bulk.selection.picked.has(id),
        picking: list.bulk.picking,
        rejected,
        handlers: {
          // A click on the row the cursor is already on opens it; a click elsewhere only moves the cursor there.
          onSelect: () => (cursor.key === id ? actions.open(id) : cursor.setCursor(id)),
          onOpen: () => actions.open(id),
          onAction: commandId => (onAction ?? defaultAction(actions))(commandId, id),
        },
      })}
    />
  );
}

function defaultAction(actions: ListActions) {
  return (commandId: string, id: string) => runRowAction(actions, commandId, id);
}

function Rows({ list, ids }: { readonly list: MailListState; readonly ids: readonly string[] }) {
  return ids.map(id => <Row key={id} list={list} id={id} />);
}

function Groups({ list }: { readonly list: MailListState }) {
  const now = useNow({ granularity: 'minute' });
  const { config } = list;
  const dateOf = (id: string) => {
    const row = list.rowOf(id);
    return row ? dateMsOf(row, config.dateField) : undefined;
  };
  return groupByDate(list.ids, dateOf, now).map(group => (
    <ListGroup
      key={group.key}
      header={{
        id: `${config.id}-group-${group.key}`,
        label: group.label,
        variant: 'date',
        count: group.ids.length,
      }}
    >
      <Rows list={list} ids={group.ids} />
    </ListGroup>
  ));
}

/** A first open may fetch a `lazy` folder from the provider: the quiet line appears only once it is slow. */
const OPENING_SLOW_MS = 1_500;

function useSlow(opening: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!opening) return;
    const timer = setTimeout(() => setSlow(true), OPENING_SLOW_MS);
    return () => clearTimeout(timer);
  }, [opening]);
  return slow;
}

/** The list, or its empty line once the view is live and holds nothing. */
export function MailListView({ list }: { readonly list: MailListState }) {
  const { config, view, cursor, actions, confirmation, pointer } = list;
  const opening = view.status !== 'live' && view.status !== 'failed' && view.ids.length === 0;
  const slow = useSlow(opening);
  if (view.status === 'live' && view.ids.length === 0 && view.total === 0)
    return (
      <ListEmpty
        text={config.empty}
        icon={config.emptyIcon}
        detail={config.emptyDetail}
        state={list.empty}
      />
    );
  if (view.status === 'failed' && view.ids.length === 0) return <ListFailed />;
  if (opening) return slow ? <LoadingLine label={`Loading ${config.name}…`} /> : null;
  const binding: ListboxBinding = {
    id: config.id,
    label: config.name,
    activeDescendantId: cursor.key === null ? undefined : rowDomId(config, cursor.key),
  };
  return (
    <div className="aplos-list-column" data-screen={config.kind} {...pointer}>
      <ListBox binding={binding} multiselectable={list.bulk.picking}>
        {config.dateGroups ? <Groups list={list} /> : <Rows list={list} ids={list.ids} />}
      </ListBox>
      <CommitTemplates forwardedRef={list.templates} />
      <BulkMenu menu={list.bulkMenu} />
      {confirmation ? (
        <ListConfirm
          confirmation={confirmation}
          onConfirm={actions.confirm}
          onCancel={actions.cancelConfirm}
        />
      ) : null}
    </div>
  );
}
