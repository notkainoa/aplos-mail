/**
 * Keyboard regions (the decided keyboard model): Tab and Shift+Tab cycle the window's regions —
 * sidebar → main → dock (when open) — instead of walking every control. Inside a region ↑/↓ (and
 * Home/End) move among its items; Enter activates. A region is any element marked `data-region`;
 * the shell's one key listener mounts the Tab handler, and a focusin tracker remembers each
 * region's last target so re-entering lands where focus left off.
 *
 * Everything here is DOM-light: the pure parts take arrays or attribute-reading elements so node
 * tests can drive them without a document.
 */
import { focusKindOf } from '../commands';

/** The attribute that marks a keyboard region; its value names it ('sidebar', 'main', 'dock'). */
export const REGION_ATTRIBUTE = 'data-region';

/** Tabbable-looking controls; pointer duplicates (tabindex -1, aria-hidden) are not items. */
const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"]), ' +
  '[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), ' +
  '[tabindex="0"], [contenteditable="true"]';

/** The sidebar's arrow cycle: every puck row plus the other tabbables, in DOM order. */
const REGION_ITEM = `.ui-puck__item:not([disabled]):not([aria-hidden="true"]), ${FOCUSABLE}`;

/** The slice of an element the region logic reads; a real `Element` satisfies it. */
export interface RegionElement {
  readonly isConnected?: boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  contains(other: unknown): boolean;
  closest(selector: string): RegionElement | null;
  querySelectorAll(selector: string): ArrayLike<RegionElement>;
  querySelector(selector: string): RegionElement | null;
  focus(options?: { preventScroll?: boolean }): void;
}

/** The slice of a document/root the region logic reads. */
export interface RegionRoot {
  querySelectorAll(selector: string): ArrayLike<RegionElement>;
  querySelector(selector: string): RegionElement | null;
}

/** `el.closest('[data-region]')`'s value, or null outside every region. */
export function regionOf(
  el: {
    closest?(selector: string): { getAttribute(name: string): string | null } | null;
  } | null,
): string | null {
  return el?.closest?.(`[${REGION_ATTRIBUTE}]`)?.getAttribute(REGION_ATTRIBUTE) ?? null;
}

