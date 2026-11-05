/**
 * What the mounted screen adds to the pane header: the back chevron and crumb ("Home" + "1 of 9" while one by one), and
 * the bulk bar that replaces the left side while rows are picked (DESIGN 7.1, 7.4). The shell owns the header and the
 * Ask and Today buttons; a screen only contributes these parts. Of the mounted contributions the latest wins (a part is whole: nothing is merged across parts, so a bulk bar and a reader header never mix); one screen is mounted at a time, so a part that changes (the bulk count) is simply pushed again. A part compares by reference, so the caller memoises it.
 */
import { createStore } from './store-core';
import type { CommandId } from '../commands';
import type { PaneHeaderProps } from '../ui/props';

/**
 * The parts of the header a screen may set. The reader and the compose page also bring their tools: a press runs the
 * tool's command through the registry unless the part has its own `onTool` (to anchor a menu on the pressed button).
 * `askScope` says whether Ask means the whole mailbox (the default) or the open email. Ask and the calendar button stay
 * the shell's.
 */
export type PaneHeaderPart = Pick<
  PaneHeaderProps,
  'lead' | 'crumb' | 'bulk' | 'tools' | 'onTool'
> & {
  readonly askScope?: PaneHeaderProps['ask']['scope'];
};

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

/** The shell's header: Ask and the calendar button added to the screen's part, tool presses wired (see `PaneHeaderPart`). */
export function mergePaneHeaderPart(
  base: Pick<PaneHeaderProps, 'ask' | 'today'>,
  part: PaneHeaderPart,
  runCommand: (commandId: CommandId) => void,
): PaneHeaderProps {
  const { askScope, ...rest } = part;
  return {
    ...rest,
    onTool: rest.tools ? (rest.onTool ?? ((id: CommandId) => runCommand(id))) : rest.onTool,
    ask: askScope ? { ...base.ask, scope: askScope } : base.ask,
    today: base.today,
  };
}
