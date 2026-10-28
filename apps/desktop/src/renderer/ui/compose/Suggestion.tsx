import type { SuggestionProps } from '../props';
import { Kbd } from './parts';

const LEAD = {
  draft: 'The grey sentence is a suggestion.',
  followUp: 'Aplos drafted this follow-up from your last email.',
} as const;

/**
 * The hint line under the body while the editor holds dim suggested text (DESIGN §6 Suggestion, §7.6, §9 rule 6).
 * The dim text itself is editor data. Tab and Esc are bound by the registry (`compose.keepSuggestion` and
 * `compose.dismissSuggestion`) while the editor has focus; the two buttons here are the pointer path.
 */
export function Suggestion({ kind, onKeep, onDismiss }: SuggestionProps) {
  return (
    <p className="ui-suggestion" role="status" data-kind={kind}>
      <span>{LEAD[kind]}</span>
      <button type="button" className="ui-suggestion__act" tabIndex={-1} onClick={onKeep}>
        <Kbd>Tab</Kbd>
        keep
      </button>
      <button type="button" className="ui-suggestion__act" tabIndex={-1} onClick={onDismiss}>
        <Kbd>Esc</Kbd>
        dismiss
      </button>
    </p>
  );
}
