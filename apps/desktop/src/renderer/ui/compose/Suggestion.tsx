import type { SuggestionProps } from '../props';
import { Kbd } from './parts';

const LEAD = {
  draft: 'The gray sentence is a suggestion.',
  followUp: 'Aplos drafted this follow-up from your last email.',
} as const;

/**
 * The draft strip (DESIGN §6 Suggestion, §7.6, §9 rule 6; owner review 2026-11-03): a separate card that hangs off the
 * bottom of the reply card (a sibling of it, never inside it) while the editor holds dim suggested text. The dim text
 * itself is editor data. Tab and Esc are bound by the registry (`compose.keepSuggestion` and
 * `compose.dismissSuggestion`) while the editor has focus; the two buttons here are the pointer path and show the same
 * keys. They never take focus from the editor (mousedown is not a focus move), so typing carries on.
 */
export function Suggestion({ kind, onKeep, onDismiss }: SuggestionProps) {
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  return (
    <div className="ui-suggestion" role="status" data-kind={kind}>
      <span className="ui-suggestion__lead">{LEAD[kind]}</span>
      <span className="ui-suggestion__acts">
        <button
          type="button"
          className="ui-suggestion__act"
          tabIndex={-1}
          onMouseDown={keepFocus}
          onClick={onKeep}
        >
          Keep
          <Kbd>Tab</Kbd>
        </button>
        <button
          type="button"
          className="ui-suggestion__act"
          tabIndex={-1}
          onMouseDown={keepFocus}
          onClick={onDismiss}
        >
          Dismiss
          <Kbd>Esc</Kbd>
        </button>
      </span>
    </div>
  );
}
