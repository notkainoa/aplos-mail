/**
 * The Search page (DESIGN §7.9, §7.14): the field at `heading` size in the PageHead row with its operator pills,
 * local results as ordinary rows under "In your mail", "Search all mail on Google · Return" under them, the busy,
 * none, paused and failed lines, "From Google" once it answers, and the no-match line. Presentational: it takes
 * `SearchPageModel` and the rows, and reports intent through `handlers`. The list keys (J/K, E, L, Return) belong
 * to the registry's `list` context; the shell routes them while the list has focus.
 */
import type { Ref } from 'react';
import { SearchField } from '../../ui/ask';
import { Button } from '../../ui/buttons-keys';
import { EmptyLine, ErrorLine, ListBox, ListGroup, ListRow } from '../../ui/list';
import { PageHead, Text } from '../../ui/surfaces';
import type { CommandId, Density, RowAction } from '../../ui/props';
import {
  fieldTokens,
  retryTarget,
  SEARCH_GOOGLE,
  type ResultRow,
  type SearchPageModel,
} from './search.model';

/** Done, Later and Trash overlay the date column on hover (DESIGN §5 rule 17). */
export const RESULT_ACTIONS: readonly RowAction[] = [
  { commandId: 'mail.done', icon: 'check', label: 'Done' },
  { commandId: 'mail.later', icon: 'clock', label: 'Later' },
  { commandId: 'mail.trash', icon: 'trash', label: 'Trash' },
];

export interface SearchPageHandlers {
  onChange: (value: string) => void;
  onRemoveToken: (index: number) => void;
  /** Return in the field: search all mail on Google (only Return does). */
  onSubmit: () => void;
  /** "Clear search" under a no-match line: empties the field and the pills, and the field takes focus. */
  onClear: () => void;
  /** Try again on a failed local window: the screen remounts the view (`Reopenable`). */
  onRetryResults: () => void;
  onLeaveToList: (edge: 'first' | 'last') => void;
  onSelectRow: (threadId: string) => void;
  onOpenRow: (threadId: string) => void;
  onRowAction: (threadId: string, commandId: CommandId, anchor: HTMLElement) => void;
  onScope?: (anchor: HTMLElement) => void;
}

export interface SearchPageProps {
  readonly model: SearchPageModel;
  /** Rows in window order, local then remote. */
  readonly localRows: readonly ResultRow[];
  readonly remoteRows: readonly ResultRow[];
  readonly cursorId?: string;
  readonly density: Density;
  readonly scopeLabel: string;
  readonly handlers: SearchPageHandlers;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly listRef?: Ref<HTMLElement>;
}

const NO_MATCH_HINT = 'Try fewer words or remove a filter.';

/** The quiet way out of a dead end: empty the search and type again. */
const CLEAR_SEARCH = (onSelect: () => void) =>
  ({ label: 'Clear search', emphasis: 'text', onSelect }) as const;

export const RESULTS_ID = 'search-results';

function Row({ row, props }: { row: ResultRow; props: SearchPageProps }) {
  const { handlers } = props;
  return (
    <ListRow
      id={row.id}
      layout="list"
      density={props.density}
      sender={row.sender}
      primary={row.primary}
      secondary={row.secondary}
      highlight={row.highlight}
      unread={row.unread}
      date={row.date}
      marks={row.marks}
      account={row.account}
      cursor={props.cursorId === row.id}
      picked={false}
      picking={false}
      hoverActions={RESULT_ACTIONS}
      onSelect={() => handlers.onSelectRow(row.threadId)}
      onOpen={() => handlers.onOpenRow(row.threadId)}
      onAction={(commandId, anchor) => handlers.onRowAction(row.threadId, commandId, anchor)}
    />
  );
}

/** The Google line that belongs inside the no-match empty state (busy, none, paused), else undefined. */
function emptyDetailOf(model: SearchPageModel): string | undefined {
  const line = model.remoteLine;
  if (model.noMatch === null || !line) return undefined;
  return ['busy', 'none', 'paused'].includes(line.kind) ? line.text : undefined;
}

