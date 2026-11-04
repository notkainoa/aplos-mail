/**
 * The Settings screen (DESIGN 7.10): a 180 px nav and a 600 px column, no page title. The nav is a `Puck` aligned
 * with the first group; groups are 32 px apart; rows are 40 px, or 48 px with a one-line description. This file is
 * presentational: data, view state, actions and the shell host come in as props, so every state can be drawn from
 * fixtures. The container (`SettingsContainer.tsx`) reads the hooks and the ports.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SETTING_SECTIONS, type SettingSection } from '../../commands';
import { Puck } from '../../ui/surfaces';
import { Overlays } from './overlays';
import { FailureLine, MissingAnchor } from './parts';
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
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), ' +
  '[role="switch"]:not([disabled]):not([aria-disabled="true"]), [tabindex="0"]';

/** What the pane does when no row wants focus: reset for a section change, keep its place otherwise. */
export function scrollWithoutTarget(
  previous: SettingSection | null,
  next: SettingSection,
): 'top' | 'stay' {
  return previous === next ? 'stay' : 'top';
}

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
  const previousSection = useRef<SettingSection | null>(null);
  const [missingAnchor, setMissingAnchor] = useState<string | null>(null);

  // A deep link lands on its row; a plain section switch starts at the top. Anything else keeps its place.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // A row being recorded is where the eyes are; otherwise the row the link named.
    const recording = recordingId
      ? el.querySelector<HTMLElement>(`[data-command="${CSS.escape(recordingId)}"]`)
      : null;
    const linked =
      !recording && anchor
        ? el.querySelector<HTMLElement>(`[data-setting-anchor="${CSS.escape(anchor)}"]`)
        : null;
    const target = recording ?? linked;
    // A conditional row may not be drawn in this state: say so rather than landing silently at the top.
    setMissingAnchor(!recording && anchor && !linked ? anchor : null);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      if (!recording) {
        const control = target.querySelector<HTMLElement>(FOCUSABLE);
        if (control) control.focus({ preventScroll: true });
        else {
          if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
          target.focus({ preventScroll: true });
        }
      }
    } else if (scrollWithoutTarget(previousSection.current, section) === 'top') {
      (el.closest('.ui-pane__body') ?? document.scrollingElement)?.scrollTo?.(0, 0);
    }
    previousSection.current = section;
  }, [section, anchor, recordingId]);

  // Arrow keys rove the nav (a navigation Puck keeps Tab order but does not rove on its own).
  const onNavKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-puck-id] button')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    let next = -1;
    if (event.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    if (items.length === 0) return;
    event.preventDefault();
    items[next]?.focus();
    items[next]?.click();
  };

  return (
    <div className="settings-screen" ref={root} data-section={section}>
      <div className="settings-layout">
        <div className="settings-nav" onKeyDown={onNavKeyDown}>
          <Puck
            kind="selection"
            role="navigation"
            label="Settings sections"
            items={navItems()}
            selectedId={section}
            onSelect={id => onSection(id as SettingSection)}
          />
        </div>
        <div className="settings-content" role="region" aria-label={label}>
          {failure && !rest.view.diagnostics ? <FailureLine failure={failure} /> : null}
          {missingAnchor ? <MissingAnchor section={section} anchor={missingAnchor} /> : null}
          <View {...rest} />
        </div>
      </div>
      <Overlays {...rest} failure={failure} />
    </div>
  );
}
