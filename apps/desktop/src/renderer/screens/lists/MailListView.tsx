/**
 * The shared list as DESIGN 7.4 draws it: one listbox of rows with no focus letter, optional date groups in section
 * labels, the neutral keyboard cursor, hover actions over the date column, the empty sentence, and a confirmation for
 * the destructive verbs. Presentational over `MailListState`: every change goes out through its actions.
 */
import { useNow } from '../../data';
import { ListBox, ListGroup, ListRow } from '../../ui/list';
import type { ListboxBinding } from '../../ui/props';
import { failurePhrase } from '../home/homeRows';
import type { ListActions } from './listActions';
import { groupByDate } from './listModel';
import { dateMsOf, listRowPropsFor } from './listRows';
import { ListConfirm, ListEmpty } from './ListStates';
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
        rejected,
        handlers: {
          onSelect: () => cursor.setCursor(id),
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

/** The list, or its empty line once the view is live and holds nothing. */
export function MailListView({ list }: { readonly list: MailListState }) {
  const { config, view, cursor, actions, confirmation, pointer } = list;
  if (view.status === 'live' && view.ids.length === 0 && view.total === 0)
    return <ListEmpty text={config.empty} state={list.empty} />;
  if (view.status !== 'live' && view.ids.length === 0) return null;
  const binding: ListboxBinding = {
    id: config.id,
    label: config.name,
    activeDescendantId: cursor.key === null ? undefined : rowDomId(config, cursor.key),
  };
  return (
    <div className="aplos-list-column" data-screen={config.kind} {...pointer}>
      <ListBox binding={binding}>
        {config.dateGroups ? <Groups list={list} /> : <Rows list={list} ids={list.ids} />}
      </ListBox>
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
