/**
 * The pane header the compose page asks for (DESIGN 7.6 New message): close (×, Esc), the crumb "New message", then ⋯
 * (send from, schedule, discard) on its own command, `compose.more`, anchored to the header button (⌘/ stays the format
 * menu). Ask and the calendar button are the shell's. The shell draws the header; this is only the description. A
 * press of ⋯ reaches the mounted page through `headerMenu`, so the page opens its menu under the button.
 */
import type { PaneHeaderPart } from '../../shell';

export const COMPOSE_CRUMB = 'New message';
/** A forward's crumb: the page says what it is. */
export const FORWARD_CRUMB = 'Forward';

/** What the page is, for the header: a forward says "Forward", a reopened draft "Draft", anything else "New message". */
export function composeCrumb(page: {
  readonly forward?: boolean;
  /** The draft the page opened on, once its row is known (a reply draft keeps "New message", a forward draft says "Forward"). */
  readonly draft?: { readonly mode: string } | null;
  readonly draftId?: string;
}): string {
  if (page.forward || page.draft?.mode === 'forward') return FORWARD_CRUMB;
  if (!page.draftId) return COMPOSE_CRUMB;
  return page.draft?.mode === 'reply' || page.draft?.mode === 'replyAll' ? COMPOSE_CRUMB : 'Draft';
}

/** The header ⋯'s command and label. */
export const COMPOSE_MORE = { commandId: 'compose.more', label: 'More' } as const;

type MenuListener = (anchor: HTMLElement | null) => void;

const listeners = new Set<MenuListener>();

/** The header's ⋯ was pressed (or `compose.more` ran): the mounted page opens its menu at `anchor`. */
export const headerMenu = {
  open(anchor: HTMLElement | null): void {
    for (const listener of [...listeners]) listener(anchor);
  },
  subscribe(listener: MenuListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** The header's ⋯ button, for `compose.more` run from the palette (no element of its own). */
export function headerMoreButton(
  scope: Pick<Document, 'querySelector'> | undefined = globalThis.document,
) {
  return (
    scope?.querySelector<HTMLElement>(`.ui-pane__tools [aria-label="${COMPOSE_MORE.label}"]`) ??
    null
  );
}

export function composeHeader(input: {
  readonly close: () => void;
  /** The subject once typed: "Reply to Studio Kettle" style crumbs are the reader's; the page keeps "New message". */
  readonly saved: boolean;
  /** The crumb's words (`composeCrumb`); when absent, "Forward" for a forward and "New message" otherwise. */
  readonly crumb?: string;
  /** The page is a forward: without a `crumb`, the crumb says "Forward". */
  readonly forward?: boolean;
}): PaneHeaderPart {
  return {
    lead: {
      kind: 'close',
      label: input.saved ? 'Close. The draft is saved.' : 'Close',
      commandId: 'compose.close',
      onPress: input.close,
    },
    crumb: { label: input.crumb ?? (input.forward ? FORWARD_CRUMB : COMPOSE_CRUMB) },
    tools: [
      {
        commandId: COMPOSE_MORE.commandId,
        icon: 'more',
        label: COMPOSE_MORE.label,
        detail: 'send later, discard',
      },
    ],
    onTool: (commandId, anchor) => {
      if (commandId === COMPOSE_MORE.commandId) headerMenu.open(anchor);
    },
  };
}
