/**
 * The pane header the reader asks for (DESIGN 7.1, 7.5): back with Esc, the crumb "Home  1 of 16" that becomes the
 * thread's subject once the summary has scrolled away, previous and next (K and J), and ⋯. Ask and the calendar button
 * are the shell's. The shell draws the header, so this is only the description, handed over with `usePaneHeaderPart`.
 */
import type { PaneHeaderPart } from '../../shell';
import type { PaneTools } from '../../ui/props';

/** What the header is built from. */
export interface ReaderHeaderInput {
  /** The place the reader was opened from, for the crumb: "Home". */
  readonly origin: string;
  /** The thread's place in that list, when it is in it. */
  readonly position: { readonly index: number; readonly of: number } | null;
  readonly subject: string;
  readonly summaryScrolledAway: boolean;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly back: () => void;
}

function toolsOf(input: ReaderHeaderInput): PaneTools {
  return [
    {
      commandId: 'reader.previousThread',
      icon: 'chevron-up',
      label: 'Previous email',
      disabled: !input.hasPrevious,
    },
    {
      commandId: 'reader.nextThread',
      icon: 'chevron-down',
      label: 'Next email',
      disabled: !input.hasNext,
    },
    {
      commandId: 'list.more',
      icon: 'more',
      label: 'Thread actions',
      detail: 'bookmark, trash, forward, why it’s here',
    },
  ];
}

/** The reader's part of the pane header (the shell adds Ask and the calendar button); Ask means this email. */
export function readerHeader(input: ReaderHeaderInput): PaneHeaderPart {
  return {
    askScope: 'thisEmail',
    lead: { kind: 'back', label: 'Back', commandId: 'nav.back', onPress: input.back },
    crumb: {
      label: input.origin,
      position: input.position ?? undefined,
      subject: input.subject,
      showSubject: input.summaryScrolledAway,
    },
    tools: toolsOf(input),
  };
}
