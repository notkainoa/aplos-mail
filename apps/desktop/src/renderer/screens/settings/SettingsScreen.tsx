/**
 * The Settings screen (DESIGN 7.10): a 180 px nav and a 600 px column, no page title. The nav is a `Puck` aligned
 * with the first group; groups are 32 px apart; rows are 40 px, or 48 px with a one-line description. This file is
 * presentational: data, view state, actions and the shell host come in as props, so every state can be drawn from
 * fixtures. The container (`SettingsContainer.tsx`) reads the hooks and the ports.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { SETTING_SECTIONS, type SettingSection } from '../../commands';
import { ErrorLine } from '../../ui/list';
import { Puck } from '../../ui/surfaces';
import { Overlays } from './overlays';
import { navItems } from './settings.model';
import type { WriteFailure } from './ports';
import { Accounts } from './sections/accounts';
import { Ai } from './sections/ai';
import { Calendar } from './sections/calendar';
import { General } from './sections/general';
import { Help } from './sections/help';
import { Keyboard } from './sections/keyboard';
import { Mail } from './sections/mail';
import { Notifications } from './sections/notifications';
import type { SectionProps } from './sections/types';

export interface SettingsScreenProps extends SectionProps {
  readonly section: SettingSection;
  onSection(section: SettingSection): void;
  /** The row ⌘K or a deep link chose: scrolled into view, its control focused. */
  readonly anchor?: string;
  /** A rejected write: one inline line with Retry; the control is already back at its old value. */
  readonly failure?: WriteFailure | null;
}

const SECTION_VIEWS: Record<SettingSection, (props: SectionProps) => ReactNode> = {
  general: General,
  mail: Mail,
  calendar: Calendar,
  ai: Ai,
  notifications: Notifications,
  accounts: Accounts,
  keyboard: Keyboard,
  help: Help,
};

const FOCUSABLE =
  'button:not([disabled]), input, select, textarea, [role="switch"], [tabindex="0"]';

export function SettingsScreen({
  section,
  onSection,
  anchor,
  failure,
  ...rest
}: SettingsScreenProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const View = SECTION_VIEWS[section];
  const recordingId = rest.view.recording?.commandId;
  const label = SETTING_SECTIONS.find(s => s.id === section)?.label ?? 'Settings';

  // A deep link lands on its row; a plain section switch starts at the top. Navigation is instant (no transition).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // A row being recorded is where the eyes are; otherwise the row the link named.
    const recording = recordingId
      ? el.querySelector<HTMLElement>(`[data-command="${CSS.escape(recordingId)}"]`)
      : null;
    const target =
      recording ??
      (anchor
        ? el.querySelector<HTMLElement>(`[data-setting-anchor="${CSS.escape(anchor)}"]`)
        : null);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      if (!recording) target.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
    } else {
      (el.closest('.ui-pane__body') ?? document.scrollingElement)?.scrollTo?.(0, 0);
    }
  }, [section, anchor, recordingId]);

  return (
    <div className="settings-screen" ref={root} data-section={section}>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <Puck
            kind="selection"
            role="navigation"
            label="Settings sections"
            items={navItems()}
            selectedId={section}
            onSelect={id => onSection(id as SettingSection)}
          />
        </nav>
        <div className="settings-content" role="region" aria-label={label}>
          {failure ? (
            <ErrorLine
              kind="writeRejected"
              op={failure.op}
              placement="settings"
              onAction={action => (action === 'retry' ? failure.retry() : failure.dismiss())}
            />
          ) : null}
          <View {...rest} />
        </div>
      </div>
      <Overlays {...rest} />
    </div>
  );
}
