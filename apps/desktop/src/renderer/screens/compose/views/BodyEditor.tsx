/**
 * The body editor the composer family leaves to this lane (ComposerProps.editor, InlineReplyProps.editor): plain text
 * in `read`, growing with its content, with any dim suggested text drawn at the end of the typed text (DESIGN 7.6 "AI
 * draft is dim suggestion text at the caret", 9 rule 6). The suggestion lives in a mirror behind a transparent-backed
 * textarea, so it is never part of the value: Tab keeps it (`compose.keepSuggestion`), Esc or typing drops it. Keys go
 * through the registry; the editor binds none of its own. It is the one field a held Space dictates into
 * (`data-dictation="body"`, read by the shell's key listener); To and Subject type spaces.
 */
import type { Ref } from 'react';
import { joinForward, splitForward } from '../model/forwardSeed';

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
/** A forward's note area: the original is already below it. */
const NOTE_PLACEHOLDER = 'Add a note…';

/** The forwarded original: a quiet region in the reader's quote style, still editable like any text. */
function QuoteEditor({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="aplos-compose-quote">
      <div className="aplos-compose-editor__mirror" aria-hidden="true">
        {value}
        <span className="aplos-compose-editor__end"> </span>
      </div>
      <textarea
        className="aplos-compose-editor__input"
        aria-label="Forwarded message"
        dir="auto"
        spellCheck
        value={value}
        onChange={event => onChange(event.target.value)}
      />
    </div>
  );
}

/** The note area, then (on a forward) the quoted original under one blank line; the stored body stays one text. */
export function BodyEditor(props: BodyEditorProps) {
  const { note, quote } = splitForward(props.value);
  if (quote === '') return <NoteEditor {...props} />;
  return (
    <div className="aplos-compose-body">
      <NoteEditor
        {...props}
        value={note}
        placeholder={NOTE_PLACEHOLDER}
        onChange={next => props.onChange(joinForward(next, quote))}
      />
      <QuoteEditor value={quote} onChange={next => props.onChange(joinForward(note, next))} />
    </div>
  );
}

function NoteEditor({
  value,
  onChange,
  suggestion,
  label,
  describedBy,
  autoFocus,
  editorRef,
  placeholder = BODY_PLACEHOLDER,
}: BodyEditorProps & { readonly placeholder?: string }) {
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
        placeholder={suggestion ? undefined : placeholder}
        autoFocus={autoFocus}
        value={value}
        onChange={event => onChange(event.target.value)}
      />
    </div>
  );
}
