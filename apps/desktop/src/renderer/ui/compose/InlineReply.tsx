import { Fragment, useId } from 'react';
import type { InlineReplyProps } from '../props';
import { BlockedLine, ComposeFooter, ConflictBar } from './ComposeParts';
import { Btn } from './parts';
import { Suggestion } from './Suggestion';

/**
 * The inline reply card under the message (`--elev-card`; the `settle` in and out is the motion runtime's, through
 * `ref`): the To line with Cc and Pop out, the text in `read`, then Send (⌘↩), the draft line, attach and ⋯ (DESIGN §6
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
          <Btn
            variant="icon"
            icon="pop-out"
            label="Pop out reply"
            hint="Pop out reply"
            commandId="compose.popOut"
            onPress={() => onPopOut()}
          />
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
          trailing={[
            {
              label: 'Attach',
              icon: 'paperclip',
              hint: 'Attach a file',
              commandId: commands.attach,
              onPress: () => props.onAttach(),
            },
            {
              label: 'More',
              icon: 'more',
              hint: 'More: format, schedule, discard',
              commandId: commands.more,
              onPress: props.onMore,
            },
          ]}
        />
      </section>
      {suggestion ? <Suggestion {...suggestion} /> : null}
    </Fragment>
  );
}
