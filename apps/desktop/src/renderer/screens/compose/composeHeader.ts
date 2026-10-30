/**
 * The pane header the compose page asks for (DESIGN 7.6 New message): close (×, Esc), the crumb "New message", then ⋯
 * (send from, schedule, discard). Ask and the calendar button are the shell's. The shell draws the header; this is only
 * the description (REQUEST: the shell takes it the same way as the reader's).
 */
import type { PaneHeaderProps } from '../../ui/props';

export const COMPOSE_CRUMB = 'New message';

export function composeHeader(input: {
  readonly close: () => void;
  /** The subject once typed: "Reply to Studio Kettle" style crumbs are the reader's; the page keeps "New message". */
  readonly saved: boolean;
}): Omit<PaneHeaderProps, 'ask' | 'today'> {
  return {
    lead: {
      kind: 'close',
      label: input.saved ? 'Close. The draft is saved.' : 'Close',
      commandId: 'compose.close',
      onPress: input.close,
    },
    crumb: { label: COMPOSE_CRUMB },
    tools: [
      { commandId: 'compose.format', icon: 'more', label: 'More', detail: 'send later, discard' },
    ],
  };
}
