import type { KeyboardEvent } from 'react';
import type { SearchFieldProps } from '../props';
import { Icon } from '../compose/icons';
import { Btn } from '../compose/parts';
import { OperatorToken } from './OperatorToken';

/** The fixed hint under an empty field (DESIGN §7.9). */
export const SEARCH_HINT = 'Narrow with from:, to:, subject:, has:attachment, before:, after:, in:done';

/**
 * The Search page field at `heading` size in the PageHead row, with a 2 px accent underline while it has focus
 * (DESIGN §6 SearchField, §7.9, §11.2). Operators become tokens under it, or the fixed hint when there are none.
 * Return searches all mail on Google, and only Return does; ↓ and ↑ hand the keyboard to the results.
 * Single-key shortcuts never reach a text field, and nothing acts while an IME is composing.
 */
export function SearchField(props: SearchFieldProps) {
  const { value, onChange, tokens, onRemoveToken, onSubmit, scopeLabel, onScope, resultsId, onLeaveToList, inputRef } = props;

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      onSubmit();
    } else if (event.key === 'Backspace' && value === '' && tokens.length > 0) {
      event.preventDefault();
      onRemoveToken(tokens.length - 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      onLeaveToList('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      onLeaveToList('last');
    }
  }

  return (
    <div className="ui-search-field" role="search">
      <label className="ui-search-field__title">
        <Icon name="search" />
        <input
          ref={inputRef}
          className="ui-search-field__input"
          type="text"
          role="combobox"
          aria-label="Search mail"
          aria-controls={resultsId}
          aria-expanded={true}
          aria-autocomplete="list"
          placeholder="Search mail"
          autoComplete="off"
          spellCheck={false}
          dir="auto"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <div className="ui-search-field__meta">
        <span className="ui-search-field__tokens">
          {tokens.length === 0 ? (
            <span className="ui-search-field__hint">{SEARCH_HINT}</span>
          ) : (
            tokens.map((token, index) => (
              <OperatorToken key={`${token.operator}:${token.value}:${index}`} operator={token.operator} value={token.value} onRemove={() => onRemoveToken(index)} />
            ))
          )}
        </span>
        {onScope ? (
          <Btn variant="text" label={scopeLabel} hint="Search scope" trailingIcon="chevron-down" onPress={onScope} />
        ) : (
          <span className="ui-search-field__scope">{scopeLabel}</span>
        )}
      </div>
    </div>
  );
}
