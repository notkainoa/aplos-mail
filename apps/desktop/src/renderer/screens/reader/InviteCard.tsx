/**
 * The invitation inside an invite email's message (DESIGN 7.5, 7.8): "Invite from Noor", the event's title, then the
 * when line, the place, the meeting link and the other guests, each behind its icon. A quiet --raised block in the
 * message, above the email's own body; it has no buttons (the action row owns "Add to calendar", the calendar owns
 * the reply). Built from `Text` only; reader.css places it.
 */
import { useId } from 'react';
import { Text } from '../../ui/surfaces';
import type { InviteView } from './invite';

export function InviteCard({ invite }: { readonly invite: InviteView }) {
  const titleId = useId();
  return (
    <section className="aplos-reader__invite" aria-labelledby={titleId}>
      {invite.from ? <Text variant="small">{invite.from}</Text> : null}
      <Text variant="title" as="h3" id={titleId}>
        {invite.title}
      </Text>
      <div className="aplos-reader__invite-rows">
        <Text variant="lede" tone="ink-2" icon="clock">
          {invite.when}
        </Text>
        {invite.place ? (
          <Text variant="lede" tone="ink-2" icon="pin">
            {invite.place}
          </Text>
        ) : null}
        {invite.video ? (
          <Text variant="lede" tone="ink-2" icon="video">
            {invite.video}
          </Text>
        ) : null}
        {invite.guests ? (
          <Text variant="lede" tone="ink-2" icon="users">
            {invite.guests}
          </Text>
        ) : null}
      </div>
    </section>
  );
}
