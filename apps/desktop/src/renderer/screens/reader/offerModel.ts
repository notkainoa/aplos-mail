/**
 * The reader's quiet "Add to calendar" offer for an event found in the email (DESIGN 7.5, 9): which plans the thread
 * carries, whether to show them at all, and the words. The offer reads the plans the engine already found (background
 * jobs or Ask); it never asks a model, never writes to the calendar and never invents one. Pure: the screen reads the
 * `Plan` rows and draws `EventOffer`.
 */
import type { Account, Plan } from '../../data';
import { dayOf } from '../../ui/calendar/dates';
import { isoOfTime, msOf } from '../calendar/model/period';
import { inviteWhen } from './invite';

/** What one offer says. */
export interface OfferView {
  readonly planId: string;
  readonly title: string;
  /** "Thursday, November 12 · 3:00 – 4:00 PM", in the calendar's own wording. */
  readonly when: string;
  readonly place?: string;
  /** The plan's first day, local, `YYYY-MM-DD`: where the calendar opens. */
  readonly date: string;
}

/** At most this many offers show under one summary; the rest stay in the calendar's "From mail" entries. */
export const MAX_OFFERS = 2;

type PlanTime = Plan['start'];

/**
 * A plan time as the calendar draws it: a zoned floating time becomes the machine's own moment, so the offer names the
 * same day and hour as the grid entry the button opens (a plan with its own time zone differs from the machine's).
 */
function drawn(t: PlanTime): PlanTime {
  return t.type === 'date' ? t : { type: 'utc', utc: msOf(t) };
}

export function offerOf(plan: Plan, subject: string): OfferView {
  const place = plan.location?.trim();
  return {
    planId: plan.id,
    title: plan.title.trim() || subject,
    when: inviteWhen({ start: drawn(plan.start), end: drawn(plan.end), allDay: plan.allDay }),
    ...(place ? { place } : {}),
    date: dayOf(isoOfTime(plan.start)),
  };
}

/**
 * Whether the thread shows offers: not for an account left out of AI (a plan found before it was turned off stays
 * hidden, and nothing says why: absence is quiet), and not while the invitation card already shows the event.
 */
export function offersShown(
  account: Pick<Account, 'aiAllowed'> | undefined,
  hasInvite: boolean,
): boolean {
  return account !== undefined && account.aiAllowed && !hasInvite;
}

/** The plans still open, soonest first, as offers; confirmed and dismissed ones are not offered. */
export function offersOf(plans: readonly Plan[], subject: string): readonly OfferView[] {
  return plans
    .filter(p => p.state === 'open')
    .sort((a, b) => msOf(a.start) - msOf(b.start))
    .slice(0, MAX_OFFERS)
    .map(p => offerOf(p, subject));
}
