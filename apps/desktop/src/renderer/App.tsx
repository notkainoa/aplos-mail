/**
 * The new app (F9 boot proof; `ui-shell` grows it into the shell from day 4).
 *
 * For now it proves the boot path and nothing more: one Pane holding Home's section labels and counts and the Low
 * importance band, read from a `home` window on the engine it is given, through the F2 typed client and the
 * contract's types. It talks to the client directly only because the data hooks are still stubs; U2 replaces this
 * with `useHome()` and the shell.
 *
 * Boot-proof debt for U2 (all of it goes away with `useHome`): the band's "and N more" needs the `lowSenders`
 * window's `total` (here it only ever shows the section's up-to-three names); there is no cursor, density setting or
 * Low sheet behind the band; rows are never read.
 */
import { useEffect, useState } from 'react';
import { ContractError } from '@aplos/contract/contract-error';
import type { StandIn } from './data/standin';
import type { ErrorBody, Frame, HomeSectionKey, WindowBody, WindowSection } from './data';
import { EmptyLine, LowBand, SectionHeader } from './ui/list';
import { Pane } from './ui/surfaces';

/** The typed client the app reads from (the stand-in's today; the real engine's after the switch). */
export type AppClient = StandIn['client'];

/** Props for `App`. */
export interface AppProps {
  /** The connection to the engine. */
  readonly client: AppClient;
}

/** What the Pane shows: opening, the live `home` window with the day's handled count, or the failure. */
export type HomeState =
  | { readonly status: 'opening' }
  | { readonly status: 'live'; readonly window: WindowBody; readonly handledToday: number }
  | { readonly status: 'failed'; readonly error: ErrorBody };

/** DESIGN 7.2's labels for the sections drawn as headers; `fromLater` is the sub-label inside Do now. Low is the band. */
export const SECTION_LABELS: Readonly<Record<Exclude<HomeSectionKey, 'low'>, string>> = {
  do: 'Do now',
  fromLater: 'Back from Later',
  update: 'Important updates',
  follow: 'Follow up',
};

/** One line of the boot-proof Home: a section header, or the one-line Low importance band (DESIGN 7.2). */
export type HomeLine =
  | {
      readonly kind: 'section';
      readonly key: Exclude<HomeSectionKey, 'low'>;
      readonly label: string;
      readonly variant: 'section' | 'sub';
      readonly count: number;
    }
  | { readonly kind: 'low'; readonly count: number; readonly senders: readonly string[] };

const isHeaderKey = (key: string): key is Exclude<HomeSectionKey, 'low'> =>
  Object.hasOwn(SECTION_LABELS, key);

function errorBody(error: unknown): ErrorBody {
  return error instanceof ContractError
    ? error.body
    : { type: 'internal', message: 'Something went wrong. Try again.' };
}

/** Do now's number includes Back from Later (DESIGN 7.2); every other section shows its own count. */
export function sectionCount(section: WindowSection, sections: readonly WindowSection[]): number {
  if (section.key !== 'do') return section.count;
  return section.count + (sections.find(s => s.key === 'fromLater')?.count ?? 0);
}

/** The window's sections as lines, in window order: known header keys as headers, `low` as the band, unknown keys (a newer engine's) skipped. */
export function homeLines(window: WindowBody): HomeLine[] {
  const lines: HomeLine[] = [];
  for (const section of window.sections) {
    if (section.key === 'low') {
      lines.push({ kind: 'low', count: section.count, senders: section.senders ?? [] });
    } else if (isHeaderKey(section.key)) {
      lines.push({
        kind: 'section',
        key: section.key,
        label: SECTION_LABELS[section.key],
        variant: section.key === 'fromLater' ? 'sub' : 'section',
        count: sectionCount(section, window.sections),
      });
    }
  }
  return lines;
}

/** Inbox zero's line: "You handled 12 emails." (DESIGN 7.14). */
export function handledLine(handledToday: number): string {
  return `You handled ${handledToday} ${handledToday === 1 ? 'email' : 'emails'}.`;
}

/**
 * Watches the `home` window on `client` and reports every change through `onChange`. Keeps the latest window frame;
 * on a `reset` frame (another `dbEpoch`, a restore, an engine restart) the window is void, so it opens a new one and
 * keeps the old one on screen until the new one answers; on a `state` frame that touched `Counts` it re-reads the
 * handled count. Returns the function that stops watching.
 */
export function watchHome(client: AppClient, onChange: (state: HomeState) => void): () => void {
  let stopped = false;
  let generation = 0;
  let windowId: string | undefined;
  let current: HomeState = { status: 'opening' };
  const publish = (next: HomeState) => {
    current = next;
    onChange(next);
  };

  const open = () => {
    const mine = ++generation;
    windowId = undefined;
    Promise.all([client.api.view.watch({ spec: { kind: 'home' } }), client.api.counts.get()]).then(
      ([window, counts]) => {
        if (stopped || mine !== generation) {
          void client.api.view.unwatch({ windowId: window.windowId }).catch(() => undefined);
          return;
        }
        windowId = window.windowId;
        publish({ status: 'live', window, handledToday: counts.all.handledToday });
      },
      (error: unknown) => {
        if (!stopped && mine === generation) publish({ status: 'failed', error: errorBody(error) });
      },
    );
  };

  const rereadCounts = () => {
    const mine = generation;
    client.api.counts.get().then(
      counts => {
        if (stopped || mine !== generation || current.status !== 'live') return;
        publish({ ...current, handledToday: counts.all.handledToday });
      },
      () => undefined,
    );
  };

  const onFrame = (frame: Frame) => {
    if (frame.frame === 'window' && frame.windowId === windowId && current.status === 'live') {
      publish({ ...current, window: frame });
    } else if (frame.frame === 'reset') {
      open();
    } else if (frame.frame === 'state' && Object.hasOwn(frame.types, 'Counts')) {
      rereadCounts();
    }
  };

  const unsubscribe = client.subscribe(onFrame);
  open();
  return () => {
    stopped = true;
    unsubscribe();
    if (windowId) void client.api.view.unwatch({ windowId }).catch(() => undefined);
  };
}

/** Watches the `home` window for the component's lifetime. */
function useHomeWindow(client: AppClient): HomeState {
  const [state, setState] = useState<HomeState>({ status: 'opening' });
  useEffect(() => watchHome(client, setState), [client]);
  return state;
}

/** Props for `HomeContent`. */
export interface HomeContentProps {
  /** What `watchHome` last reported. */
  readonly home: HomeState;
}

/** The Pane's contents for one `HomeState`: nothing while opening, the error sentence, inbox zero, or the lines. */
export function HomeContent({ home }: HomeContentProps) {
  if (home.status === 'opening') return null;
  if (home.status === 'failed') return <EmptyLine text={home.error.message} />;
  const lines = homeLines(home.window);
  if (lines.every(line => line.count === 0))
    return <EmptyLine size="display" text={handledLine(home.handledToday)} />;
  return (
    <>
      {lines.map(line =>
        line.kind === 'low' ? (
          <LowBand
            key="low"
            id="home-low"
            senders={line.senders}
            count={line.count}
            cursor={false}
            density="comfortable"
            commandId="mail.open"
            onOpen={() => undefined}
          />
        ) : (
          <SectionHeader
            key={line.key}
            id={`home-${line.key}`}
            label={line.label}
            variant={line.variant}
            count={line.count}
          />
        ),
      )}
    </>
  );
}

/** The new renderer's root. */
export function App({ client }: AppProps) {
  const home = useHomeWindow(client);
  return (
    <Pane kind="main" label="Home">
      <HomeContent home={home} />
    </Pane>
  );
}