/** The region names under `root`, deduped in DOM order; hidden elements are skipped. */
export function visibleRegions(root: {
  querySelectorAll(
    selector: string,
  ): ArrayLike<{ getAttribute(name: string): string | null; hidden?: boolean }>;
}): string[] {
  const seen: string[] = [];
  const found = root.querySelectorAll(`[${REGION_ATTRIBUTE}]`);
  for (let i = 0; i < found.length; i += 1) {
    const name = found[i].getAttribute(REGION_ATTRIBUTE);
    if (name && !found[i].hidden && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** Tab or Shift+Tab with no other modifier → +1/-1; anything else → 0. */
export function regionDelta(event: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): number {
  if (event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return 0;
  return event.shiftKey ? -1 : 1;
}

/**
 * The region a step lands on: `regions` is the ordered visible list, `current` the focused one
 * (or null when focus is outside all of them — then the step lands on an end). The ends wrap.
 */
export function nextRegion(
  regions: readonly string[],
  current: string | null,
  delta: number,
): string | null {
  if (regions.length === 0 || delta === 0) return null;
  const at = current === null ? -1 : regions.indexOf(current);
  if (at < 0) return delta > 0 ? regions[0] : regions[regions.length - 1];
  return regions[(at + (delta > 0 ? 1 : -1) + regions.length) % regions.length];
}

/** The index an arrow/Home/End moves to inside a region's items; -1 keeps focus where it is. */
export function regionItemStep(count: number, current: number, key: string): number {
  if (count === 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : Math.min(current + 1, count - 1);
    case 'ArrowUp':
      return current < 0 ? 0 : Math.max(current - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return -1;
  }
}

/** The element the last focusin inside each region saw. */
const remembered = new Map<string, RegionElement>();

/** Records `el` as its region's remembered target; called from a focusin listener. */
export function noteRegionFocus(el: unknown): void {
  const name = regionOf(el as Parameters<typeof regionOf>[0]);
  if (name) remembered.set(name, el as RegionElement);
}

/** Installs the remembered-target tracker on `doc`; returns the unbind. */
export function trackRegionFocus(doc: {
  addEventListener(type: string, listener: (event: { target: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { target: unknown }) => void): void;
}): () => void {
  const onFocusIn = (event: { target: unknown }) => noteRegionFocus(event.target);
  doc.addEventListener('focusin', onFocusIn);
  return () => doc.removeEventListener('focusin', onFocusIn);
}

/** Tests only: forget every remembered target. */
export function resetRegionFocus(): void {
  remembered.clear();
}

function firstMatch(region: RegionElement, selector: string): RegionElement | null {
  return region.querySelector(selector);
}

function firstFocusable(region: RegionElement): RegionElement | null {
  return firstMatch(region, FOCUSABLE);
}

/**
 * The element a region hands focus to: its remembered target, else the region's own entry point —
 * the sidebar's roving row, the dock's field, the main pane's listbox (its one Tab stop) or its
 * first focusable.
 */
export function regionFocusTarget(region: RegionElement): RegionElement | null {
  const name = region.getAttribute(REGION_ATTRIBUTE);
  const last = name === null ? undefined : remembered.get(name);
  if (last && last.isConnected !== false && region.contains(last)) return last;
  switch (name) {
    case 'sidebar':
      return (
        firstMatch(region, '.ui-puck__item[tabindex="0"]') ??
        firstMatch(region, '.ui-puck__item') ??
        firstFocusable(region)
      );
    case 'dock':
      return (
        firstMatch(region, 'input, textarea, [contenteditable="true"]') ?? firstFocusable(region)
      );
    default: {
      const body = firstMatch(region, '.ui-pane__body') ?? region;
      return firstMatch(body, '[role="listbox"]') ?? firstFocusable(body) ?? firstFocusable(region);
    }
  }
}

/** Focuses the named region's remembered or default target; false when no such region is mounted. */
export function focusRegion(root: RegionRoot, name: string): boolean {
  const region = root.querySelector(`[${REGION_ATTRIBUTE}="${name}"]`);
  if (!region) return false;
  const target = regionFocusTarget(region) ?? region;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  return true;
}

/** What `handleRegionTab` needs from the key plumbing: the modal overlays around a target. */
export interface RegionTabHooks {
  overlays(target: unknown): readonly unknown[];
}

/** The scopes region Tab owns inside a region: a list region, a list row or the reader's surface. */
const LIST_SCOPE = '[role="listbox"], [role="option"], .ui-list-box, .aplos-reader';

/** A list row carries a selection mark of its own: aria-current, aria-selected or data-active. */
function listRow(el: RegionElement): boolean {
  return (
    el.hasAttribute('aria-current') ||
    el.hasAttribute('aria-selected') ||
    el.hasAttribute('data-active')
  );
}

/** The page shell (body or the document element): focus there cycles the regions from an end. */
function pageShell(el: RegionElement): boolean {
  const tag = (el as { tagName?: string }).tagName;
  return tag === 'BODY' || tag === 'HTML';
}

/**
 * The focuses region Tab owns: the page shell, a region element itself, anything inside the
 * sidebar region, and the list-like scopes (`LIST_SCOPE` or a marked row). Everywhere else —
 * settings controls, compose fields, header buttons, any control in a dialog — Tab stays native
 * (each region's single roving tab stop keeps native order near sidebar → main → dock anyway).
 */
function regionTabScope(el: RegionElement): boolean {
  if (pageShell(el)) return true;
  if (el.hasAttribute(REGION_ATTRIBUTE)) return true;
  if (el.closest(`[${REGION_ATTRIBUTE}="sidebar"]`) !== null) return true;
  return el.closest(LIST_SCOPE) !== null || listRow(el);
}

/**
 * The Tab/Shift+Tab the region model owns: plain Tab on a region scope (see `regionTabScope`),
 * outside overlays and the sealed mail frame, moves focus one region over. A field keeps its own
 * Tab — except the dock's field, where Tab leaves for the next region. Returns true when it moved
 * focus (the caller preventDefaults).
 */
export function handleRegionTab(event: KeyboardEvent, hooks: RegionTabHooks): boolean {
  const delta = regionDelta(event);
  if (delta === 0 || event.defaultPrevented || event.isComposing) return false;
  const target = event.target as RegionElement | null;
  const doc = ((target as unknown as { ownerDocument?: RegionRoot & { activeElement?: unknown } })
    ?.ownerDocument ??
    (typeof document === 'undefined'
      ? null
      : (document as unknown as RegionRoot & { activeElement?: unknown }))) as
    (RegionRoot & { activeElement?: unknown }) | null;
  if (!doc) return false;
  const active = (doc.activeElement ?? target) as RegionElement | null;
  const region = regionOf(active);
  const text = focusKindOf(target) === 'text' || focusKindOf(active) === 'text';
  if (text && region !== 'dock') return false;
  // The sealed mail frame never hands its keys to the page; a focused frame keeps native Tab.
  const tag = (el: unknown) => (el as { tagName?: string } | null)?.tagName;
  if (tag(target) === 'IFRAME' || tag(active) === 'IFRAME') return false;
  if (hooks.overlays(target).length > 0 || hooks.overlays(active).length > 0) return false;
  if (!text && active !== null && !regionTabScope(active)) return false;
  const next = nextRegion(visibleRegions(doc), region, delta);
  if (!next) return false;
  return focusRegion(doc, next);
}

/** The items a region's arrow cycle walks, DOM order. Elements inside self-managing widgets are out. */
export function regionItems(region: RegionElement): RegionElement[] {
  const found = region.querySelectorAll(REGION_ITEM);
  const items: RegionElement[] = [];
  for (let i = 0; i < found.length; i += 1) {
    if (found[i].closest('.ui-mini-month') === null) items.push(found[i]);
  }
  return items;
}

function hasClassName(el: RegionElement | null | undefined, name: string): boolean {
  return (el?.getAttribute('class') ?? '').split(/\s+/).includes(name);
}

/** A scrollable slot keeps arrows for scrolling — except at its ends, where they hand on to the next region item. */
function slotKeepsArrow(target: unknown, key: string): boolean {
  const el = target as { scrollTop: number; clientHeight: number; scrollHeight: number };
  const { scrollTop, clientHeight, scrollHeight } = el;
  if ([scrollTop, clientHeight, scrollHeight].some(n => typeof n !== 'number' || Number.isNaN(n)))
    return true;
  if (key === 'ArrowDown' || key === 'End' || key === 'PageDown')
    return scrollTop + clientHeight < scrollHeight - 1;
  if (key === 'ArrowUp' || key === 'Home' || key === 'PageUp') return scrollTop > 0;
  return true;
}

/**
 * The sidebar's within-region arrow keys: a plain ↑/↓/Home/End walks the region's items across
 * every Puck group. Returns true when focus moved. Bound as a React onKeyDown on the sidebar's
 * aside; modified keys (⌥↑/⌥↓ lane moves live in the registry), fields, the slot scroller (mid-scroll
 * only: at its ends the arrow hands on) and targets that are not region items (or keys a widget already
 * took) pass through.
 */
export function handleRegionItemKey(event: {
  key: string;
  target: EventTarget | null;
  defaultPrevented: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  nativeEvent?: { isComposing?: boolean };
  preventDefault(): void;
}): boolean {
  if (event.defaultPrevented || event.nativeEvent?.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const target = event.target as unknown as RegionElement | null;
  if (focusKindOf(target) === 'text') return false;
  if (hasClassName(target, 'aplos-sidebar__slot') && slotKeepsArrow(target, event.key))
    return false;
  const region = target?.closest?.(`[${REGION_ATTRIBUTE}]`) ?? null;
  if (!region) return false;
  const items = regionItems(region);
  const current = items.indexOf(target as RegionElement);
  if (current < 0) return false;
  const next = regionItemStep(items.length, current, event.key);
  if (next < 0 || next === current) return false;
  event.preventDefault();
  items[next].focus({ preventScroll: true });
  return true;
}
