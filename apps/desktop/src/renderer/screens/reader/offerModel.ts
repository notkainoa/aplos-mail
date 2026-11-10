/**
 * The reader's quiet "Add to calendar" offer for an event found in the email (DESIGN 7.5, 9): which plans the thread
 * carries, whether to show them at all, and the words. The offer reads the plans the engine already found (background
 * jobs or Ask); it never asks a model, never writes to the calendar and never invents one. Pure: the screen reads the
 * `Plan` rows and draws `EventOffer`.
 */
import { toIsoDateTime, type Account, type Plan } from '../../data';
import { dayOf } from '../../ui/calendar/dates';
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

function startIso(plan: Pick<Plan, 'start'>): string {
  const t = plan.start;
  if (t.type === 'utc') return toIsoDateTime(t.utc);
  if (t.type === 'date') return `${t.date}T00:00:00`;
  return t.local;
}

export function offerOf(plan: Plan, subject: string): OfferView {
  const place = plan.location?.trim();
  return {
    planId: plan.id,
    title: plan.title.trim() || subject,
    when: inviteWhen(plan),
    ...(place ? { place } : {}),
    date: dayOf(startIso(plan)),
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
    .sort((a, b) => startIso(a).localeCompare(startIso(b)))
    .slice(0, MAX_OFFERS)
    .map(p => offerOf(p, subject));
}
