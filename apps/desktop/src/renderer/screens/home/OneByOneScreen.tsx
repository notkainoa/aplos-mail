/**
 * "Go one by one" (DESIGN 7.2, key S): the Do-now threads one at a time, each as the focus letter in a calm, centred
 * pane. J/K move, E, L and Space commit and the walk steps on, Return/O open the thread, Esc goes back to Home. The
 * queue is fixed when the view opens, so mail arriving never changes the thread under view. It is mounted on the shell
 * screen `{ label: 'one by one' }`. Each thread is the reader's own email card (`ReaderStage`): the whole letter, the header, the pinned bar; Space, Reply,
 * Later and Done keep their Home behaviour (Reply opens the reader).
 */
import { ErrorLine } from '../../ui/list';
import { ListFailed } from '../lists/ListStates';
import { Reopenable } from '../lists/Reopenable';
import { HomeMenu, type HomeMenuChoice } from './HomeMenu';
import { suggestionOf } from './homeRows';
import { ReaderStage, relayToShell, type LetterControls } from '../reader';
import { rowDomId } from './HomeList';
import { OneByOneFinish } from './OneByOneStates';
import { useOneByOne, type OneByOne, type OneByOneScreenProps } from './useOneByOne';
import { WhyHost } from './WhyHost';

export type { OneByOneScreenProps } from './useOneByOne';

/** The ⋯ menu's choices, on the thread showing. */
export function chooseFromMenu(view: OneByOne, id: HomeMenuChoice): void {
  switch (id) {
    case 'suggested':
      return view.actions.suggested();
    case 'later':
      return view.actions.later();
    case 'done':
      return view.actions.done();
    case 'setDate':
      return view.actions.setDate();
    case 'bookmark':
      return view.actions.bookmark();
    case 'why':
      return view.openWhy();
    case 'trash':
      return view.actions.trash();
  }
}

function Overlays({ view }: { readonly view: OneByOne }) {
  const { row, menu, why } = view;
  return (
    <>
      <HomeMenu
        anchor={menu?.anchor ?? null}
        row={row}
        suggestion={row ? suggestionOf(row, view.section) : undefined}
        onSelect={id => {
          view.closeMenu();
          chooseFromMenu(view, id);
        }}
        onClose={view.closeMenu}
      />
      {why ? (
        <WhyHost
          key={why.id}
          target={why}
          current={row?.id ?? null}
          onMove={direction => view.lane(direction)}
          onClose={view.closeWhy}
        />
      ) : null}
      {view.datePicker.element}
    </>
  );
}

/** What the card's buttons do: Home's own actions on the thread showing, so the toasts, Undo and holds are Home's. Reply opens the reader with its reply card up. */
function controlsOf(view: OneByOne): LetterControls {
  const { actions } = view;
  return {
    suggest: () => actions.suggested(),
    later: () => actions.later(),
    done: () => actions.done(),
    bookmark: () => actions.bookmark(),
    trash: () => actions.trash(),
    lane: view.laneTo,
    reply: () => actions.reply(),
    relayKey: relayToShell,
  };
}

function OneByOneBody(props: OneByOneScreenProps) {
  const view = useOneByOne(props);
  const { row } = view;
  // Until the walk has read Do now, show nothing: never a skeleton.
  if (view.failed) return <ListFailed />;
  if (!view.ready) return null;
  if (view.finished)
    return (
      <div className="aplos-one-by-one" data-screen="one-by-one">
        <OneByOneFinish nothing={view.nothingToWalk} onBack={view.exit} />
      </div>
    );
  if (!row) return null;
  return (
    <div className="aplos-one-by-one" data-screen="one-by-one">
      {/* The card's box is where the ⋯ menu, Why and the date presets hang from (`letterOf`); it is one node for every thread, so the stage keeps its buffer. */}
      <div className="aplos-one-by-one__card" id={rowDomId(row.id)} tabIndex={-1}>
        {view.rejected ? (
          <ErrorLine
            kind="writeRejected"
            op={view.rejected.op}
            placement="column"
            onAction={() => view.rejected?.onRetry()}
          />
        ) : null}
        <ReaderStage open={row.id} controls={controlsOf(view)} />
      </div>
      <Overlays view={view} />
    </div>
  );
}

export function OneByOneScreen(props: OneByOneScreenProps) {
  return (
    <Reopenable>
      <OneByOneBody {...props} />
    </Reopenable>
  );
}
