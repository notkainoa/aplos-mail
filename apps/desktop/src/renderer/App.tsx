/**
 * The new app: the shell (`./shell/Shell`) around the screen slot.
 *
 * The slot shows the F9 boot-proof Home for the `home` screen, and a plain placeholder line for every other screen
 * (Later and the lists are `ui-home`'s, the calendar `ui-calendar`'s, Settings `ui-settings`'s). The boot proof reads Home's section
 * labels and counts and the Low importance band from a `home` window on the engine it is given, through the F2 typed
 * client and the contract's types. It talks to the client directly because `ui-home` has not replaced it with
 * `useHome()` yet.
 *
 * Boot-proof debt for U2 (all of it goes away with `useHome`): the band's "and N more" needs the `lowSenders`
 * window's `total` (here it only ever shows the section's up-to-three names); there is no cursor, density setting or
 * Low sheet behind the band; rows are never read.
 */
import { Suspense, useEffect, useMemo, useState } from 'react';
import { ContractError } from '@aplos/contract/contract-error';
import type { StandIn } from './data/standin';
import type { ErrorBody, Frame, HomeSectionKey, WindowBody, WindowSection } from './data';
import { EmptyLine, LowBand, SectionHeader } from './ui/list';
import {
  useAccounts,
  useAccountsLoaded,
  useConnection,
  useCounts,
  useRow,
  useStatus,
} from './data';
import { statusCopy } from './ui/status';
import {
  closeCompose,
  navigate,
  openCompose,
  openThread,
  useAccountScope,
  useComposeRequest,
  useHomeShellProps,
  usePaneHeaderPart,
  type HomeShellProps,
  type Screen,
} from './shell';
import { HomeScreen as HomeRoute, OneByOneScreen } from './screens/home';
import { CalendarScreen } from './screens/calendar';
import { LaterScreen } from './screens/later';
import { ListScreen, type ListWhich, type OpenKind } from './screens/lists';
import { DoneScreen } from './screens/done';
import { ComposeScreen, composeCrumb, composeHeader } from './screens/compose';
import { ReaderScreen } from './screens/reader';
import { SearchScreen } from './screens/search';
import { SettingsMount } from './shell/settingsHost';
import { useRunCommand } from './shell/KeysProviders';
import { Shell } from './shell/Shell';
import { ENGINE_UNREACHABLE_COPY, LIST_FAILED_COPY } from './shell/failure-copy';
import { FirstSyncLine } from './shell/states';
import { ZeroAccounts } from './onboarding/ZeroAccounts';
import { toSyncStatus } from './shell/status-map';

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

