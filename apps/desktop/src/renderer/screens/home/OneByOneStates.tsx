/**
 * The one-by-one view's finish: one calm line in the pane, in sans `display` like Home's inbox zero, with a quiet
 * button back. The same view says "Nothing to go through" when Do now held nothing to begin with.
 */
import { EmptyLine } from '../../ui/list';

/** Props for `OneByOneFinish`. */
export interface OneByOneFinishProps {
  /** Do now was empty when the walk started. */
  readonly nothing: boolean;
  readonly onBack: () => void;
}

export function OneByOneFinish({ nothing, onBack }: OneByOneFinishProps) {
  return (
    <EmptyLine
      placement="pane"
      size="display"
      text={nothing ? 'Nothing to go through' : 'That’s everyone'}
      action={{ label: 'Back to Home', commandId: 'nav.back', emphasis: 'text', onSelect: onBack }}
    />
  );
}
