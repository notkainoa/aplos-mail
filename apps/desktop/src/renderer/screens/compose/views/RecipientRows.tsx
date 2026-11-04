/**
 * The To row, and the Cc and Bcc rows once shown (DESIGN 7.6; RecipientField). Typed text stays local until Return,
 * a comma or blur commits it; recipients that fail the plain rules are outlined.
 */
import { useId, useState } from 'react';
import type { Recipient } from '../../../ui/props';
import { RecipientField } from '../../../ui/compose';
import { addRecipients } from '../model/recipients';
import type { ComposeFields } from '../model/fields';

type Row = 'to' | 'cc' | 'bcc';

const LABEL = { to: 'To', cc: 'Cc', bcc: 'Bcc' } as const;

export interface RecipientRowsProps {
  readonly fields: ComposeFields;
  readonly onChange: (patch: Partial<Pick<ComposeFields, Row>>) => void;
  /** Cc and Bcc rows are showing (⌘⇧C, the Cc button, or a draft that has some). */
  readonly showCc: boolean;
  readonly onShowCc: () => void;
  readonly invalid: readonly string[];
  readonly autoFocus?: boolean;
}

function OneRow(props: {
  readonly row: Row;
  readonly recipients: readonly Recipient[];
  readonly onChange: (next: readonly Recipient[]) => void;
  readonly invalid: readonly string[];
  readonly ccButton?: { onSelect: () => void; commandId: string };
  readonly autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const listboxId = `${useId()}-${props.row}`;
  const commit = (text: string) => {
    props.onChange(addRecipients(props.recipients, text));
    setQuery('');
  };
  return (
    <RecipientField
      label={LABEL[props.row]}
      recipients={props.recipients}
      query={query}
      onQueryChange={setQuery}
      onCommit={commit}
      onRemove={id => props.onChange(props.recipients.filter(r => r.id !== id))}
      listboxId={listboxId}
      invalidIds={props.invalid}
      ccButton={props.ccButton}
      autoFocus={props.autoFocus}
    />
  );
}

export function RecipientRows({
  fields,
  onChange,
  showCc,
  onShowCc,
  invalid,
  autoFocus,
}: RecipientRowsProps) {
  const ccButton = showCc ? undefined : { onSelect: onShowCc, commandId: 'compose.ccBcc' };
  return (
    <>
      <OneRow
        row="to"
        recipients={fields.to}
        onChange={to => onChange({ to })}
        invalid={invalid}
        ccButton={ccButton}
        autoFocus={autoFocus}
      />
      {showCc ? (
        <>
          <OneRow
            row="cc"
            recipients={fields.cc}
            onChange={cc => onChange({ cc })}
            invalid={invalid}
          />
          <OneRow
            row="bcc"
            recipients={fields.bcc}
            onChange={bcc => onChange({ bcc })}
            invalid={invalid}
          />
        </>
      ) : null}
    </>
  );
}
