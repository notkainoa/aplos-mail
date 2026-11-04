/**
 * The body editor the composer family leaves to this lane (ComposerProps.editor, InlineReplyProps.editor): plain text
 * in `read`, growing with its content, with any dim suggested text drawn at the end of the typed text (DESIGN 7.6 "AI
 * draft is dim suggestion text at the caret", 9 rule 6). The suggestion lives in a mirror behind a transparent-backed
 * textarea, so it is never part of the value: Tab keeps it (`compose.keepSuggestion`), Esc or typing drops it. Keys go
 * through the registry; the editor binds none of its own. It is the one field a held Space dictates into
 * (`data-dictation="body"`, read by the shell's key listener); To and Subject type spaces.
 */
import type { Ref } from 'react';

export interface BodyEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Dim suggested text after the typed text, in the serif (words Aplos wrote). */
  readonly suggestion?: string;
  /** Accessible name, e.g. "Reply" or "Message". */
  readonly label: string;
  /** DOM id of the hint line that explains the suggestion, when one shows. */
  readonly describedBy?: string;
  readonly autoFocus?: boolean;
  readonly editorRef?: Ref<HTMLTextAreaElement>;
}

/** The empty text's placeholder (owner review 2026-11-03); an offered draft takes its place. */
const BODY_PLACEHOLDER = 'Write something…';

export function BodyEditor({
  value,
  onChange,
  suggestion,
  label,
  describedBy,
  autoFocus,
  editorRef,
}: BodyEditorProps) {
  return (
    <div className="aplos-compose-editor" data-suggesting={suggestion ? 'true' : undefined}>
      <div className="aplos-compose-editor__mirror" aria-hidden="true">
        <span className="aplos-compose-editor__typed">{value}</span>
        {suggestion ? <span className="aplos-compose-editor__suggestion">{suggestion}</span> : null}
        {/* Keeps a trailing newline's line box, so the textarea and the mirror stay the same height. */}
        <span className="aplos-compose-editor__end"> </span>
      </div>
      <textarea
        ref={editorRef}
        className="aplos-compose-editor__input"
        data-dictation="body"
        aria-label={label}
        aria-describedby={describedBy}
        dir="auto"
        spellCheck
        placeholder={suggestion ? undefined : BODY_PLACEHOLDER}
        autoFocus={autoFocus}
        value={value}
        onChange={event => onChange(event.target.value)}
      />
    </div>
  );
}
