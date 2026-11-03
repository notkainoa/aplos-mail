/**
 * What the mounted screen adds to the pane header: the back chevron and crumb ("Home" + "1 of 9" while one by one), and
 * the bulk bar that replaces the left side while rows are picked (DESIGN 7.1, 7.4). The shell owns the header and the
 * Ask and Today buttons; a screen only contributes these parts. Of the mounted contributions the latest wins.
 */
import { createStore } from './store-core';
import type { PaneHeaderProps } from '../ui/props';

/** The parts of the header a screen may set; the tools and Ask stay the shell's. */
export type PaneHeaderPart = Pick<PaneHeaderProps, 'lead' | 'crumb' | 'bulk'>;

const NONE: PaneHeaderPart = {};
const stack: PaneHeaderPart[] = [];
const paneStore = createStore<PaneHeaderPart>(NONE);

function publish(): void {
  paneStore.set(stack.at(-1) ?? NONE);
}

/** Adds a contribution above the existing ones; returns the function that removes it. */
export function addPaneHeaderPart(part: PaneHeaderPart): () => void {
  stack.push(part);
  publish();
  return () => {
    const at = stack.indexOf(part);
    if (at >= 0) stack.splice(at, 1);
    publish();
  };
}

export const getPaneHeaderPart = paneStore.get;
export const subscribePaneHeaderPart = paneStore.subscribe;
