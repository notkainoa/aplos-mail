// regions: the keyboard-region model — next/prev over the visible regions, the sidebar's item
// cycle, remembered targets, and the Tab handler's guards. Run from the repo root:
// npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/shell/regions.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  focusRegion,
  handleRegionItemKey,
  handleRegionTab,
  nextRegion,
  noteRegionFocus,
  regionDelta,
  regionItemStep,
  regionOf,
  resetRegionFocus,
  visibleRegions,
  type RegionElement,
} from './regions';

/* -------------------------------- pure parts -------------------------------- */

test('regionDelta: plain Tab steps forward, Shift+Tab back, modified or other keys nothing', () => {
  const tab = { key: 'Tab', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
  assert.equal(regionDelta(tab), 1);
  assert.equal(regionDelta({ ...tab, shiftKey: true }), -1);
  assert.equal(regionDelta({ ...tab, metaKey: true }), 0);
  assert.equal(regionDelta({ ...tab, ctrlKey: true }), 0);
  assert.equal(regionDelta({ ...tab, key: 't' }), 0);
});

test('nextRegion: cycles the visible list, skips absent regions, wraps both ends', () => {
  const all = ['sidebar', 'main', 'dock'];
  assert.equal(nextRegion(all, 'sidebar', 1), 'main');
  assert.equal(nextRegion(all, 'main', 1), 'dock');
  assert.equal(nextRegion(all, 'dock', 1), 'sidebar');
  assert.equal(nextRegion(all, 'sidebar', -1), 'dock');
  // The dock is closed: forward from main wraps to the sidebar.
  const closed = ['sidebar', 'main'];
  assert.equal(nextRegion(closed, 'main', 1), 'sidebar');
  assert.equal(nextRegion(closed, 'main', -1), 'sidebar');
  // Focus was on a region that left (the dock closed): treated as outside, ends answer.
  assert.equal(nextRegion(closed, 'dock', 1), 'sidebar');
  assert.equal(nextRegion(closed, null, 1), 'sidebar');
  assert.equal(nextRegion(closed, null, -1), 'main');
  assert.equal(nextRegion([], 'sidebar', 1), null);
});

test('regionItemStep: arrows clamp at the ends, Home/End jump', () => {
  assert.equal(regionItemStep(3, 0, 'ArrowDown'), 1);
  assert.equal(regionItemStep(3, 2, 'ArrowDown'), 2);
  assert.equal(regionItemStep(3, 2, 'ArrowUp'), 1);
  assert.equal(regionItemStep(3, 0, 'ArrowUp'), 0);
  assert.equal(regionItemStep(3, 1, 'Home'), 0);
  assert.equal(regionItemStep(3, 1, 'End'), 2);
  assert.equal(regionItemStep(3, 1, 'j'), -1);
  assert.equal(regionItemStep(0, 0, 'ArrowDown'), -1);
});

/* ------------------------------ a small fake DOM ----------------------------- */

function matchesSimple(el: FakeEl, simple: string): boolean {
  let s = simple.trim();
  const nots = [...s.matchAll(/:not\(([^)]*)\)/g)].map(m => m[1]);
  s = s.replace(/:not\([^)]*\)/g, '');
  for (const inner of nots) {
    if (matchesSimple(el, inner)) return false;
  }
  let matched = false;
  for (const m of s.matchAll(/(\[[^\]]*\]|\.[\w-]+|[\w-]+)/g)) {
    matched = true;
    const token = m[1];
    if (token.startsWith('[')) {
      const [name, raw] = token.slice(1, -1).split('=');
      const value = el.attrs[name];
      if (raw === undefined ? value === undefined : value !== raw.replaceAll('"', '')) return false;
    } else if (token.startsWith('.')) {
      if (!el.cls.has(token.slice(1))) return false;
    } else if (el.tag !== token.toLowerCase()) {
      return false;
    }
  }
  return matched;
}

function matches(el: FakeEl, selector: string): boolean {
  return selector.split(',').some(part => matchesSimple(el, part));
}

