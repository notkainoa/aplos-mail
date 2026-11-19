/**
 * The hidden chip and edge the triage motion clones onto a leaving row or letter (DESIGN 4.9). Rendering the real
 * `CommitChip` and `CommitEdge` once, off screen, is what makes the real markup fly. Shared by Home and the lists.
 */
import type { RefObject } from 'react';
import { CommitChip, CommitEdge } from '../ui/list';

const COMMIT_KINDS = ['done', 'later', 'trash'] as const;

export function CommitTemplates({
  forwardedRef,
}: {
  readonly forwardedRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={forwardedRef} hidden aria-hidden="true">
      {COMMIT_KINDS.map(kind => (
        <span key={`chip-${kind}`} data-part="chip" data-kind={kind}>
          <CommitChip kind={kind} />
        </span>
      ))}
      {COMMIT_KINDS.map(kind => (
        <span key={`edge-${kind}`} data-part="edge" data-kind={kind}>
          <CommitEdge kind={kind} />
        </span>
      ))}
    </div>
  );
}
