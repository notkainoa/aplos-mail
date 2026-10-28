// Context stack shapes. The shell collects contexts from the route and from
// `data-keyctx` on the focused element's ancestors; in the main pane the reader is
// not a DOM descendant of the list, so the raw set can miss 'list'. buildStack
// restores the shapes DESIGN §8 assumes ("Reader: everything in Lists").
import type { ContextName, ContextStack } from './types';

/**
 * Focus-scoped modal transients. Their keys work only while they have focus, so
 * WCAG 2.1.4 exempts them from the single-key switch (a menu's 1–9), and once the
 * resolver reaches one, outer contexts never answer: E behind a Trash confirm,
 * or ⌘Return behind the palette, does nothing.
 */
export const MODAL_CONTEXTS: readonly ContextName[] = [
  'palette',
  'menu',
  'datePicker',
  'dialog',
  'sheet',
  'lowImportance',
];

/** The onboarding window's contexts: that window has no 'global', so no app command reaches it. */
export const ONBOARDING_WINDOW_CONTEXTS: readonly ContextName[] = [
  'onboarding',
  'firstSync',
  'drill',
];

/** Contexts that must sit under another, outer to inner. */
const IMPLIED: Readonly<Partial<Record<ContextName, readonly ContextName[]>>> = {
  home: ['list'],
  done: ['list'],
  reader: ['list'],
  oneByOne: ['list', 'reader'],
  firstSync: ['onboarding'],
  drill: ['onboarding', 'firstSync'],
};

/**
 * Contexts each context can sit on top of in some real stack. Used to report a
 * remap that one context's binding would hide in another (shadowing). Modals are
 * absent: nothing outside them answers while they are open.
 */
const SITS_ON: Readonly<Record<ContextName, readonly ContextName[]>> = {
  global: [],
  search: ['global'],
  list: ['global', 'search'],
  home: ['global', 'list'],
  done: ['global', 'list'],
  reader: ['global', 'search', 'list', 'home', 'done'],
  oneByOne: ['global', 'list', 'home', 'reader'],
  compose: ['global', 'search', 'list', 'home', 'done', 'reader', 'oneByOne'],
  ask: ['global'],
  calendar: ['global'],
  settings: ['global'],
  onboarding: [],
  firstSync: ['onboarding'],
  drill: ['onboarding', 'firstSync'],
  palette: [],
  menu: [],
  datePicker: [],
  dialog: [],
  sheet: [],
  lowImportance: [],
};

export function isModal(context: ContextName): boolean {
  return MODAL_CONTEXTS.includes(context);
}

/** True when one context can sit on the other, so the inner one's keys hide the outer one's. */
export function canShareStack(a: ContextName, b: ContextName): boolean {
  return a !== b && (SITS_ON[a].includes(b) || SITS_ON[b].includes(a));
}

/**
 * Normalizes a context stack: 'global' first (the onboarding window has none and
 * keeps only its own contexts), implied contexts inserted before the context that
 * needs them (['global', 'reader'] → ['global', 'list', 'reader'], ['drill'] →
 * ['onboarding', 'firstSync', 'drill']), 'search' right after 'global', duplicates
 * dropped, modal transients moved last in their original order.
 */
export function buildStack(contexts: readonly ContextName[]): ContextStack {
  const modals = contexts.filter(isModal);
  const onboardingWindow = contexts.some(c => ONBOARDING_WINDOW_CONTEXTS.includes(c));
  const base = contexts.filter(
    c => !isModal(c) && ONBOARDING_WINDOW_CONTEXTS.includes(c) === onboardingWindow,
  );
  const out: ContextName[] = onboardingWindow ? [] : ['global'];
  const add = (c: ContextName) => {
    if (!out.includes(c)) out.push(c);
  };
  // The Search page is always outside its results list, whatever order the shell collected them in.
  if (base.includes('search')) add('search');
  for (const c of base) {
    for (const implied of IMPLIED[c] ?? []) add(implied);
    add(c);
  }
  for (const m of modals) add(m);
  return out;
}
