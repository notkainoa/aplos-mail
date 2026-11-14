import { useId } from 'react';
import type { ComposerProps } from '../props';
import { BlockedLine, ComposeFooter, ConflictBar, footerActions } from './ComposeParts';
import { Icon } from './icons';
import { Btn } from './parts';
import { Suggestion } from './Suggestion';

/**
 * New message as a page in the pane, 640 px, non-modal (DESIGN §6 Composer, §7.6): To row, the subject as a
 * `heading`-size field, the body in `read`, then a footer under a hairline, inside the card, with Send, the draft line, Esc closes, attach and Formatting (⋯ is in the pane header). The pane header (close, "New message", ⋯, Ask) belongs to the screen. The body is an editor the reader lane
 * owns; AI drafts and follow-up nudges are dim text the editor itself renders, announced by `suggestion`.
 */
export function Composer(props: ComposerProps) {
  const {
    recipients,
    subject,
    onSubjectChange,
    editor,
    suggestion,
    dictation,
    polish,
    draftState,
    onRetrySave,
    blocked,
    conflict,
    commands,
  } = props;
  const blockedId = `${useId()}-blocked`;
  const blockedLine = blocked ? <BlockedLine id={blockedId} blocked={blocked} /> : null;
  const outlined = (field: 'to' | 'subject' | 'body') =>
    blocked?.field === field ? 'true' : undefined;

  return (
    <section className="ui-composer" aria-label="New message">
      <div className="ui-composer__scroll">
        <div className="ui-composer__page">
          <div className="ui-composer__to" data-blocked={outlined('to')}>
            {recipients}
          </div>
          {blocked?.field === 'to' ? blockedLine : null}
          <input
            className="ui-composer__subject"
            type="text"
            dir="auto"
            aria-label="Subject"
            placeholder="Subject"
            value={subject}
            data-blocked={outlined('subject')}
            aria-invalid={blocked?.field === 'subject' ? true : undefined}
            aria-describedby={blocked?.field === 'subject' ? blockedId : undefined}
            onChange={event => onSubjectChange(event.target.value)}
          />
          {blocked?.field === 'subject' ? blockedLine : null}
          {polish ? (
            <div className="ui-composer__polish" role="group" aria-label="Polish">
              <Icon name="type" size="sm" />
              <span>{`Polish suggests ${polish.changes} ${polish.changes === 1 ? 'change' : 'changes'}. Yours stays until you choose.`}</span>
              <span className="ui-composer__polish-acts">
                <Btn
                  variant="text"
                  label="Use these"
                  keys="Return"
                  keyHint="always"
                  onPress={polish.onUse}
                />
                <Btn
                  variant="text"
                  label="Keep mine"
                  keys="Esc"
                  keyHint="always"
                  onPress={polish.onKeep}
                />
              </span>
            </div>
          ) : null}
          <div
            className="ui-composer__editor"
            data-blocked={outlined('body')}
            data-dictating={dictation ? 'true' : undefined}
          >
            {editor}
          </div>
          {blocked?.field === 'body' ? blockedLine : null}
          {conflict ? <ConflictBar conflict={conflict} /> : null}
          <footer className="ui-composer__foot">
            <ComposeFooter
              commands={commands}
              draftState={draftState}
              onRetrySave={onRetrySave}
              dictation={dictation}
              onSend={props.onSend}
              closeHint
              trailing={footerActions({
                commands,
                onAttach: props.onAttach,
                onFormat: props.onFormat,
              })}
            />
          </footer>
        </div>
        {suggestion ? <Suggestion {...suggestion} /> : null}
      </div>
    </section>
  );
}
