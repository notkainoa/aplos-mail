import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SearchFieldProps } from '../props';
import { Icon } from '../compose/icons';
import { Btn } from '../compose/parts';
import { OperatorToken } from './OperatorToken';

/**
 * The fixed hint under an empty field (DESIGN §7.9): "Narrow with" and these operators in this order. Each is a quiet
 * button that puts its text in the field; one that needs no value ends in a space, so it becomes a token at once.
 */
const HINT_OPERATORS: readonly { readonly label: string; readonly insert: string }[] = [
  { label: 'from:', insert: 'from:' },
  { label: 'to:', insert: 'to:' },
  { label: 'subject:', insert: 'subject:' },
  { label: 'has:attachment', insert: 'has:attachment ' },
  { label: 'before:', insert: 'before:' },
  { label: 'after:', insert: 'after:' },
  { label: 'in:done', insert: 'in:done ' },
];

/** aria-controls must name an element that exists: true until the mounted page shows the results listbox is absent. */
function useControlsRendered(id: string): boolean {
  const [rendered, setRendered] = useState(true);
  // After every commit, not on [id]: the results listbox may mount or unmount while the id stays the same. The
  // state only changes when the answer does, so this settles after one extra render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setRendered(document.getElementById(id) !== null);
  });
  return rendered;
}

/**
 * The Search page field at `heading` size in the PageHead row, with a 2 px accent underline while it has focus
 * (DESIGN §6 SearchField, §7.9, §11.2). Operators become tokens under it, or the fixed hint when there are none.
 * Return searches all mail on Google, and only Return does; ↓ and ↑ hand the keyboard to the results.
 * Single-key shortcuts never reach a text field, and nothing acts while an IME is composing.
 */
export function SearchField(props: SearchFieldProps) {
  const {
    value,
    onChange,
    tokens,
    onRemoveToken,
    onSubmit,
    scopeLabel,
    onScope,
    resultsId,
    onLeaveToList,
    inputRef,
  } = props;

  const controls = useControlsRendered(resultsId);
  const root = useRef<HTMLDivElement>(null);

  /** An operator in the hint goes into the field and the caret stays there, so the next thing typed is its value. */
  function insertOperator(text: string) {
    onChange(value + text);
    root.current?.querySelector('input')?.focus();
  }

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
    <div ref={root} className="ui-search-field" role="search">
      <label className="ui-search-field__title">
        <Icon name="search" />
        <input
          ref={inputRef}
          className="ui-search-field__input"
          type="text"
          role="combobox"
          aria-label="Search mail"
          aria-controls={controls ? resultsId : undefined}
          aria-expanded={controls}
          aria-autocomplete="list"
          placeholder="Search mail"
          autoComplete="off"
          spellCheck={false}
          dir="auto"
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <div className="ui-search-field__meta">
        <span className="ui-search-field__tokens">
          {tokens.length === 0 ? (
            // The hint belongs to an empty field: once there is text, the results are what matter.
            value.length === 0 ? (
              <span className="ui-search-field__hint" role="group" aria-label="Search operators">
                <span>Narrow with</span>
                {HINT_OPERATORS.map(({ label, insert }) => (
                  <Btn
                    key={label}
                    variant="text"
                    label={label}
                    hint={`Add ${label} to the search`}
                    onPress={() => insertOperator(insert)}
                  />
                ))}
              </span>
            ) : null
          ) : (
            tokens.map((token, index) => (
              <OperatorToken
                key={`${token.operator}:${token.value}:${index}`}
                operator={token.operator}
                value={token.value}
                onRemove={() => onRemoveToken(index)}
              />
            ))
          )}
        </span>
        {onScope ? (
          <Btn
            variant="text"
            label={scopeLabel}
            hint="Search scope"
            trailingIcon="chevron-down"
            onPress={onScope}
          />
        ) : (
          <span className="ui-search-field__scope">{scopeLabel}</span>
        )}
      </div>
    </div>
  );
}
