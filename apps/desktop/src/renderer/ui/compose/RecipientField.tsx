import type { KeyboardEvent } from 'react';
import type { Recipient, RecipientFieldProps } from '../props';
import { Icon } from './icons';
import { Btn } from './parts';

const INPUT_LABEL = { To: 'Add recipients', Cc: 'Add Cc recipients', Bcc: 'Add Bcc recipients' } as const;

function shownName(person: Recipient): string {
  return person.name?.trim() || person.address;
}

/**
 * Recipients as removable names with type-ahead (DESIGN §6 RecipientField, §7.6). A WAI-ARIA combobox: the input owns
 * focus, the suggestions are a listbox, and `aria-activedescendant` names the highlighted one. Return, comma or blur
 * commits typed text; Backspace on an empty input removes the last recipient. Never acts while an IME is composing.
 */
export function RecipientField(props: RecipientFieldProps) {
  const {
    label,
    recipients,
    query,
    onQueryChange,
    onCommit,
    onRemove,
    suggestions = [],
    activeSuggestionId,
    onPickSuggestion,
    listboxId,
    invalidIds = [],
    ccButton,
    autoFocus,
  } = props;
  const open = suggestions.length > 0;
  const activeOption = open && activeSuggestionId ? `${listboxId}-${activeSuggestionId}` : undefined;

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      if (activeSuggestionId && open) {
        event.preventDefault();
        onPickSuggestion?.(activeSuggestionId);
      } else if (query.trim()) {
        event.preventDefault();
        onCommit(query);
      }
    } else if ((event.key === ',' || event.key === ';') && query.trim()) {
      event.preventDefault();
      onCommit(query);
    } else if (event.key === 'Backspace' && query === '' && recipients.length > 0) {
      onRemove(recipients[recipients.length - 1].id);
    }
  }

  return (
    <div className="ui-recipient-field" role="group" aria-label={label} data-label={label.toLowerCase()} data-open={open ? 'true' : undefined}>
      <span className="ui-recipient-field__label" aria-hidden="true">
        {label}
      </span>
      <div className="ui-recipient-field__people">
        {recipients.map((person) => {
          const invalid = invalidIds.includes(person.id);
          return (
            <span key={person.id} className="ui-recipient-field__chip" data-invalid={invalid ? 'true' : undefined} title={person.address}>
              <span className="ui-recipient-field__name" dir="auto">
                {shownName(person)}
              </span>
              {invalid ? <span className="ui-recipient-field__sr">, not a valid address</span> : null}
              <button
                type="button"
                className="ui-recipient-field__remove"
                aria-label={`Remove ${shownName(person)}`}
                onClick={() => onRemove(person.id)}
              >
                <Icon name="close" size="xs" />
              </button>
            </span>
          );
        })}
        <input
          className="ui-recipient-field__input"
          type="text"
          role="combobox"
          aria-label={INPUT_LABEL[label]}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeOption}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (query.trim()) onCommit(query);
          }}
        />
      </div>
      {ccButton ? (
        <Btn variant="text" label="Cc" hint="Add Cc or Bcc" commandId={ccButton.commandId} onPress={ccButton.onSelect} />
      ) : null}
      <ul
        id={listboxId}
        className="ui-recipient-field__list"
        role="listbox"
        aria-label={`${label} suggestions`}
        hidden={!open}
        onMouseDown={(event) => event.preventDefault()}
      >
        {suggestions.map((person) => (
          <li
            key={person.id}
            id={`${listboxId}-${person.id}`}
            className="ui-recipient-field__option"
            role="option"
            aria-selected={person.id === activeSuggestionId}
            data-active={person.id === activeSuggestionId ? 'true' : undefined}
            onClick={() => onPickSuggestion?.(person.id)}
          >
            <span className="ui-recipient-field__option-name" dir="auto">
              {shownName(person)}
            </span>
            {person.name?.trim() ? <span className="ui-recipient-field__option-address">{person.address}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
