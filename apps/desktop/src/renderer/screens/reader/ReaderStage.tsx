/**
 * The email card without the reader's list or keys, for the one-by-one view (owner request 2026-11-10): one thread's
 * letter, laid out off paper and swapped in once measured (the no-blank-sheet double buffer), with the 12 px loading line
 * after 1.5 s. The caller owns the keys, the header and what the buttons do (`controls`); this owns the letter's own
 * state (earlier cards opened, quoted text, remote images) and the card style.
 */
import { useCallback, useReducer } from 'react';
import { useCardStyle } from '../cardStyle';
import { LoadingLine } from '../../ui/reader';
import { useRow } from '../../data';
import { LOADING_COPY } from './ReaderScreen';
import { ReaderLetter, type LetterControls } from './ReaderLetter';
import { loadingLabel } from './readerRows';
import { freshUi, reduceFor, uiFor, type UiEvent } from './readerUi';
import { useLetterBuffer, useLetterController } from './useLetterBuffer';

/** Props for `ReaderStage`. */
export interface ReaderStageProps {
  /** The thread the caller wants showing. */
  readonly open: string;
  readonly controls: LetterControls;
}

function ignore(_event: UiEvent): void {
  return undefined;
}

/** The wanted thread's card; the thread before it is not kept on paper while this one loads. */
export function ReaderStage({ open, controls }: ReaderStageProps) {
  const cards = useCardStyle(undefined);
  const controller = useLetterController();
  // Every change of thread here is an action or a deliberate step: the next one shows at once, never the finished card.
  const buffer = useLetterBuffer(controller, open, () => true);
  const shown = buffer.letter;
  const wantedRow = useRow('Thread', open);
  const [ui, send] = useReducer(reduceFor, freshUi(null));
  const dispatchShown = useCallback(
    (event: UiEvent) => {
      if (shown !== null) send({ threadId: shown, event });
    },
    [shown],
  );
  // A stable order, so a letter that stays mounted is never moved in the DOM (moving a frame reloads it).
  const letters = [...new Set([shown, open].filter((id): id is string => id !== null))].sort();
  return (
    <div className="aplos-reader" data-cards={cards} data-stage="one-by-one">
      {buffer.loadingLine ? <LoadingLine label={loadingLabel(wantedRow) ?? LOADING_COPY} /> : null}
      {letters.map(id => (
        <ReaderLetter
          key={id}
          threadId={id}
          paper={id === shown}
          cards={cards}
          ui={uiFor(ui, id)}
          dispatch={id === shown ? dispatchShown : ignore}
          controls={controls}
          onReady={controller.ready}
        />
      ))}
    </div>
  );
}
