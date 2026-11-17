/**
 * The To row, and the Cc and Bcc rows once shown (DESIGN 7.6; RecipientField). Typed text stays local until Return,
 * a comma or blur commits it; recipients that fail the plain rules are outlined. Under the field a dropdown offers
 * people you have written to or heard from (the From account's correspondents): arrows move, Return or Tab accepts,
 * Esc closes it without leaving the composer. The engine answers from local data only.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Recipient } from '../../../ui/props';
import { RecipientField } from '../../../ui/compose';
import { addRecipients } from '../model/recipients';
import type { ComposeFields } from '../model/fields';
import { initialActive, suggestKey, toSuggestions, type SuggestFn } from '../model/suggestions';
import { contactSuggest, useRecipientSuggest } from '../runtime/useRecipientSuggest';

type Row = 'to' | 'cc' | 'bcc';

const LABEL = { to: 'To', cc: 'Cc', bcc: 'Bcc' } as const;

export interface RecipientRowsProps {
  readonly fields: ComposeFields;
  /** The From account: its correspondents are who the dropdown offers. */
  readonly accountId: string;
  readonly onChange: (patch: Partial<Pick<ComposeFields, Row>>) => void;
  /** Cc and Bcc rows are showing (⌘⇧C, the Cc button, or a draft that has some). */
  readonly showCc: boolean;
  readonly onShowCc: () => void;
  readonly invalid: readonly string[];
  readonly autoFocus?: boolean;
  /** Each row hands over its "commit what is typed", for the composer's send. */
  readonly registerTyped?: (commit: () => void) => () => void;
  /** Asks for suggestions; the running app uses `Contact/suggest`, a test passes its own. */
  readonly suggest?: SuggestFn;
}

function OneRow(props: {
  readonly accountId: string;
  readonly suggest: SuggestFn;
  readonly row: Row;
  readonly recipients: readonly Recipient[];
  readonly onChange: (next: readonly Recipient[]) => void;
  readonly invalid: readonly string[];
  readonly ccButton?: { onSelect: () => void; commandId: string };
  readonly autoFocus?: boolean;
  readonly registerTyped?: (commit: () => void) => () => void;
}) {
  const [query, setQuery] = useState('');
  const [arrowed, setArrowed] = useState<string | undefined>(undefined);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const listboxId = `${useId()}-${props.row}`;
  const entries = useRecipientSuggest(query, props.accountId, props.suggest);
  const list =
    query.trim() === '' || closedFor === query ? [] : toSuggestions(entries, props.recipients);
  const active =
    arrowed !== undefined && list.some(r => r.id === arrowed)
      ? arrowed
      : initialActive(query, list);
  const reset = () => {
    setQuery('');
    setArrowed(undefined);
    setClosedFor(null);
  };
  const commit = (text: string) => {
    props.onChange(addRecipients(props.recipients, text));
    reset();
  };
  // The newest query and rows, read when a send asks for the typed text (not the render it was registered in).
  const latest = useRef({ query, recipients: props.recipients, onChange: props.onChange });
  latest.current = { query, recipients: props.recipients, onChange: props.onChange };
  const { registerTyped } = props;
  useEffect(
    () =>
      registerTyped?.(() => {
        const now = latest.current;
        if (now.query.trim() !== '') now.onChange(addRecipients(now.recipients, now.query));
      }),
    [registerTyped],
  );
  const pick = (id: string) => {
    const person = list.find(r => r.id === id);
    if (!person) return;
    props.onChange([...props.recipients, person]);
    reset();
  };
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || list.length === 0) return;
    if (!(event.target instanceof HTMLInputElement)) return;
    const step = suggestKey(event.key, event.shiftKey, list, active);
    if (!step) return;
    event.preventDefault();
    if (step.type === 'highlight') setArrowed(step.id);
    else if (step.type === 'accept') pick(step.id);
    else {
      // Esc closes the dropdown only: the composer stays open (the shell never sees this key).
      event.stopPropagation();
      setClosedFor(query);
    }
  };
  return (
    <div className="compose-suggest" onKeyDownCapture={onKeyDownCapture}>
      <RecipientField
        label={LABEL[props.row]}
        recipients={props.recipients}
        query={query}
        onQueryChange={value => {
          setQuery(value);
          setArrowed(undefined);
          setClosedFor(null);
        }}
        onCommit={commit}
        onRemove={id => props.onChange(props.recipients.filter(r => r.id !== id))}
        suggestions={list}
        activeSuggestionId={active}
        onPickSuggestion={pick}
        listboxId={listboxId}
        invalidIds={props.invalid}
        ccButton={props.ccButton}
        autoFocus={props.autoFocus}
      />
      <span className="ui-recipient-field__sr" role="status">
        {list.length > 0
          ? `${list.length} ${list.length === 1 ? 'suggestion' : 'suggestions'}`
          : ''}
      </span>
    </div>
  );
}

export function RecipientRows({
  fields,
  accountId,
  onChange,
  showCc,
  onShowCc,
  invalid,
  autoFocus,
  registerTyped,
  suggest = contactSuggest,
}: RecipientRowsProps) {
  const ccButton = showCc ? undefined : { onSelect: onShowCc, commandId: 'compose.ccBcc' };
  return (
    <>
      <OneRow
        row="to"
        accountId={accountId}
        suggest={suggest}
        recipients={fields.to}
        onChange={to => onChange({ to })}
        invalid={invalid}
        ccButton={ccButton}
        autoFocus={autoFocus}
        registerTyped={registerTyped}
      />
      {showCc ? (
        <>
          <OneRow
            row="cc"
            accountId={accountId}
            suggest={suggest}
            recipients={fields.cc}
            onChange={cc => onChange({ cc })}
            invalid={invalid}
            registerTyped={registerTyped}
          />
          <OneRow
            row="bcc"
            accountId={accountId}
            suggest={suggest}
            recipients={fields.bcc}
            onChange={bcc => onChange({ bcc })}
            invalid={invalid}
            registerTyped={registerTyped}
          />
        </>
      ) : null}
    </>
  );
}