/** Inbox zero's line: "You handled 12 emails" (DESIGN 7.14; no trailing period, owner override 2026-11-05). */
export function handledLine(handledToday: number): string {
  return `You handled ${handledToday} ${handledToday === 1 ? 'email' : 'emails'}`;
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

/**
 * The sentence for a failed Home read. It is ours, picked from the error's type: the engine's own message (it can carry
 * provider or mail text) never reaches the screen: an unreachable engine says so, anything else is the list failing to load.
 */
export function failedText(error: Pick<ErrorBody, 'type'>): string {
  return error.type === 'unavailable' ? ENGINE_UNREACHABLE_COPY : LIST_FAILED_COPY;
}

/** The Pane's contents for one `HomeState`: nothing while opening, the error sentence, inbox zero, or the lines. */
export function HomeContent({ home }: HomeContentProps) {
  if (home.status === 'opening') return null;
  if (home.status === 'failed') return <EmptyLine placement="pane" text={failedText(home.error)} />;
  const lines = homeLines(home.window);
  if (lines.every(line => line.count === 0))
    return <EmptyLine placement="pane" size="display" text={handledLine(home.handledToday)} />;
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

/** States where Home must not claim inbox zero: an account is still on its first mail, importing or paused (DESIGN 7.14). */
const SETTLING_STATES: readonly string[] = ['backfilling', 'paused'];

/** True once "no accounts" is a fact: the list has loaded and the engine is not still connecting. */
export function noAccountsKnown(accountsLoaded: boolean, connection: string): boolean {
  return accountsLoaded && connection !== 'connecting';
}

/** The `home` screen: the boot-proof Home, or the first-sync and no-accounts lines where inbox zero would be a lie. */
export function HomeScreen({ client, accountId }: AppProps & Partial<HomeShellProps>) {
  const home = useHomeWindow(client);
  const accounts = useAccounts();
  const accountsLoaded = useAccountsLoaded();
  const connection = useConnection();
  const counts = useCounts(accountId);
  const status = useStatus(accountId);
  if (accounts.length === 0) {
    // Nothing (the neutral state) until it is a fact there are no accounts: not while they load or the engine connects.
    if (!noAccountsKnown(accountsLoaded, connection.state)) return null;
    return <ZeroAccounts />;
  }
  const empty = home.status === 'live' && homeLines(home.window).every(line => line.count === 0);
  const settling = counts.hidden || SETTLING_STATES.includes(status?.status.state ?? '');
  if (empty && settling) {
    const reason = status ? statusCopy(toSyncStatus(status))?.text : undefined;
    return <FirstSyncLine reason={reason} />;
  }
  return <HomeContent home={home} />;
}

/** The new Home in the screen slot, given the account scope and the openers by the shell. */
function HomeSlot() {
  return <HomeRoute {...useHomeShellProps()} />;
}

/** What opening a list row does: a thread opens in the reader, a draft in the compose page, a submission nothing. */
export function listOpener(
  from: Screen,
): (id: string, kind: OpenKind, listIds?: readonly string[]) => void {
  return (id, kind, listIds) => {
    if (kind === 'thread') openThread(id, listIds ? { from, listIds } : { from });
    if (kind === 'draft') openCompose({ draftId: id });
  };
}

/** Home's "Go one by one" in the screen slot: Back, Esc or the end of the walk return to Home. */
function OneByOneSlot() {
  const { accountId, onOpenFromWalk } = useHomeShellProps();
  return (
    <OneByOneScreen
      key={accountId ?? 'all'}
      accountId={accountId}
      onExit={() => navigate('home')}
      onOpen={onOpenFromWalk}
    />
  );
}

/** The scope's account (undefined for All accounts) and the opener every list shares: threads open in the reader, drafts in the compose page; submissions have no opener. */
function useListProps(from: Screen) {
  const scope = useAccountScope();
  const place = typeof from === 'string' ? from : from.label;
  return useMemo(
    () => ({
      accountId: scope ?? undefined,
      onOpen: listOpener(from),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `from` is a new object every render; `place` is its value
    [scope, place],
  );
}

/** The calendar, keyed on the account scope like One by one so a scope change restarts its period and surfaces. */
function CalendarSlot() {
  const scope = useAccountScope();
  return <CalendarScreen key={scope ?? 'all'} accountId={scope ?? undefined} />;
}

function LaterSlot() {
  return <LaterScreen {...useListProps('later')} />;
}

function DoneSlot() {
  return <DoneScreen {...useListProps('done')} />;
}

function ListSlot({ which }: { readonly which: ListWhich }) {
  // Keyed by place, so Trash -> Spam -> All mail never carries an open Confirm or a cursor across.
  return <ListScreen key={JSON.stringify(which)} which={which} {...useListProps(which)} />;
}

/** The compose page: C, the sidebar's New message, a Drafts row and the inline reply's Pop out land here. Esc and × keep the draft and go back. */
function ComposeSlot() {
  const request = useComposeRequest();
  const runCommand = useRunCommand();
  const draft = useRow('Draft', request?.draftId);
  const crumb = composeCrumb({
    forward: request?.forward !== undefined,
    draft,
    draftId: request?.draftId,
  });
  const part = useMemo(
    () => composeHeader({ close: () => runCommand('compose.close'), saved: false, crumb }),
    [runCommand, crumb],
  );
  usePaneHeaderPart(part);
  if (!request) return null;
  return (
    <ComposeScreen
      key={request.seq}
      draftId={request.draftId}
      replyTo={request.replyTo}
      forward={request.forward}
      onClose={closeCompose}
    />
  );
}

/** The Ask dock's host component type, once its chunk has resolved. */
type AskDockHostComponent = typeof import('./screens/ask').AskDockHost;

/**
 * The Ask dock's chunk, split out so this module stays loadable in node tests: the host's own stylesheet import only
 * resolves in the app build. Loaded once, on first call.
 */
let askDockModule: Promise<typeof import('./screens/ask')> | undefined;
function loadAskDockModule(): Promise<typeof import('./screens/ask')> {
  return (askDockModule ??= import('./screens/ask'));
}

const LIST_PLACES: readonly string[] = ['all', 'drafts', 'sent', 'trash', 'spam'];

function isListPlace(screen: string): screen is Exclude<ListWhich, { label: string }> {
  return LIST_PLACES.includes(screen);
}

/** The screen slot: Home, Later, the lists and Done are `ui-home`'s, the reader is `ui-reader`'s (it goes back to where `openThread` recorded), Search is `ui-ask`'s, Settings is `ui-settings`' mounted by `shell/settingsHost`; nothing (so the placeholder) for the rest. */
export function renderScreen(_client: AppClient, screen: Screen) {
  if (typeof screen !== 'string' && screen.label === 'thread') return <ReaderScreen />;
  if (typeof screen !== 'string' && screen.label === 'compose') return <ComposeSlot />;
  if (typeof screen !== 'string' && screen.label === 'Search') return <SearchScreen />;
  if (typeof screen !== 'string' && screen.label === 'one by one') return <OneByOneSlot />;
  if (typeof screen !== 'string') return <ListSlot which={{ label: screen.label }} />;
  if (screen === 'home') return <HomeSlot />;
  if (screen === 'calendar') return <CalendarSlot />;
  if (screen === 'later') return <LaterSlot />;
  if (screen === 'done') return <DoneSlot />;
  if (screen === 'settings') return <SettingsMount />;
  return isListPlace(screen) ? <ListSlot which={screen} /> : undefined;
}

/** The new renderer's root. */
export function App({ client }: AppProps) {
  // The dock chunk resolves once at start-up; until then renderDock returns nothing so the shell mounts no pane.
  // An empty pane for the frame the chunk took would measure zero wide and pop to the dock's width after.
  const [DockHost, setDockHost] = useState<AskDockHostComponent | null>(null);
  useEffect(() => {
    let live = true;
    loadAskDockModule()
      .then(module => {
        if (live) setDockHost(() => module.AskDockHost);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return (
    <Shell
      renderScreen={screen => renderScreen(client, screen)}
      renderDock={(tab, onTab, close) =>
        DockHost ? (
          <Suspense fallback={null}>
            <DockHost tab={tab} onTab={onTab} onClose={close} />
          </Suspense>
        ) : null
      }
    />
  );
}
