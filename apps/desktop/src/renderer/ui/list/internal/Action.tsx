// A plain button in the three idioms (filled, text, icon) plus an inline keycap, private to the list and
// reader families. It mirrors ButtonProps closely so it can be swapped for buttons-keys' Button + Kbd +
// Tooltip once they land. The tooltip is the native `title` for now (label plus key from the registry).

import { createContext, useContext, type MouseEvent } from 'react';
import type { IconName, KeyHint } from '../../props';
import { displayChord } from '../../buttons-keys/keyHints';
import { Icon } from './Icon';
import { showsInline, useShowKeys } from './keyHints';

/** True inside a ListBox: buttons there are pointer duplicates of their keys (README Accessibility). */
export const InListbox = createContext(false);

/** Whether the component renders inside a ListBox. */
export function useInListbox(): boolean {
  return useContext(InListbox);
}

/** One keycap: 18 px, radius 4, caption, --sunken (DESIGN §6 Kbd). Shown always where it is rendered; never by hover. */
export function Keycap({ chord, reveal }: { chord: string; reveal?: 'hint' | 'badge' }) {
  if (!chord) return null;
  return (
    <kbd className="ui-list-kbd" data-reveal={reveal} aria-hidden={reveal ? true : undefined}>
      {displayChord(chord)}
    </kbd>
  );
}

export interface ActionProps {
  variant: 'filled' | 'text' | 'icon';
  /** 28 / 32 px. */
  size?: 'sm' | 'md';
  /** Visible label, or the accessible name of an icon button. */
  label: string;
  icon?: IconName;
  /** Inline keycap shown always (main actions only: Space, Return). */
  keycap?: string;
  /** The command's keycap for the key-hint modes: inline with "Show all key hints" when `keyHint` is 'hint', a badge while ⌘ is held. */
  hintKey?: string;
  /** Where `hintKey` shows inline (DESIGN §8); default 'tooltip' = only in the tooltip and the ⌘-held badge. */
  keyHint?: KeyHint;
  /** Tooltip text; defaults to the label. */
  tooltip?: string;
  /** Hide the label visually (narrow focus letter); it stays the accessible name. */
  labelHidden?: boolean;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Inside an option: tabIndex -1 and aria-hidden, a pointer duplicate of its key. */
  duplicate?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
  onPress: (anchor: HTMLElement) => void;
}

const FOCUSABLE_ANCESTOR =
  '[tabindex], button, a[href], input, select, textarea, summary, [contenteditable="true"]';

/** Where focus goes in place of a span: the listbox it sits in, else its nearest focusable ancestor. */
export function focusTargetFor(el: HTMLElement): HTMLElement | null {
  const parent = el.parentElement;
  return (
    parent?.closest<HTMLElement>('[role="listbox"]') ??
    parent?.closest<HTMLElement>(FOCUSABLE_ANCESTOR) ??
    null
  );
}

/**
 * A span cannot take focus (and must not: it is aria-hidden), so focus returned to it (a menu closing on its
 * anchor) goes to the listbox it sits in, else the nearest focusable ancestor, instead of falling to body.
 * Own `focus` on the node is the only hook a menu's `anchor.focus()` call can reach.
 */
export function forwardFocusToListbox(el: HTMLElement | null): void {
  if (!el) return;
  el.focus = options => focusTargetFor(el)?.focus(options);
}

/** Plain button: radius 8, press scale, focus ring; one filled per screen is the caller's job. */
export function Action({
  variant,
  size = 'sm',
  label,
  icon,
  keycap,
  hintKey,
  keyHint = 'tooltip',
  tooltip,
  labelHidden,
  tone = 'default',
  disabled,
  duplicate,
  pressed,
  expanded,
  controls,
  onPress,
}: ActionProps) {
  const iconOnly = variant === 'icon' || labelHidden === true;
  const showKeys = useShowKeys();
  const hintInline = !keycap && !!hintKey && showsInline(keyHint, showKeys);
  const hintBadge = !keycap && !hintInline && !!hintKey && showKeys === 'held';
  const handle = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    if (!disabled) onPress(event.currentTarget);
  };
  const content = (
    <>
      {icon ? <Icon name={icon} /> : null}
      {variant === 'icon' || labelHidden ? null : (
        <span className="ui-list-btn__label">{label}</span>
      )}
      {keycap ? <Keycap chord={keycap} /> : null}
      {hintInline && hintKey ? <Keycap chord={hintKey} reveal="hint" /> : null}
      {hintBadge && hintKey ? <Keycap chord={hintKey} reveal="badge" /> : null}
    </>
  );
  const common = {
    className: 'ui-list-btn',
    'data-variant': variant,
    'data-size': size,
    'data-tone': tone === 'danger' ? 'danger' : undefined,
    'data-label-hidden': labelHidden ? 'true' : undefined,
    'aria-label': iconOnly ? label : undefined,
    title: tooltip ?? label,
    onClick: handle,
    onDoubleClick: (event: MouseEvent) => event.stopPropagation(),
  };
  // A pointer duplicate is a span, not a button: a button with tabindex -1 is still focusable, so axe (and a screen
  // reader's virtual cursor) treats it as interactive content inside an option or listbox (nested-interactive,
  // aria-required-children). A span with a click handler is neither focusable nor announced; the key does the work.
  if (duplicate)
    return (
      <span {...common} ref={forwardFocusToListbox} aria-hidden="true">
        {content}
      </span>
    );
  return (
    <button
      type="button"
      {...common}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      disabled={disabled}
    >
      {content}
    </button>
  );
}
