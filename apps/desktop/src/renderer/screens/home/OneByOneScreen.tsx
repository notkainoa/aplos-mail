/**
 * "Go one by one" (DESIGN 7.2, key S): the Do-now threads one at a time, each as the focus letter in a calm, centred
 * pane. J/K move, E, L and Space commit and the walk steps on, Return/O open the thread, Esc goes back to Home. The
 * queue is fixed when the view opens, so mail arriving never changes the thread under view. It is mounted on the shell
 * screen `{ label: 'one by one' }`. The reader lane will replace `OneByOneLetter` with the reader itself.
 */
import { ListFailed } from '../lists/ListStates';
import { Reopenable } from '../lists/Reopenable';
import { HomeMenu, type HomeMenuChoice } from './HomeMenu';
import { OneByOneLetter } from './OneByOneLetter';
import { OneByOneFinish } from './OneByOneStates';
import { useOneByOne, type OneByOne, type OneByOneScreenProps } from './useOneByOne';
import { WhyHost } from './WhyHost';

export type { OneByOneScreenProps } from './useOneByOne';

/** The ⋯ menu's choices, on the thread showing. */
function chooseFromMenu(view: OneByOne, id: HomeMenuChoice): void {
  if (id === 'bookmark') view.actions.bookmark();
  else if (id === 'why') view.openWhy();
  else view.actions.trash();
}

function Overlays({ view }: { readonly view: OneByOne }) {
  const { row, menu, why } = view;
  return (
    <>
      <HomeMenu
        anchor={menu?.anchor ?? null}
        row={row}
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
          onMove={direction => view.lane(direction)}
          onClose={view.closeWhy}
        />
      ) : null}
      {view.datePicker.element}
    </>
  );
}

function OneByOneBody(props: OneByOneScreenProps) {
  const view = useOneByOne(props);
  const { row, actions } = view;
  // Until the walk has read Do now, show nothing: never a skeleton.
  if (view.failed) return <ListFailed />;
  if (!view.ready) return null;
  if (view.finished) return <OneByOneFinish nothing={view.nothingToWalk} onBack={view.exit} />;
  if (!row) return null;
  return (
    <div className="aplos-one-by-one" data-screen="one-by-one">
      <OneByOneLetter
        row={row}
        section={view.section}
        density={view.density}
        rejected={view.rejected}
        onSuggestion={() => actions.suggested()}
        onLater={() => actions.later()}
        onDone={() => actions.done()}
        onMore={view.openMenuAt}
      />
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
