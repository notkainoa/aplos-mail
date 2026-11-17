/**
 * The head of a message you just sent, drawn the way a received message's card draws its own: the sender's mark, the
 * name, the time inline, then who it went to as the "to" line (without the chevron: a sent line has no details to open).
 * Both the send status and the pending-sent notes use it, so a sent card and a received card read as one anatomy.
 */
import type { ComposeFields } from '../model/fields';
import { safeDisplayName } from '../model/recipients';

/** "to Jordan Lee, mina@example.com"; a name that contains "@" gives way to the real address. */
export function toLabelOf(fields: ComposeFields): string {
  const names = [...fields.to, ...fields.cc].map(safeDisplayName);
  return names.length > 0 ? `to ${names.join(', ')}` : 'No recipient';
}

/** The calm square before "You", the same one `SenderMark` draws for a received message. */
export function SentMark() {
  return <span className="aplos-sender-mark" aria-hidden="true" data-mark="Y" />;
}

/** "to Jordan Lee, mina@example.com" in the recipients line's type, with no button around it. */
export function SentRecipients({ fields }: { readonly fields: ComposeFields }) {
  return (
    <span className="aplos-recipients" data-static="true">
      <span className="aplos-recipients__to">
        <span className="aplos-recipients__names">{toLabelOf(fields)}</span>
      </span>
    </span>
  );
}
