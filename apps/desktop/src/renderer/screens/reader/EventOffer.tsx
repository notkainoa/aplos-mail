/**
 * "Add to calendar" for an event found in the email: a quiet block under the summary with the title, when and place
 * (original words from the plan, never AI-marked), and one text button. The button opens the Calendar on that plan,
 * where the existing flow confirms it; nothing is added here and nothing is added without that confirmation.
 */
import { useId } from 'react';
import { useAccounts, useView, type ThreadRow } from '../../data';
import { openCalendarOnPlan } from '../../shell';
import { Button } from '../../ui/buttons-keys';
import { Text } from '../../ui/surfaces';
import { offersOf, offersShown, type OfferView } from './offerModel';

/** One offer: the words and the button; what the button does is the caller's. */
export function EventOfferCard({
  offer,
  onAdd,
}: {
  readonly offer: OfferView;
  readonly onAdd: () => void;
}) {
  const titleId = useId();
  return (
    <section className="aplos-reader__offer" aria-labelledby={titleId}>
      <div className="aplos-reader__offer-text">
        <Text variant="label" tone="ink" as="h3" id={titleId}>
          {offer.title}
        </Text>
        <Text variant="small" tone="ink-2" icon="clock">
          {offer.when}
        </Text>
        {offer.place ? (
          <Text variant="small" tone="ink-2" icon="pin">
            {offer.place}
          </Text>
        ) : null}
      </div>
      <Button variant="text" label="Add to calendar" onPress={onAdd} />
    </section>
  );
}

/** The offers for one thread; nothing at all when there are none or the account is left out of AI. */
export function EventOffers({
  row,
  hasInvite,
}: {
  readonly row: Pick<ThreadRow, 'id' | 'accountId' | 'subject'>;
  readonly hasInvite: boolean;
}) {
  const accounts = useAccounts();
  const plans = useView({ kind: 'plans', threadId: row.id });
  if (
    !offersShown(
      accounts.find(a => a.id === row.accountId),
      hasInvite,
    )
  )
    return null;
  const found = plans.ids.flatMap(id => plans.rows.get(id) ?? []);
  const offers = offersOf(found, row.subject);
  if (offers.length === 0) return null;
  return (
    <div className="aplos-reader__offers">
      {offers.map(o => (
        <EventOfferCard
          key={o.planId}
          offer={o}
          onAdd={() => openCalendarOnPlan({ planId: o.planId, date: o.date })}
        />
      ))}
    </div>
  );
}
