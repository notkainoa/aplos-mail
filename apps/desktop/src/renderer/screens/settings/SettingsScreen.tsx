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
import { focusRowId, focusRowTarget } from './rowFocus';
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

/**
 * The identity signal that re-runs a deep link's row resolution: a conditional row can appear after the
 * link landed (providers still loading, an account's AI switch flipped by a bulk write), so the list of
 * real accounts keeping their mail out of AI is part of it, not just who is connected.
 */
export function screenDataVersion(
  data: Pick<SectionProps['data'], 'providers' | 'accounts' | 'queue'>,
): string {
  return [
    data.providers ? data.providers.map(p => p.id).join(',') : 'pending',
    data.accounts.map(a => a.id).join(','),
    data.accounts
      .filter(a => !a.demo && !a.aiAllowed)
      .map(a => a.id)
      .join(','),
    data.queue ? data.queue.map(q => q.id).join(',') : 'pending',
  ].join('|');
}

/** What the pane does when no row wants focus: reset for a section change, keep its place otherwise. */
export function scrollWithoutTarget(
  previous: SettingSection | null,
  next: SettingSection,
): 'top' | 'stay' {
  return previous === next ? 'stay' : 'top';
}

/**
 * What the deep-link effect may move, and when it may move it: a fresh section/anchor navigation, the moment a
 * conditional row is drawn (`wasMissing`), or a recording starting on a different row. A `recordingId` change on
 * its own never re-runs the anchor's scroll and focus, so finishing a recording does not jump the tall
 * 'shortcuts' anchor mid-list or steal the recorder's restored focus. Once the row has been drawn on this visit
 * the link is 'consumed' and spent: a redraw or a vanish (a write that empties a conditional row under the
 * owner's finger) never scrolls or focuses it again.
 */
export function anchorScroll(input: {
  /** A KeyRecorder row is recording a chord. */
  readonly recording: boolean;
  /** The recorded command changed since the last run. */
  readonly recordingChanged: boolean;
  /** The deep-linked row is drawn right now. */
  readonly linked: boolean;
  /** The deep-linked row was not drawn on the last run. */
  readonly wasMissing: boolean;
  /** The section or the anchor changed since the last run. */
  readonly freshNav: boolean;
  /** The row already drew once on this visit: the link is spent. */
  readonly consumed: boolean;
}): 'recording' | 'linked' | 'top' | 'none' {
  if (input.recording) return input.recordingChanged ? 'recording' : 'none';
  if (input.consumed && !input.freshNav) return 'none';
  if (input.linked) return input.freshNav || input.wasMissing ? 'linked' : 'none';
  return input.freshNav ? 'top' : 'none';
}

/**
 * Whether the "not shown in this state" line is up for a deep link: only while its row has never been drawn on
 * this visit. A drawn-then-vanished row is a spent link, not a miss — a write that empties the row under the
 * owner's finger must not read as "not shown".
 */
export function anchorMissing(input: {
  /** The link names a row and no recording took over. */
  readonly looking: boolean;
  /** The deep-linked row is drawn right now. */
  readonly linked: boolean;
  /** The row already drew once on this visit: the link is spent. */
  readonly consumed: boolean;
}): boolean {
  return input.looking && !input.linked && !input.consumed;
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
  const [missingAnchor, setMissingAnchor] = useState<string | null>(null);
  const previous = useRef<{
    section: SettingSection | null;
    anchor: string | undefined;
    recordingId: string | undefined;
    missing: string | null;
    /** The linked row has been drawn on this visit: the link is spent. */
    consumed: boolean;
  }>({
    section: null,
    anchor: undefined,
    recordingId: undefined,
    missing: null,
    consumed: false,
  });

  // A conditional row can appear after the link landed (providers still loading, an AI-off account turned
  // on): this cheap identity signal re-runs the resolution so the row is scrolled to and focused once drawn.
  const { data } = rest;
  const dataVersion = screenDataVersion(data);

  // DESIGN 11.2: focus is never lost on commit. A row's control can leave the DOM while it holds focus —
  // Calendar → Accounts' "Enable editing" unmounts once the account flips to "Editing on" — and the
  // browser drops focus on the page. Remember the row the focused control sat in, so the commit below
  // can hand its focus to that row instead. Focus is tracked by events, not commits: the sheet's own
  // restore can land between two of them.
  const lastFocus = useRef<{ rowId: string | null; el: Element } | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const active = document.activeElement;
    if (active && el.contains(active))
      lastFocus.current = { rowId: focusRowId(active), el: active };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element)
        lastFocus.current = { rowId: focusRowId(event.target), el: event.target };
    };
    const onFocusOut = (event: FocusEvent) => {
      // Focus went to a real element outside the screen, or to the page while its control still
      // stood: the row is owed nothing. A control leaving the DOM fires this inside the detached
      // subtree, which never reaches the screen, so the record survives for the check below.
      const next = event.relatedTarget;
      if (next instanceof Node || (event.target as Element).isConnected) lastFocus.current = null;
    };
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    return () => {
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // After a commit that took the focused control away — an accounts update flipping an editing row —
  // focus sits on the page: give it to the row the control lived in. Never while focus is held
  // elsewhere or on a control that still stands.
  useEffect(() => {
    const el = root.current;
    const lost = lastFocus.current;
    if (!el || !lost?.rowId || lost.el.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    focusRowTarget(lost.rowId, el)?.focus({ preventScroll: true });
  });

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
    const p = previous.current;
    const freshNav = p.section !== section || p.anchor !== anchor;
    // The link is spent once its row has been drawn on this visit: a later vanish (a write that empties the
    // row) is not a miss, and a redraw never scrolls or focuses it again. A new section, a new anchor or a
    // remount on a re-opened link starts a fresh visit.
    const consumed = !freshNav && p.consumed;
    // A conditional row may not be drawn in this state: say so rather than landing silently at the top.
    const missing = anchorMissing({
      looking: Boolean(anchor) && !recording,
      linked: linked !== null,
      consumed,
    })
      ? (anchor ?? null)
      : null;
    setMissingAnchor(missing);
    const move = anchorScroll({
      recording: recording !== null,
      recordingChanged: p.recordingId !== recordingId,
      linked: linked !== null,
      wasMissing: p.missing === anchor,
      freshNav,
      consumed,
    });
    if (move === 'recording' && recording) {
      recording.scrollIntoView({ block: 'nearest' });
    } else if (move === 'linked' && linked) {
      // 'start', not 'center': a tall anchor (every shortcut group) must not land mid-list.
      linked.scrollIntoView({ block: 'start' });
      const control = linked.querySelector<HTMLElement>(FOCUSABLE);
      if (control) control.focus({ preventScroll: true });
      else {
        if (!linked.hasAttribute('tabindex')) linked.setAttribute('tabindex', '-1');
        linked.focus({ preventScroll: true });
      }
    } else if (move === 'top') {
      (el.closest('.ui-pane__body') ?? document.scrollingElement)?.scrollTo?.(0, 0);
    }
    previous.current = {
      section,
      anchor,
      recordingId,
      missing,
      consumed: consumed || linked !== null,
    };
  }, [section, anchor, recordingId, dataVersion]);

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
      {failure && !rest.view.diagnostics && !rest.view.addTool ? (
        <div className="settings-failure-row">
          <FailureLine failure={failure} />
        </div>
      ) : null}
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
          {missingAnchor ? <MissingAnchor section={section} anchor={missingAnchor} /> : null}
          <View {...rest} />
        </div>
      </div>
      <Overlays {...rest} failure={failure} />
    </div>
  );
}