function closestOf(start: FakeEl, selector: string): FakeEl | null {
  let node: FakeEl | null = start;
  while (node) {
    if (matches(node, selector)) return node;
    node = node.parent;
  }
  return null;
}

class FakeEl implements RegionElement {
  tag = 'div';
  cls = new Set<string>();
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  ownerDocument: FakeEl | null = null;
  focused = 0;
  focusedOptions: { preventScroll?: boolean } | undefined;
  isContentEditable = false;
  get isConnected() {
    return true;
  }
  get tagName() {
    return this.tag.toUpperCase();
  }
  get hidden() {
    return 'hidden' in this.attrs;
  }
  get activeElement() {
    return this.activeEl;
  }
  activeEl: FakeEl | null = null;
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  hasAttribute(name: string) {
    return name in this.attrs;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  contains(other: unknown) {
    let node = other as FakeEl | null;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
  closest(selector: string): FakeEl | null {
    return closestOf(this, selector);
  }
  *walk(): Generator<FakeEl> {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
  querySelectorAll(selector: string): FakeEl[] {
    return [...this.walk()].filter(el => matches(el, selector));
  }
  querySelector(selector: string): FakeEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  focus(options?: { preventScroll?: boolean }) {
    this.focused += 1;
    this.focusedOptions = options;
    const doc = this.ownerDocument ?? this;
    doc.activeEl = this;
  }
}

function el(
  tag: string,
  opts: { cls?: string[]; attrs?: Record<string, string>; children?: FakeEl[] } = {},
): FakeEl {
  const node = new FakeEl();
  node.tag = tag;
  for (const c of opts.cls ?? []) node.cls.add(c);
  Object.assign(node.attrs, opts.attrs ?? {});
  for (const child of opts.children ?? []) {
    child.parent = node;
    node.children.push(child);
  }
  return node;
}

/** The window the tests draw: sidebar aside, main pane with a listbox, optional dock with a field. */
function windowTree(withDock: boolean): { doc: FakeEl; items: Record<string, FakeEl> } {
  const row = (id: string, tabindex = '-1') =>
    el('button', { cls: ['ui-puck__item'], attrs: { 'data-puck-id': id, tabindex } });
  const switcher = el('button', { cls: ['ui-account-switcher'] });
  const compose = el('button', { cls: ['ui-button'] });
  const places = [row('home', '0'), row('later'), row('calendar')];
  const mail = [row('all'), row('done'), row('trash')];
  const app = [row('settings'), row('help')];
  // The slot scroller (tabindex 0 when it overflows) sits between the mail rows and the footer.
  const slotField = el('input', { attrs: { type: 'text' } });
  const slot = el('div', {
    cls: ['aplos-sidebar__slot'],
    attrs: { class: 'aplos-sidebar__slot', tabindex: '0' },
    children: [slotField],
  });
  const aside = el('aside', {
    cls: ['aplos-sidebar'],
    attrs: { 'data-region': 'sidebar' },
    children: [switcher, compose, ...places, ...mail, slot, ...app],
  });
  const option = el('div', { attrs: { role: 'option', 'aria-selected': 'true' } });
  const listbox = el('div', {
    cls: ['ui-list-box'],
    attrs: { role: 'listbox', tabindex: '0' },
    children: [option],
  });
  // A marked row outside any listbox, a form control and a field: the scopes Tab must not take.
  const currentRow = el('button', { attrs: { 'aria-current': 'page' } });
  const setting = el('select');
  const field = el('input', { attrs: { type: 'text' } });
  const headerButton = el('button', { cls: ['ui-part-button'] });
  const head = el('header', { cls: ['ui-pane__head'], children: [headerButton] });
  const body = el('div', {
    cls: ['ui-pane__body'],
    children: [listbox, currentRow, setting, field],
  });
  const pane = el('section', {
    cls: ['ui-pane'],
    attrs: { 'data-region': 'main' },
    children: [head, body],
  });
  const askInput = el('input', { attrs: { type: 'text' } });
  const dockTab = el('button', { cls: ['ui-ask-dock__tab'] });
  const dock = el('section', {
    cls: ['ui-pane'],
    attrs: { 'data-region': 'dock' },
    children: [dockTab, askInput],
  });
  const doc = el('body', { children: withDock ? [aside, pane, dock] : [aside, pane] });
  doc.ownerDocument = doc;
  for (const node of doc.walk()) node.ownerDocument = doc;
  return {
    doc,
    items: {
      aside,
      switcher,
      compose,
      slot,
      slotField,
      listbox,
      option,
      currentRow,
      setting,
      field,
      headerButton,
      askInput,
      dockTab,
      home: places[0],
      later: places[1],
    },
  };
}

const noOverlays = { overlays: () => [] as const };

function tabEvent(target: FakeEl, over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: 'Tab',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    defaultPrevented: false,
    target,
    ...over,
  } as KeyboardEvent;
}

test('visibleRegions and regionOf read the data-region tree', () => {
  const { doc, items } = windowTree(true);
  assert.deepEqual(visibleRegions(doc), ['sidebar', 'main', 'dock']);
  assert.equal(visibleRegions(windowTree(false).doc).join(' '), 'sidebar main');
  assert.equal(regionOf(items.listbox), 'main');
  assert.equal(regionOf(items.home), 'sidebar');
  assert.equal(regionOf(null), null);
});

test('handleRegionTab: Tab cycles sidebar → main → dock → sidebar with remembered targets', () => {
  resetRegionFocus();
  const { doc, items } = windowTree(true);
  // Focus sits on the listbox in main: Tab goes to the dock's field.
  doc.activeEl = items.listbox;
  assert.equal(handleRegionTab(tabEvent(items.listbox), noOverlays), true);
  assert.equal(items.askInput.focused, 1);
  assert.equal(items.askInput.focusedOptions?.preventScroll, true);
  // From the dock's field, Tab wraps to the sidebar's roving row (tabindex 0).
  doc.activeEl = items.askInput;
  assert.equal(handleRegionTab(tabEvent(items.askInput), noOverlays), true);
  assert.equal(items.home.focused, 1, 'the roving row takes region focus');
  // Shift+Tab from the sidebar returns to the dock; the remembered target (the input the
  // focusin tracker recorded) is refocused.
  noteRegionFocus(items.askInput);
  doc.activeEl = items.home;
  assert.equal(handleRegionTab(tabEvent(items.home, { shiftKey: true }), noOverlays), true);
  assert.equal(items.askInput.focused, 2, 'dock re-entry lands on the remembered field');
});

test('handleRegionTab: only region scopes hand Tab to the cycle; controls keep native Tab', () => {
  resetRegionFocus();
  const { doc, items } = windowTree(true);
  // A settings control and a pane-header button walk their own form order, not the regions.
  doc.activeEl = items.setting;
  assert.equal(handleRegionTab(tabEvent(items.setting), noOverlays), false);
  doc.activeEl = items.headerButton;
  assert.equal(handleRegionTab(tabEvent(items.headerButton), noOverlays), false);
  // A dock control that is not the field is a control too.
  doc.activeEl = items.dockTab;
  assert.equal(handleRegionTab(tabEvent(items.dockTab), noOverlays), false);
  assert.equal(items.askInput.focused, 0);
  // A marked row (aria-current outside a listbox) and an option inside one are list scopes.
  doc.activeEl = items.currentRow;
  assert.equal(handleRegionTab(tabEvent(items.currentRow), noOverlays), true);
  assert.equal(items.askInput.focused, 1, 'main → dock');
  doc.activeEl = items.option;
  assert.equal(handleRegionTab(tabEvent(items.option), noOverlays), true);
  assert.equal(items.askInput.focused, 2);
  // The page shell: Tab lands on the first region, Shift+Tab on the last.
  doc.activeEl = doc;
  assert.equal(handleRegionTab(tabEvent(doc), noOverlays), true);
  assert.equal(items.home.focused, 1, 'Tab from the page lands on the sidebar');
  doc.activeEl = doc;
  assert.equal(handleRegionTab(tabEvent(doc, { shiftKey: true }), noOverlays), true);
  assert.equal(items.askInput.focused, 3, 'Shift+Tab from the page lands on the dock');
});

test('handleRegionTab: dock closed cycles sidebar → main → sidebar', () => {
  resetRegionFocus();
  const { doc, items } = windowTree(false);
  doc.activeEl = items.home;
  assert.equal(handleRegionTab(tabEvent(items.home), noOverlays), true);
  assert.equal(items.listbox.focused, 1);
  doc.activeEl = items.listbox;
  assert.equal(handleRegionTab(tabEvent(items.listbox), noOverlays), true);
  assert.equal(items.home.focused, 1);
});

test('handleRegionTab: fields outside the dock, overlays, iframes and handled keys keep native Tab', () => {
  resetRegionFocus();
  const { doc, items } = windowTree(true);
  // A text field in the main pane keeps its own Tab (the dock's field is the one exception).
  doc.activeEl = items.field;
  assert.equal(handleRegionTab(tabEvent(items.field), noOverlays), false);
  // A menu open anywhere is an overlay context: no region move.
  assert.equal(handleRegionTab(tabEvent(items.listbox), { overlays: () => ['menu'] }), false);
  // The sealed mail frame keeps its own keys.
  const frame = el('iframe');
  doc.activeEl = frame;
  assert.equal(handleRegionTab(tabEvent(frame), noOverlays), false);
  // defaultPrevented or composing events are left alone.
  doc.activeEl = items.listbox;
  assert.equal(
    handleRegionTab(tabEvent(items.listbox, { defaultPrevented: true }), noOverlays),
    false,
  );
  assert.equal(handleRegionTab(tabEvent(items.listbox, { isComposing: true }), noOverlays), false);
});

test('focusRegion: a remembered target wins over the default entry point', () => {
  resetRegionFocus();
  const { doc, items } = windowTree(false);
  noteRegionFocus(items.later);
  assert.equal(focusRegion(doc, 'sidebar'), true);
  assert.equal(items.later.focused, 1);
  assert.equal(items.home.focused, 0);
  resetRegionFocus();
  assert.equal(focusRegion(doc, 'sidebar'), true);
  assert.equal(items.home.focused, 1, 'the roving row (tabindex 0) is the default');
});

test('handleRegionItemKey: arrows walk every sidebar item across the groups', () => {
  const { doc, items: drawn } = windowTree(false);
  const aside = doc.querySelector('[data-region="sidebar"]') as FakeEl;
  const items = aside.querySelectorAll('button');
  const key = (target: FakeEl, name: string, mods: Partial<Record<string, boolean>> = {}) => {
    let prevented = false;
    const used = handleRegionItemKey({
      key: name,
      target: target as unknown as EventTarget,
      defaultPrevented: false,
      ...mods,
      preventDefault: () => {
        prevented = true;
      },
    });
    return { used, prevented };
  };
  // The switcher is item 0; ArrowDown walks through the buttons into the puck rows.
  const down = key(items[0], 'ArrowDown');
  assert.equal(down.used, true);
  assert.equal(down.prevented, true);
  assert.equal(items[1].focused, 1);
  // From the last Places row ArrowDown crosses into the first Mail row.
  const lastPlaces = aside.querySelectorAll('.ui-puck__item')[2];
  const firstMail = aside.querySelectorAll('.ui-puck__item')[3];
  assert.equal(key(lastPlaces, 'ArrowDown').used, true);
  assert.equal(firstMail.focused, 1);
  // ArrowUp on the first Mail row returns to the last Places row.
  lastPlaces.focused = 0;
  assert.equal(key(firstMail, 'ArrowUp').used, true);
  assert.equal(lastPlaces.focused, 1);
  // Home and End jump the whole region; the ends clamp (Up on the first stays).
  const last = items[items.length - 1];
  assert.equal(key(items[0], 'End').used, true);
  assert.equal(last.focused, 1);
  items[0].focused = 0;
  assert.equal(key(last, 'Home').used, true);
  assert.equal(items[0].focused, 1);
  // A non-item target (the aside itself) and non-arrow keys pass through.
  assert.equal(key(aside, 'ArrowDown').used, false);
  assert.equal(key(items[1], 'x').used, false);
  // Modified arrows pass through: ⌥↑/⌥↓ lane moves and shifted arrows belong to the registry.
  for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
    const walk = key(items[1], 'ArrowDown', mods);
    assert.equal(walk.used, false);
    assert.equal(walk.prevented, false);
  }
  // The slot scroller is a region item, but arrows scroll it: no walk, no preventDefault.
  const slot = key(drawn.slot, 'ArrowDown');
  assert.equal(slot.used, false);
  assert.equal(slot.prevented, false);
  // A field inside the slot keeps its arrows for the caret.
  assert.equal(key(drawn.slotField, 'ArrowDown').used, false);
  // A handled key (defaultPrevented by a widget such as the mini month) passes through.
  let prevented = false;
  const used = handleRegionItemKey({
    key: 'ArrowDown',
    target: items[1] as unknown as EventTarget,
    defaultPrevented: true,
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(used, false);
  assert.equal(prevented, false);
});

/* --------------------------- the container-ring sweep --------------------------- */

const SWEPT: ReadonlyArray<readonly [string, string]> = [
  ['../ui/list/list.css', '.ui-list-box'],
  ['../ui/list/list.css', '.ui-low-sheet__panel'],
  ['../ui/controls/controls.css', '.ui-shortcut-sheet-body'],
  ['../ui/calendar/calendar.css', '.ui-calendar-grid'],
  ['../ui/calendar/calendar.css', '.ui-calendar-grid__scroll'],
  ['../ui/surfaces/surfaces.css', '.ui-pane'],
  ['../ui/surfaces/surfaces.css', '.ui-menu'],
  ['../ui/surfaces/surfaces.css', '.ui-dialog'],
  ['../ui/surfaces/surfaces.css', '.ui-popover'],
  ['../screens/reader/reader.css', '.aplos-reader'],
  ['../screens/reader/reader.css', '.aplos-mailframe__frame'],
];

function rulesFor(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*]/g, ch => `\\${ch}`);
  return [...css.matchAll(new RegExp(`${escaped}:focus[^}]*?\\{([^}]*)\\}`, 'g'))].map(m => m[1]);
}

test('focus containers draw no ring: every swept :focus rule is outline none', () => {
  for (const [file, selector] of SWEPT) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');
    const rules = rulesFor(css, selector);
    assert.ok(rules.length > 0, `${selector} has a focus rule in ${file}`);
    for (const body of rules) {
      assert.match(body, /outline:\s*none/, `${selector} must not ring (${file})`);
      assert.doesNotMatch(body, /outline:\s*var\(--focus-width\)/, `${file}: ${selector}`);
    }
  }
});

test('handleRegionItemKey: the slot scroller hands arrows on at its ends, never traps', () => {
  const { items } = windowTree(false);
  const slot = items.slot as FakeEl & {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
  };
  const key = (name: string) => {
    let prevented = false;
    const used = handleRegionItemKey({
      key: name,
      target: slot as unknown as EventTarget,
      defaultPrevented: false,
      preventDefault: () => {
        prevented = true;
      },
    });
    return { used, prevented };
  };
  Object.assign(slot, { scrollTop: 0, clientHeight: 300, scrollHeight: 900 });
  // Mid-scroll: the slot keeps the arrow for scrolling.
  slot.scrollTop = 200;
  assert.equal(key('ArrowDown').used, false);
  slot.scrollTop = 100;
  assert.equal(key('ArrowUp').used, false);
  // At the ends the arrow moves on to the next region item — focus is never trapped.
  slot.scrollTop = 600; // scrollTop + clientHeight >= scrollHeight
  assert.equal(key('ArrowDown').used, true);
  slot.scrollTop = 0;
  assert.equal(key('ArrowUp').used, true);
});
