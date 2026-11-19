import type { OperatorTokenProps } from '../props';
import { Icon } from '../compose/icons';

/**
 * A removable pill for a recognised search operator, "from: jordan" (DESIGN §6 SearchField + OperatorToken, §4.5).
 * The pill radius belongs only to counts and operator tokens. The remove button is the pointer path; Backspace in an
 * empty field removes the last token (SearchField).
 */
export function OperatorToken({ operator, value, onRemove }: OperatorTokenProps) {
  return (
    <span className="ui-operator-token" data-operator={operator}>
      <b className="ui-operator-token__op">{`${operator}:`}</b>
      <span className="ui-operator-token__value" dir="auto">
        {value}
      </span>
      <button
        type="button"
        className="ui-operator-token__remove"
        aria-label={`Remove ${operator}: ${value}`}
        title="Remove"
        onClick={onRemove}
      >
        <Icon name="close" size="xs" />
      </button>
    </span>
  );
}
