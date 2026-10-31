import type { DraftStateProps } from '../props';
import { Icon } from './icons';
import { Btn } from './parts';

/** One line: "Saving…", "Draft saved", "Couldn't save · Retry" (DESIGN §6 DraftState, §7.6). A polite status. */
export function DraftState({ state, onRetry }: DraftStateProps) {
  if (state === 'none') return null;
  return (
    <span className="ui-draft-state" role="status" data-state={state}>
      {state === 'saving' ? 'Saving…' : null}
      {state === 'saved' ? 'Draft saved' : null}
      {state === 'failed' ? (
        <>
          <Icon name="alert" size="sm" />
          <span className="ui-draft-state__text">Couldn’t save</span>
          {onRetry ? (
            <>
              <span className="ui-draft-state__dot" aria-hidden="true">
                ·
              </span>
              <Btn variant="text" label="Retry" onPress={onRetry} />
            </>
          ) : null}
        </>
      ) : null}
    </span>
  );
}