export function SearchPage(props: SearchPageProps) {
  const { model, localRows, remoteRows, handlers, cursorId } = props;
  const line = model.remoteLine;
  const field = (
    <SearchField
      value={model.field}
      onChange={handlers.onChange}
      tokens={fieldTokens(model.tokens)}
      onRemoveToken={handlers.onRemoveToken}
      onSubmit={handlers.onSubmit}
      scopeLabel={props.scopeLabel}
      onScope={handlers.onScope}
      resultsId={RESULTS_ID}
      onLeaveToList={handlers.onLeaveToList}
      inputRef={props.inputRef}
    />
  );
  // With nothing local, the Google line is part of the centred empty state, not a stray line at the pane's foot.
  const emptyDetail = emptyDetailOf(model);
  const inEmpty = emptyDetail !== undefined;
  const showList = localRows.length > 0 || remoteRows.length > 0;
  // With nothing typed the rows are the newest mail, not results, so the label does not read like a count of hits.
  const browsing = model.empty;
  return (
    <div className="search-screen">
      <span className="ui-sr-only" role="status">
        {model.announce}
      </span>
      <PageHead lead={{ kind: 'field', field }} />
      <div className="search-screen__column">
        {showList ? (
          <ListBox
            ref={props.listRef}
            binding={{ id: RESULTS_ID, label: 'Search results', activeDescendantId: cursorId }}
          >
            {localRows.length > 0 ? (
              <ListGroup
                header={{
                  id: 'search-local',
                  label: browsing ? 'Recent mail' : 'In your mail',
                  variant: 'section',
                  count: model.localCount,
                }}
              >
                {localRows.map(row => (
                  <Row key={row.id} row={row} props={props} />
                ))}
              </ListGroup>
            ) : null}
            {remoteRows.length > 0 ? (
              <ListGroup
                header={{
                  id: 'search-remote',
                  label: 'From Google',
                  variant: 'section',
                  count: remoteRows.length,
                }}
              >
                {remoteRows.map(row => (
                  <Row key={row.id} row={row} props={props} />
                ))}
              </ListGroup>
            ) : null}
          </ListBox>
        ) : null}
        {model.localLine?.kind === 'list' ? (
          <ErrorLine
            kind="listFailed"
            placement="column"
            onAction={() => handlers.onRetryResults()}
          />
        ) : null}
        {model.localLine?.kind === 'reason' ? (
          <div className="search-screen__remote">
            <ErrorLine
              kind="reason"
              text={model.localLine.text}
              retryable
              placement="column"
              onAction={() => handlers.onRetryResults()}
            />
          </div>
        ) : null}
        {model.noMatch ? (
          <EmptyLine
            text={model.noMatch}
            detail={emptyDetail ?? NO_MATCH_HINT}
            action={
              model.noMatchOffer
                ? {
                    label: SEARCH_GOOGLE,
                    icon: 'globe',
                    keys: 'Return',
                    emphasis: 'text',
                    onSelect: handlers.onSubmit,
                  }
                : CLEAR_SEARCH(handlers.onClear)
            }
            secondaryAction={model.noMatchOffer ? CLEAR_SEARCH(handlers.onClear) : undefined}
          />
        ) : null}
        {line?.kind === 'offer' ? (
          <div className="search-screen__remote">
            <Button
              variant="text"
              icon="globe"
              label={line.text}
              keys="Return"
              keyHint="always"
              onPress={handlers.onSubmit}
            />
          </div>
        ) : null}
        {line && !inEmpty && (line.kind === 'busy' || line.kind === 'none') ? (
          <div className="search-screen__remote" role="status">
            <Text variant="small" tone="dim" icon="globe">
              {line.text}
            </Text>
          </div>
        ) : null}
        {line?.kind === 'paused' && !inEmpty ? (
          <div className="search-screen__remote" role="status">
            <Text variant="small" tone="dim" icon="pause">
              {line.text}
            </Text>
          </div>
        ) : null}
        {line?.kind === 'failed' ? (
          <div className="search-screen__remote">
            <ErrorLine
              kind="reason"
              text={line.text}
              retryable={line.retry}
              placement="column"
              onAction={() =>
                retryTarget(model) === 'results' ? handlers.onRetryResults() : handlers.onSubmit()
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
