/**
 * Live availability for the palette's conditional rows (U7 acceptance 2 follow-up): an entry for a row that is not
 * drawn in the current state is not offered from ⌘K. `SettingsContainer` publishes its data while mounted; before
 * the first mount and after unmount every row stays offered, so availability only ever hides a row whose state was
 * actually seen. A deep link typed straight in still lands, on the row or on the quiet "not shown" line.
 */
import type { Account, AiProvider, Session } from '../../data';
import type { SettingSection } from '../../commands';
import { hasCapability, paidSwitch } from './settings.model';

/** What a row's availability reads: accounts (demo, missing permissions, lease), providers and the session. */
export interface AvailabilityData {
  readonly accounts: readonly Account[];
  readonly providers: readonly AiProvider[] | undefined;
  readonly session: Session | undefined;
}

let current: AvailabilityData | null = null;

/** Publishes the data conditional rows are drawn from; called whenever Settings' data changes. */
export function publishAvailability(data: AvailabilityData): void {
  current = data;
}

/** Drops the published data (Settings unmounted): every row is offered again. */
export function clearAvailability(): void {
  current = null;
}

const realAccount = (data: AvailabilityData) => data.accounts.some(a => !a.demo);

const hasProvider = (data: AvailabilityData, id: string): boolean =>
  data.providers === undefined || data.providers.some(p => p.id === id);

/** True when the row `section/anchor` is drawn with the published data (or none was published yet). */
export function rowAvailable(section: SettingSection, anchor: string): boolean {
  const data = current;
  if (!data) return true;
  switch (`${section}/${anchor}`) {
    case 'calendar/calendarPermission':
      return data.accounts.some(a => a.missingPermissions?.some(m => m.capability === 'calendar'));
    case 'accounts/accountAi':
    case 'accounts/accountColour':
      return realAccount(data);
    case 'accounts/lease':
      return data.accounts.some(
        a => !a.demo && (hasCapability(data.session, 'workflowSync') || a.lease !== undefined),
      );
    case 'notifications/perAccount':
      return hasCapability(data.session, 'notifications') && realAccount(data);
    case 'ai/geminiPaid':
      return data.providers === undefined || paidSwitch(data.providers) !== null;
    case 'help/demoLoad':
      return !data.accounts.some(a => a.demo);
    default:
      break;
  }
  if (section === 'ai' && anchor.startsWith('provider-')) {
    return hasProvider(data, anchor.slice('provider-'.length));
  }
  if (section === 'ai' && anchor.startsWith('server-')) {
    return hasProvider(data, anchor.slice('server-'.length));
  }
  return true;
}
