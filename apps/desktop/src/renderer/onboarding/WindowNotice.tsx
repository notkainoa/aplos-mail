/**
 * The onboarding window's own failure line (DESIGN 7.15): a failed demo load or a failed handoff to the mail window,
 * drawn visibly in the step as an `ErrorLine` (icon in `--stamp-ink`, the words in ink) with Try again when it can be
 * retried. The sentence comes from `copy.ts`; the step's one visually hidden `role="status"` announces it, so this
 * line adds no live region of its own.
 */
import { ErrorLine } from '../ui/list';
import type { WindowNotice } from './flow';

export function WindowNoticeLine({ notice }: { readonly notice: WindowNotice | undefined }) {
  if (!notice) return null;
  return (
    <div className="onb-wide" data-notice="window">
      <ErrorLine
        kind="reason"
        text={notice.text}
        retryable={notice.onRetry !== undefined}
        placement="checklist"
        onAction={() => notice.onRetry?.()}
      />
    </div>
  );
}
