import { Fragment, useId } from 'react';
import type { InlineReplyProps } from '../props';
import { BlockedLine, ComposeFooter, ConflictBar, footerActions } from './ComposeParts';
import { Suggestion } from './Suggestion';

/**
 * The inline reply card under the message (`--elev-card`; the `settle` in and out is the motion runtime's, through
 * `ref`): the To line with Cc and Bcc, the text in `read`, then Send (⌘↩), the draft line, Esc closes, attach, Pop out and ⋯ (formatting lives in ⋯) (DESIGN §6
 * InlineReply, §7.6). While it is open it owns the filled button. The draft strip (`Suggestion`) is the card's sibling
 * right after it, hanging off its bottom edge, never inside it.
 */
export function InlineReply(props: InlineReplyProps) {
  const {
    recipients,
    onPopOut,
    editor,
    suggestion,
    draftState,
    onRetrySave,
    dictation,
    blocked,
    conflict,
    commands,
    ref,
  } = props;
  const blockedId = `${useId()}-blocked`;
  const blockedLine = blocked ? <BlockedLine id={blockedId} blocked={blocked} /> : null;

  return (
    <Fragment>
      <section
        ref={ref}
        className="ui-inline-reply"
        aria-label="Reply"
        data-blocked={blocked?.field}
      >
        <div className="ui-inline-reply__head">
          <div
            className="ui-inline-reply__to"
            data-blocked={blocked?.field === 'to' ? 'true' : undefined}
          >
            {recipients}
          </div>
        </div>
        {blocked?.field === 'to' ? blockedLine : null}
        <div className="ui-inline-reply__body">
          <div
            className="ui-inline-reply__editor"
            data-blocked={blocked && blocked.field !== 'to' ? 'true' : undefined}
            data-dictating={dictation ? 'true' : undefined}
          >
            {editor}
          </div>
          {blocked && blocked.field !== 'to' ? blockedLine : null}
          {conflict ? <ConflictBar conflict={conflict} /> : null}
        </div>
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
            onMore: props.onMore,
            onPopOut,
          })}
        />
      </section>
      {suggestion ? <Suggestion {...suggestion} /> : null}
    </Fragment>
  );
}
