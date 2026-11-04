// ReplyStub (DESIGN §6, §7.5 item 5). Mockups: reader.html, errors.html.
// The quiet "Reply to Jordan…" field at the end of the thread with its R keycap always shown.

import type { ReplyStubProps } from '../props';
import { Keycap } from '../list/internal/Action';
import { Icon } from '../list/internal/Icon';
import { keycapFor, tooltipText } from '../list/internal/keys';

/** The dictation hint every reply tooltip carries. */
export const HOLD_R = 'Hold R to dictate a reply';

/** Opens the inline reply. */
export function ReplyStub({ recipientName, commandId, onOpen }: ReplyStubProps) {
  const text = `Reply to ${recipientName}…`;
  return (
    <button
      type="button"
      className="ui-reply-stub"
      title={`${tooltipText('Reply', commandId)}. ${HOLD_R}`}
      onClick={onOpen}
    >
      <Icon name="reply" />
      <span className="ui-reply-stub__text">{text}</span>
      <Keycap chord={keycapFor(commandId)} />
    </button>
  );
}
