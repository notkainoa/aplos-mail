/**
 * The new app (F9 boot proof; `ui-shell` grows it into the shell from day 4).
 *
 * For now it proves the boot path and nothing more: one Pane holding Home's section labels and counts, read from a
 * `home` window on the engine it is given, through the F2 typed client and the contract's types. It talks to the
 * client directly only because the data hooks are still stubs; U2 replaces this with `useHome()` and the shell.
 */
import { useEffect, useState } from 'react';
import { ContractError } from '@aplos/contract/contract-error';
import type { StandIn } from './data/standin';
import type { ErrorBody, HomeSectionKey, WindowBody, WindowSection } from './data';
import { EmptyLine, SectionHeader } from './ui/list';
import { Pane } from './ui/surfaces';

/** The typed client the app reads from (the stand-in's today; the real engine's after the switch). */
export type AppClient = StandIn['client'];

/** Props for `App`. */
export interface AppProps {
  /** The connection to the engine. */
  readonly client: AppClient;
}

type HomeState =
  | { readonly status: 'opening' }
  | { readonly status: 'live'; readonly window: WindowBody; readonly handledToday: number }
  | { readonly status: 'failed'; readonly error: ErrorBody };

/** DESIGN 7.2's section labels; `fromLater` is the sub-label inside Do now. */
const LABELS: Readonly<Record<HomeSectionKey, string>> = {
  do: 'Do now',
  fromLater: 'Back from Later',
  update: 'Important updates',
  low: 'Low importance',
  follow: 'Follow up',
};

const isHomeKey = (key: string): key is HomeSectionKey => Object.hasOwn(LABELS, key);

function errorBody(error: unknown): ErrorBody {
  return error instanceof ContractError
    ? error.body
    : { type: 'internal', message: 'Something went wrong. Try again.' };
}

/** Do now's number includes Back from Later (DESIGN 7.2); every other section shows its own count. */
function sectionCount(section: WindowSection, sections: readonly WindowSection[]): number {
  if (section.key !== 'do') return section.count;
  return section.count + (sections.find(s => s.key === 'fromLater')?.count ?? 0);
}

/** Watches the `home` window and keeps the latest window frame. */
function useHomeWindow(client: AppClient): HomeState {
  const [state, setState] = useState<HomeState>({ status: 'opening' });
  useEffect(() => {
    let alive = true;
    let windowId: string | undefined;
    let handledToday = 0;
    const stop = client.subscribe(frame => {
      if (frame.frame === 'window' && frame.windowId === windowId)
        setState({ status: 'live', window: frame, handledToday });
    });
    Promise.all([client.api.view.watch({ spec: { kind: 'home' } }), client.api.counts.get()]).then(
      ([window, counts]) => {
        if (!alive) {
          void client.api.view.unwatch({ windowId: window.windowId });
          return;
        }
        windowId = window.windowId;
        handledToday = counts.all.handledToday;
        setState({ status: 'live', window, handledToday });
      },
      (error: unknown) => {
        if (alive) setState({ status: 'failed', error: errorBody(error) });
      },
    );
    return () => {
      alive = false;
      stop();
      if (windowId) void client.api.view.unwatch({ windowId });
    };
  }, [client]);
  return state;
}

/** The new renderer's root. */
export function App({ client }: AppProps) {
  const home = useHomeWindow(client);
  let content = null;
  if (home.status === 'failed') {
    content = <EmptyLine text={home.error.message} />;
  } else if (home.status === 'live') {
    const sections = home.window.sections.filter(s => isHomeKey(s.key));
    content =
      sections.length === 0 ? (
        <EmptyLine
          size="display"
          text={`You handled ${home.handledToday} ${home.handledToday === 1 ? 'email' : 'emails'}.`}
        />
      ) : (
        sections.map(section => (
          <SectionHeader
            key={section.key}
            id={`home-${section.key}`}
            label={LABELS[section.key as HomeSectionKey]}
            variant={section.key === 'fromLater' ? 'sub' : 'section'}
            count={sectionCount(section, sections)}
          />
        ))
      );
  }
  return (
    <Pane kind="main" label="Home">
      {content}
    </Pane>
  );
}
