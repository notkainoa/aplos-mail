/**
 * The thread the one-by-one view is on, as the focus letter in its slot, centred in the pane. Presentational: the
 * row, its section and the handlers come in. When the reader lands the view hands each thread to it instead.
 */
import type { ThreadRow } from '../../data';
import type { Density } from '../../ui/props';
import { FocusLetter, FocusSlot, ListBox } from '../../ui/list';
import { rowDomId } from './HomeList';
import type { SectionKey } from './homeModel';
import { dateOf, dueOf, senderOf, suggestionOf, summaryOf } from './homeRows';

/** Props for `OneByOneLetter`. */
export interface OneByOneLetterProps {
  readonly row: ThreadRow;
  readonly section: SectionKey;
  readonly density: Density;
  readonly rejected: { readonly op: string; readonly onRetry: () => void } | undefined;
  readonly onSuggestion: () => void;
  readonly onLater: () => void;
  readonly onDone: () => void;
  readonly onMore: (anchor: HTMLElement) => void;
}

const COMMANDS = {
  suggest: 'mail.suggested',
  later: 'mail.later',
  done: 'mail.done',
  more: 'list.more',
} as const;

export function OneByOneLetter(props: OneByOneLetterProps) {
  const { row, section, density, rejected } = props;
  const id = rowDomId(row.id);
  return (
    <div className="aplos-one-by-one__stage" key={row.id}>
      <ListBox binding={{ id: 'one-by-one-list', label: 'One by one', activeDescendantId: id }}>
        <FocusSlot density={density}>
          <FocusLetter
            id={id}
            sender={senderOf(row)}
            due={dueOf(row)}
            date={dateOf(row)}
            summary={summaryOf(row)}
            suggestion={suggestionOf(row, section)}
            commands={COMMANDS}
            demoted={false}
            rejected={rejected}
            onSuggestion={props.onSuggestion}
            onLater={props.onLater}
            onDone={props.onDone}
            onMore={props.onMore}
          />
        </FocusSlot>
      </ListBox>
    </div>
  );
}
