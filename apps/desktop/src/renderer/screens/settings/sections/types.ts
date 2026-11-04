import type { SettingsController } from '../controller';
import type { SettingsData, SettingsHost } from '../ports';
import type { SettingsView } from '../view';

/** What every section is given: the data, Settings' own view state, the actions and the shell host. */
export interface SectionProps {
  readonly data: SettingsData;
  readonly view: SettingsView;
  readonly actions: SettingsController;
  readonly host: SettingsHost;
}
