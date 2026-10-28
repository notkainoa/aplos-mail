import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  Check,
  CheckCheck,
  CircleCheck,
  Clock,
  CornerUpLeft,
  ExternalLink,
  FileText,
  Layers,
  MailOpen,
  MessageCircle,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  Trash2,
  WifiOff,
  X,
} from './icons';
import type {
  AppState,
  Attachment,
  CalendarEvent,
  Capabilities,
  Draft,
  Settings as Preferences,
  Thread,
  UpdateInfo,
  View,
} from '@aplos/contract/legacy/types';
import {
  bookmarkLeavesList,
  isBookmark,
  isFollowUp,
  isHomeLow,
  isReplyDue,
  liveAction,
  threadInView,
} from '@aplos/contract/legacy/mailbox';
import { bridge, escapeHtml, invoke, isoDay, openUrl, replyRecipients, uid } from './bridge';
import {
  createLiveState,
  threadOrder,
  type StateChanges,
  type ThreadPage,
} from '@aplos/contract/legacy/live';
import { Compose, addressOf, validAddress, type Contact } from './Compose';
import { Ask } from './Ask';
import { Reader, type CardDrag } from './Reader';
import { Calendar, EventEditor, TodayPanel } from './Calendar';
import { dismissPlans, rememberPlans } from './detectedPlans';
import { Settings } from './Settings';
import { Sidebar, SidebarMenu, sections } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import {
  DraftList,
  MailSection,
  actionIcon,
  highlightTerms,
  nudgeFocus,
  prepareFocusMove,
  useFocusGlide,
  type RowActions,
  type RowHandlers,
  type Triage,
} from './components/MailList';
import { ComposeSkeleton, DuePopover, PendingSends, ShortcutsDialog } from './components/Overlays';
import { Welcome } from './components/Welcome';
import { AppIcon } from './components/AppIcon';
import { appVersion } from '../../shared/version';
import {
  Button,
  Checkbox,
  ConfirmHost,
  EmptyState,
  IconButton,
  Keys,
  Menu,
  Spinner,
  Tabs,
  Toaster,
  confirmAction,
  cx,
  dialogOpen,
  hintExit,
  reducedMotion,
  toast,
  useHandlers,
  useMenu,
  usePresence,
  type Icon,
} from './ui';

const titles: Record<View, string> = {
  home: 'Home',
  later: 'Later',
  all: 'All mail',
  drafts: 'Drafts',
  sent: 'Sent',
  'needs-reply': 'Needs reply',
  'awaiting-reply': 'Awaiting reply',
  trash: 'Trash',
  spam: 'Spam',
  low: 'Low importance',
  calendar: 'Calendar',
  settings: 'Settings',
};
const empties: Partial<Record<View, { icon: Icon; title: string; detail?: string }>> = {
  home: {
    icon: CircleCheck,
    title: 'All clear for now',
    detail: 'New mail that matters will land here.',
  },
  later: {
    icon: Clock,
    title: 'Nothing saved for later',
    detail: 'Press L on an email to keep it as a Todo.',
  },
  drafts: { icon: FileText, title: 'No drafts', detail: 'Press C to start writing.' },
  'needs-reply': { icon: CornerUpLeft, title: 'Nobody is waiting on you' },
  'awaiting-reply': { icon: MessageCircle, title: 'Not waiting on anyone' },
  sent: { icon: Send, title: 'Nothing sent yet' },
  trash: { icon: Trash2, title: 'Trash is empty' },
  spam: { icon: ShieldAlert, title: 'No spam' },
  low: { icon: Layers, title: 'No low-importance mail' },
  all: { icon: MailOpen, title: 'No mail here yet' },
};
const mac = /Mac/.test(navigator.userAgent);
const askStorageKey = 'aplos.askPanel';
const recentSearchKey = 'aplos.recentSearches';
const askExamples = ['What plans do I have this week?', 'Which emails still need a reply?'];
const queryParams = new URLSearchParams(location.search);
const popoutDraft = queryParams.get('draft');
const popoutThread = queryParams.get('thread');
type Route = { view: View; threadId?: string };
const triageLabels: Record<Triage, string> = {
  done: 'Marked done',
  later: 'Moved to Todo',
  trash: 'Moved to Trash',
  spam: 'Moved to Spam',
};
type FlingKind = Triage | 'bookmark';
const noop = () => {};
const noThreads: Thread[] = [];
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

export function App() {
  const [state, setState] = useState<AppState>();
  const [update, setUpdate] = useState<UpdateInfo>();
  const [capabilities, setCapabilities] = useState<Capabilities>({
    groq: false,
    google: false,
    microsoft: false,
    desktop: !!window.aplos,
    version: appVersion,
  });
  const [fatal, setFatal] = useState('');
  const [route, setRoute] = useState<Route>({ view: 'home', threadId: popoutThread ?? undefined });
  const [routes, setRoutes] = useState<Route[]>([{ view: 'home' }]);
  const [historyIndex, setHistoryIndex] = useState(0);
  // Where Escape returns to from Settings: the last place outside it, open thread included.
  const beforeSettings = useRef<Route>({ view: 'home' });
  if (route.view !== 'settings') beforeSettings.current = route;
  const [ask, setAsk] = useState(
    () => !popoutThread && !popoutDraft && localStorage.getItem(askStorageKey) !== 'closed',
  );
  // The dock shows Ask (the default) or Today, one day of every calendar beside the mail.
  const [dockTab, setDockTab] = useState<'ask' | 'today'>('ask');
  const [askTools, setAskTools] = useState<HTMLDivElement | null>(null);
  // A plan the user asked to add (Space or "Add to calendar"): Today shows where it would go and waits for Add.
  const [planReview, setPlanReview] = useState<{
    threadId: string;
    plan?: Partial<CalendarEvent>;
    n: number;
  }>();
  // Matches the CSS breakpoints that collapse the sidebar; while squeezed it opens as an overlay instead.
  const squeezed = useMediaQuery(ask ? '(max-width: 900px)' : '(max-width: 700px)');
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (!squeezed) setPeek(false);
  }, [squeezed]);
  useEffect(() => {
    if (peek)
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>('.sidebar-slot .nav-item.active, .sidebar-slot .nav-item')
          ?.focus(),
      );
  }, [peek]);
  // The draft as typed lives in a ref: keeping it in state re-rendered the whole app on every keystroke.
  const [composer, setComposer] = useState<Draft>();
  const liveDraft = useRef<Draft | undefined>(undefined);
  const setLiveDraft = useCallback((draft?: Draft) => {
    liveDraft.current = draft;
  }, []);
  const [composeClosing, setComposeClosing] = useState(false);
  const [draftBlocked, setDraftBlocked] = useState(false);
  const [laterTab, setLaterTab] = useState<'todos' | 'bookmarks'>('todos');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const [searchResults, setSearchResults] = useState<Thread[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchedFor, setSearchedFor] = useState('');
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const [eventEditor, setEventEditor] = useState<Partial<CalendarEvent> | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState('');
  const [welcome, setWelcome] = useState(false);
  const welcomeChecked = useRef(false);
  const [leaving, setLeaving] = useState<{
    thread: Thread;
    status: FlingKind;
    key: number;
    to: string;
    drag?: CardDrag;
  }>();
  const [entering, setEntering] = useState<{ id: string; from: string }>();
  const [duePrompt, setDuePrompt] = useState<{ id: string; key: number }>();
  const rowMenu = useMenu();
  const [menuThread, setMenuThread] = useState<Thread>();
  const freshDraft = useRef('');
  const talkHeld = useRef(false);
  const spaceHold = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const lastTriage = useRef<{ id: string; status: FlingKind; reopen: boolean } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const eventHandler = useRef<(event: { type: string; payload?: unknown }) => void>(() => {});
  const searchSeq = useRef(0);
  const composeRef = useRef<Draft | undefined>(undefined);
  composeRef.current = composer;
  const undoRef = useRef<() => void>(noop);
  // The one focused row of a list. Unset (or gone) falls back to the row at the last focused position.
  const [cursor, setCursor] = useState<string>();
  const focusAt = useRef(0);
  // The thread whose suggested action is running (an attachment download or a calendar lookup).
  const [actionBusy, setActionBusy] = useState<string>();
  const [previewFile, setPreviewFile] = useState<{ threadId: string; attachmentId: string }>();
  const actionTarget = useRef<string | undefined>(undefined);
  // A focused card that was just triaged keeps its look while it leaves, as the next row opens.
  const [departing, setDeparting] = useState<{ id: string; order: Thread[] }>();
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(recentSearchKey) || '[]');
      return Array.isArray(saved) ? saved.filter(q => typeof q === 'string').slice(0, 5) : [];
    } catch {
      return [];
    }
  });
  const selectAnchor = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const viewNow = useRef(route.view);
  viewNow.current = route.view;
  const workspaceRef = useRef<HTMLElement>(null);
  const workspaceLeft = useRef<number | null>(null);
  const workspaceSlide = useRef<Animation | undefined>(undefined);

  function notify(text: string, undoable = false) {
    toast.show({
      text,
      action: undoable ? { label: 'Undo', shortcut: 'Z', run: () => undoRef.current() } : undefined,
    });
  }
  function fail(error: unknown) {
    toast.show({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
  }
  // The window keeps its own copy of the mailbox: the newest threads first, older ones in pages, then changes as they happen.
  const loadSeq = useRef(0);
  const refreshRef = useRef<(rethrow?: boolean) => Promise<void>>(async () => {});
  // A resync rethrows so the live copy retries with backoff instead of staying behind.
  const live = useMemo(
    () => createLiveState({ update: setState, resync: () => refreshRef.current(true) }),
    [],
  );
  const refresh = useCallback(
    async (rethrow = false) => {
      const seq = ++loadSeq.current;
      try {
        const first = await invoke<AppState>(
          'state.get',
          popoutDraft || popoutThread ? {} : { threadLimit: 400 },
        );
        if (seq !== loadSeq.current) return;
        live.snapshot(first);
        setFatal('');
        let next: { date: string; id: string } | undefined =
          first.threadCount && first.threads.length < first.threadCount
            ? [...first.threads].sort(threadOrder).at(-1)
            : undefined;
        while (next && seq === loadSeq.current) {
          const page = await invoke<ThreadPage>('threads.page', {
            before: { date: next.date, id: next.id },
            limit: 2000,
          });
          if (seq !== loadSeq.current || !live.page(page)) break;
          next = page.next;
        }
      } catch (e) {
        if (seq === loadSeq.current) setFatal((e as Error).message);
        if (rethrow) throw e;
      }
    },
    [live],
  );
  refreshRef.current = refresh;
  useEffect(() => {
    void refresh();
    void invoke<Capabilities>('capabilities.get')
      .then(setCapabilities)
      .catch(() => {});
    void invoke<UpdateInfo>('update.status')
      .then(setUpdate)
      .catch(() => {});
    const unsubscribe = bridge.subscribe(e => eventHandler.current(e));
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    addEventListener('online', up);
    addEventListener('offline', down);
    return () => {
      unsubscribe();
      removeEventListener('online', up);
      removeEventListener('offline', down);
    };
  }, []);
  // The service paces automatic syncs per account, so focusing often is cheap.
  useEffect(() => {
    if (!popoutThread && !popoutDraft) localStorage.setItem(askStorageKey, ask ? 'open' : 'closed');
  }, [ask]);
  // A downloaded update waits for the owner: Restart applies it, Later (or ×) hides it until a manual check.
  const readyVersion =
    update?.status.state === 'ready' && !update.dismissed && !popoutThread && !popoutDraft
      ? update.status.version
      : undefined;
  useEffect(() => {
    if (!readyVersion) {
      toast.dismissKey('update');
      return;
    }
    const later = () => void invoke('update.later').catch(() => {});
    toast.show({
      key: 'update',
      persistent: true,
      text: `Aplos ${readyVersion} is ready`,
      action: { label: 'Restart', run: () => void invoke('update.restart').catch(() => {}) },
      secondary: { label: 'Later', run: later },
      onDismiss: later,
    });
  }, [readyVersion]);
  useEffect(() => {
    const onFocus = () => {
      void invoke('sync', { auto: true }).catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(undefined), 340);
    return () => clearTimeout(t);
  }, [leaving?.key]);
  useEffect(() => {
    if (!departing) return;
    const t = setTimeout(() => setDeparting(undefined), 700);
    return () => clearTimeout(t);
  }, [departing]);
  useEffect(() => {
    if (!duePrompt) return;
    const t = setTimeout(() => setDuePrompt(undefined), 7000);
    return () => clearTimeout(t);
  }, [duePrompt?.key]);
  // The welcome flow opens once, on the first load of a fresh data folder, and again from Settings → Help & about.
  useEffect(() => {
    if (!state || welcomeChecked.current) return;
    welcomeChecked.current = true;
    if (!state.settings.onboardingDone && !popoutThread && !popoutDraft) setWelcome(true);
  }, [state]);
  useEffect(() => {
    const show = () => setWelcome(true);
    addEventListener('aplos:welcome', show);
    return () => removeEventListener('aplos:welcome', show);
  }, []);
  useEffect(() => {
    if (!state) return;
    const theme = state.settings.theme;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      (document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [state?.settings.theme]);
  useEffect(() => {
    if (!popoutDraft || !state || composer || draftBlocked) return;
    const draft = state.drafts.find(d => d.id === popoutDraft);
    if (draft)
      void invoke<boolean>('window.claim', { draftId: draft.id })
        .then(ok => (ok ? setComposer(draft) : setDraftBlocked(true)))
        .catch(e => setFatal(e.message));
  }, [!!state, popoutDraft]);

  const composeExit = useRef<(() => Promise<boolean>) | null>(null);
  /** Going elsewhere closes an open composer first (it asks about anything written); `then` runs only once it has closed. */
  // Clicks made while the composer is deciding replace each other, so only the last one goes anywhere.
  const pendingLeave = useRef<(() => void) | null>(null);
  function leaveCompose(then: () => void) {
    if (!composer || popoutDraft || !composeExit.current) {
      then();
      return;
    }
    const waiting = !!pendingLeave.current;
    pendingLeave.current = then;
    if (waiting) return;
    void composeExit.current().then(
      left => {
        const next = pendingLeave.current;
        pendingLeave.current = null;
        if (left) next?.();
      },
      () => {
        pendingLeave.current = null;
      },
    );
  }
  function navigate(view: View, threadId?: string) {
    leaveCompose(() => {
      const next = { view, threadId };
      setRoute(next);
      setSearchMode(false);
      setSelected(new Set());
      setRoutes(prev => [...prev.slice(0, historyIndex + 1), next]);
      setHistoryIndex(i => i + 1);
    });
  }
  function historyMove(delta: number) {
    const index = historyIndex + delta;
    if (index < 0 || index >= routes.length) return;
    leaveCompose(() => {
      setHistoryIndex(index);
      setRoute(routes[index]);
      setSelected(new Set());
      setSearchMode(false);
    });
  }
  async function updateSettings(patch: Partial<Preferences>) {
    try {
      await invoke('settings.update', { patch });
    } catch (e) {
      fail(e);
    }
  }
  async function patch(ids: string[], p: Partial<Thread>, label?: string, keepTriage = false) {
    if (!keepTriage) lastTriage.current = null;
    try {
      await invoke('thread.update', { ids, patch: p, compact: true });
      if (label) notify(label, true);
      setSelected(new Set());
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }
  async function undo() {
    const last = lastTriage.current;
    lastTriage.current = null;
    setDuePrompt(undefined);
    toast.dismissActions();
    try {
      await invoke('thread.undo', { compact: true });
      if (last?.reopen && !inlineReply) {
        setLeaving(undefined);
        if (!reducedMotion())
          setEntering({
            id: last.id,
            from: last.status === 'done' ? 'right' : last.status === 'later' ? 'left' : 'below',
          });
        setRoute(r => ({ ...r, threadId: last.id }));
      } else {
        notify('Action undone');
        if (last) setCursor(last.id);
      }
    } catch (e) {
      if (/nothing to undo/i.test((e as Error).message)) notify('Nothing to undo');
      else fail(e);
    }
  }
  undoRef.current = () => void undo();
  async function sync() {
    setBusy('sync');
    try {
      await invoke('sync', {
        accountId: state?.selectedAccountId === 'all' ? undefined : state?.selectedAccountId,
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }
  async function openDraft(draft: Draft) {
    try {
      if (draft.pendingSendAt) {
        notify('Undo sending before editing this draft.');
        return;
      }
      if (composer && composer.id !== draft.id) {
        nudgeComposer();
        return;
      }
      const claimed = await invoke<boolean>('window.claim', { draftId: draft.id });
      if (!claimed) {
        notify('This draft is open in another window.');
        return;
      }
      setComposer(draft);
    } catch (e) {
      fail(e);
    }
  }
  async function newDraft(
    proposal: Partial<Draft> = {},
    thread?: Thread,
    mode: Draft['mode'] = 'new',
  ) {
    if (!state) return;
    if (composer) {
      nudgeComposer();
      return;
    }
    const last = thread?.messages.at(-1);
    const a =
      state.accounts.find(a => a.id === (thread?.accountId || state.selectedAccountId)) ||
      state.accounts[0];
    if (!a) {
      notify('Connect an account to write email.');
      return;
    }
    let html = '';
    let to = '';
    let cc = '';
    let subject = '';
    if (thread && last) {
      subject =
        (mode === 'forward' ? 'Fwd: ' : 'Re: ') + thread.subject.replace(/^(Re|Fwd):\s*/i, '');
      if (mode === 'forward')
        html = `<p><br></p><blockquote><p>Forwarded message from ${escapeHtml(last.fromName)} &lt;${escapeHtml(last.from)}&gt;</p><p>${escapeHtml(last.text).replace(/\n/g, '<br>')}</p></blockquote>`;
      else if (mode !== 'new') ({ to, cc } = replyRecipients(thread, a.email, mode));
    }
    const alias =
      a.sendAs?.find(
        sender =>
          thread &&
          last?.to.some(address => address.toLowerCase().includes(sender.email.toLowerCase())),
      ) ||
      a.sendAs?.find(sender => sender.isDefault) ||
      a.sendAs?.find(sender => sender.email === a.email);
    const d: Draft = {
      id: uid(),
      accountId: a.id,
      to,
      cc,
      bcc: '',
      subject,
      html,
      attachments: [],
      mode,
      signature: true,
      ...(a.provider !== 'demo'
        ? {
            fromEmail: alias?.email || a.email,
            signatureSource:
              alias && a.capabilities?.signatures !== false
                ? ('account' as const)
                : ('custom' as const),
          }
        : {}),
      updatedAt: new Date().toISOString(),
      revision: 0,
      ...(thread && mode !== 'forward' ? { threadId: thread.id } : {}),
      ...proposal,
    };
    setBusy(thread && mode !== 'forward' ? 'reply' : 'draft');
    try {
      if (thread && mode === 'forward')
        d.attachments = await Promise.all(
          thread.messages.at(-1)!.attachments.map(a =>
            a.data
              ? Promise.resolve(a)
              : invoke<import('@aplos/contract/legacy/types').Attachment>('attachment.get', {
                  threadId: thread.id,
                  attachmentId: a.id,
                }),
          ),
        );
      const saved = await invoke<Draft>('draft.save', { draft: d });
      freshDraft.current = saved.id;
      await openDraft(saved);
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }
  function nudgeComposer() {
    dispatchEvent(new Event('aplos:compose-nudge'));
    notify('Finish or close this draft to start another.');
  }
  function closeCompose() {
    const id = composer?.id;
    const done = () => {
      setComposer(undefined);
      setLiveDraft(undefined);
      setComposeClosing(false);
      if (id) void invoke('window.release', { draftId: id }).catch(() => {});
      if (popoutDraft) window.close();
    };
    if (!inlineReply && !popoutDraft && !reducedMotion()) {
      setComposeClosing(true);
      setTimeout(done, 150);
    } else done();
  }
  async function searchMail(value: string) {
    const seq = ++searchSeq.current;
    if (!value.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const result = await invoke<Thread[]>('search', {
        query: value,
        accountId: state?.selectedAccountId,
      });
      if (searchSeq.current === seq) {
        setSearchResults(result);
        setSearchedFor(value);
      }
    } catch (e) {
      if (searchSeq.current === seq) fail(e);
    } finally {
      if (searchSeq.current === seq) setSearching(false);
    }
  }
  useEffect(() => {
    if (!searchMode) return;
    const t = setTimeout(() => void searchMail(search), 250);
    return () => clearTimeout(t);
  }, [search, searchMode, state?.selectedAccountId]);
  const scoped = useMemo(
    () =>
      state?.threads
        .filter(t => state.selectedAccountId === 'all' || t.accountId === state.selectedAccountId)
        .sort((a, b) => b.date.localeCompare(a.date)) ?? [],
    [state?.threads, state?.selectedAccountId],
  );
  const filtered = useMemo(() => {
    if (searchMode) return searchResults;
    const v = route.view;
    return scoped.filter(t => threadInView(t, v, laterTab));
  }, [scoped, route.view, laterTab, searchMode, searchResults]);
  // People this mailbox has exchanged mail with, most frequent first, for recipient suggestions.
  const contacts = useMemo(() => {
    const own = new Set(
      state?.accounts
        .flatMap(a => [a.email, ...(a.sendAs ?? []).map(s => s.email)])
        .map(e => e.toLowerCase()),
    );
    const seen = new Map<string, Contact & { count: number; last: string }>();
    const add = (raw: string, name: string, date: string) => {
      const email = addressOf(raw);
      const key = email.toLowerCase();
      if (!validAddress(email) || own.has(key)) return;
      const named = name || /^\s*"?([^"<]+?)"?\s*</.exec(raw)?.[1] || '';
      const entry = seen.get(key);
      if (entry) {
        entry.count++;
        if (date > entry.last) entry.last = date;
        if (!entry.name && named) entry.name = named;
      } else seen.set(key, { email, name: named, count: 1, last: date });
    };
    for (const t of state?.threads ?? [])
      for (const m of t.messages) {
        add(m.from, m.fromName, m.date);
        for (const to of [...m.to, ...(m.cc ?? [])]) add(to, '', m.date);
      }
    return [...seen.values()]
      .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
      .map(({ email, name }) => ({ email, name }));
  }, [state?.threads, state?.accounts]);
  const buckets = useMemo(() => {
    const today = isoDay();
    const later = scoped.filter(t => t.status === 'later');
    return {
      today,
      later,
      low: scoped.filter(isHomeLow),
      homeLater: later.filter(t => !t.hiddenFromHome && (!t.dueDate || t.dueDate <= today)),
      replyHome: scoped.filter(isReplyDue),
      followUps: scoped.filter(t => isFollowUp(t)),
    };
  }, [scoped]);
  const todoGroups = useMemo(() => {
    const today = buckets.today;
    const dated = filtered
      .filter(t => t.dueDate)
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
    return {
      overdue: dated.filter(t => t.dueDate! < today),
      today: dated.filter(t => t.dueDate!.slice(0, 10) === today),
      upcoming: dated.filter(t => t.dueDate!.slice(0, 10) > today),
      undated: filtered.filter(t => !t.dueDate),
    };
  }, [filtered, buckets.today]);
  // The order rows appear on screen, so j/k, ⇧-click ranges and the reader stack all walk the same sequence.
  const order = useMemo(() => {
    if (searchMode) return filtered;
    if (route.view === 'home')
      return [...filtered, ...buckets.homeLater, ...buckets.replyHome, ...buckets.followUps];
    if (route.view === 'later' && laterTab === 'todos')
      return [
        ...todoGroups.overdue,
        ...todoGroups.today,
        ...todoGroups.upcoming,
        ...todoGroups.undated,
      ];
    return filtered;
  }, [filtered, buckets, todoGroups, route.view, laterTab, searchMode]);
  const orderIndex = useMemo(() => new Map(order.map((t, i) => [t.id, i])), [order]);
  // When the focused row leaves (triage elsewhere, sync), the focus stays at the same place in the list.
  const cursorIndex = cursor === undefined ? -1 : (orderIndex.get(cursor) ?? -1);
  const focusIndex = order.length
    ? cursorIndex >= 0
      ? cursorIndex
      : Math.min(focusAt.current, order.length - 1)
    : -1;
  if (focusIndex >= 0) focusAt.current = focusIndex;
  const focused = focusIndex >= 0 ? order[focusIndex] : undefined;
  const focusId = focused?.id;
  // Mail that stays listed after the action (e.g. Done in All mail) just closes back into a line.
  useEffect(() => {
    if (departing && departing.order !== order && orderIndex.has(departing.id))
      setDeparting(undefined);
  }, [order]);
  const searchHints = useMemo(() => {
    if (!searchMode) return [];
    const hints: string[] = [];
    const counts = new Map<string, number>();
    for (const t of scoped)
      for (const m of t.messages)
        if (!m.sent) {
          const first = (m.fromName || m.from).split(/[\s@]/)[0].toLowerCase();
          if (first) counts.set(first, (counts.get(first) ?? 0) + 1);
        }
    if (scoped.some(t => t.unread)) hints.push('is:unread');
    if (scoped.some(t => t.messages.some(m => m.attachments.length))) hints.push('has:attachment');
    if (scoped.some(t => t.bookmarked)) hints.push('is:bookmarked');
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (top) hints.push('from:' + top[0]);
    return hints;
  }, [scoped, searchMode]);
  const selectedThread =
    state?.threads.find(t => t.id === route.threadId) ||
    searchResults.find(t => t.id === route.threadId);
  const readerIndex = Math.max(
    0,
    order.findIndex(t => t.id === route.threadId),
  );
  // Today stays on the plan being reviewed until the user moves to another email or closes the dock.
  const followedId = (
    selectedThread ?? (!['settings', 'calendar'].includes(route.view) ? focused : undefined)
  )?.id;
  useEffect(() => {
    setPlanReview(r => (r && followedId && followedId !== r.threadId ? undefined : r));
  }, [followedId]);
  useEffect(() => {
    if (!ask) setPlanReview(undefined);
  }, [ask]);
  // What a slow suggested action (calendar extraction) should still be about when it finishes.
  actionTarget.current = selectedThread?.id ?? focusId;
  // A preview request belongs to one visit of its thread.
  useEffect(() => {
    if (previewFile && previewFile.threadId !== route.threadId) setPreviewFile(undefined);
  }, [route.threadId]);
  const inlineReply =
    !!composer &&
    !!selectedThread &&
    !popoutDraft &&
    !popoutThread &&
    composer.threadId === selectedThread.id &&
    composer.mode !== 'new' &&
    composer.mode !== 'forward';
  function openThread(id: string) {
    if (inlineReply && id === selectedThread?.id) return;
    leaveCompose(() => {
      setRoute(r => ({ ...r, threadId: id }));
      const t = state?.threads.find(t => t.id === id);
      if (t?.unread)
        void invoke('thread.update', {
          ids: [id],
          patch: { unread: false },
          recordUndo: false,
          compact: true,
        }).catch(fail);
    });
  }
  function nextThread(delta: number) {
    const next = order[readerIndex + delta];
    if (next) openThread(next.id);
  }
  // Focus moves glide (see MailList `useFocusGlide`); the ends of the list give a small bump instead of wrapping.
  function moveCursor(delta: number, repeat = false) {
    if (!order.length) return;
    const next = focusIndex + delta;
    if (next < 0 || next >= order.length) {
      if (!repeat) nudgeFocus(delta);
      return;
    }
    prepareFocusMove('key', order[next].id, repeat);
    setCursor(order[next].id);
  }
  /** Space on a focused email: the AI-suggested step, from presets only. Nothing is sent or saved without a click. */
  async function runAction(thread: Thread) {
    const action = liveAction(thread);
    if (!action || action.kind === 'read') {
      openThread(thread.id);
      return;
    }
    if (action.kind === 'link' && action.url) {
      try {
        await openUrl(action.url);
      } catch (e) {
        fail(e);
      }
      return;
    }
    if (action.kind === 'reply') {
      if (composer) {
        nudgeComposer();
        return;
      }
      openThread(thread.id);
      void newDraft({}, thread, state?.settings.defaultReply);
      return;
    }
    // Attachments open in the reader's preview first; leaving Aplos stays an explicit click there.
    if (action.kind === 'attachment') {
      setPreviewFile({ threadId: thread.id, attachmentId: action.attachmentId! });
      openThread(thread.id);
      return;
    }
    await findEvent(thread, () => actionTarget.current === thread.id);
  }
  /** Groq finds the plan in an email and the editor opens on it; nothing is saved until the user does. */
  async function findEvent(thread: Thread, stillHere: () => boolean) {
    if (actionBusy) {
      if (actionBusy !== thread.id) notify('Still finding the last event. One moment.');
      return;
    }
    setActionBusy(thread.id);
    try {
      const events = await invoke<Partial<CalendarEvent>[]>('calendar.extract', {
        threadId: thread.id,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      rememberPlans(thread.id, events);
      const event = events[0];
      if (!event) notify('No event with a clear date and time was found.');
      // Extraction takes a moment; if the user has moved on, offer the event instead of opening over their work.
      else if (stillHere() && !composeRef.current) reviewPlan(thread.id, event);
      else
        toast.show({
          text: `Event ready: ${event.title || thread.subject}`,
          action: { label: 'Review', run: () => reviewPlan(thread.id, event) },
        });
    } catch (e) {
      fail(e);
    } finally {
      setActionBusy(undefined);
    }
  }
  /** Today in the dock shows where the plan would go, beside the mail, and waits for Add. A popped-out window has no dock, so it gets the editor. */
  function reviewPlan(threadId: string, plan: Partial<CalendarEvent>) {
    if (popoutThread || popoutDraft) {
      setEventEditor(plan);
      return;
    }
    dismissPlans(threadId, false);
    setPlanReview(r => ({ threadId, plan, n: (r?.n ?? 0) + 1 }));
    setDockTab('today');
    setAsk(true);
  }
  /** Today's "Find it": Groq looks for the plan and Today draws it beside the mail; nothing opens or saves. */
  async function findPlans(thread: Thread) {
    if (actionBusy) return;
    setActionBusy(thread.id);
    try {
      const events = await invoke<Partial<CalendarEvent>[]>('calendar.extract', {
        threadId: thread.id,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      rememberPlans(thread.id, events);
      if (!events.length) notify('No event with a clear date and time was found.');
    } catch (e) {
      fail(e);
    } finally {
      setActionBusy(undefined);
    }
  }
  /** ⇧A opens the dock on Today, or closes it when Today is already showing. */
  function toggleToday() {
    if (popoutThread || popoutDraft) return;
    if (ask && dockTab === 'today') setAsk(false);
    else {
      setDockTab('today');
      setAsk(true);
    }
  }
  function selectRow(thread: Thread, how: 'toggle' | 'range' = 'toggle') {
    const anchor = selectAnchor.current;
    const from = anchor ? order.findIndex(t => t.id === anchor) : -1;
    const to = order.findIndex(t => t.id === thread.id);
    setSelected(prev => {
      const next = new Set(prev);
      if (how === 'range' && from >= 0 && to >= 0) {
        for (const t of order.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(t.id);
      } else next.has(thread.id) ? next.delete(thread.id) : next.add(thread.id);
      return next;
    });
    selectAnchor.current = thread.id;
  }
  function exitDirection(status: Triage) {
    const doneLeft = state?.settings.triageDirection === 'done-left';
    return status === 'done'
      ? doneLeft
        ? 'left'
        : 'right'
      : status === 'later'
        ? doneLeft
          ? 'right'
          : 'left'
        : 'down';
  }
  function triage(thread: Thread, status: Triage, drag?: CardDrag) {
    const current = thread.id === selectedThread?.id;
    hintExit(thread.id, exitDirection(status));
    // The stack dock has its own undo button, so the toast would only cover it.
    // Mail that is already done (a reply or follow-up on Home) leaves Home instead.
    void patch(
      [thread.id],
      status === 'done' && thread.status === 'done' ? { hiddenFromHome: true } : { status },
      current ? undefined : triageLabels[status],
      true,
    );
    lastTriage.current = { id: thread.id, status, reopen: current };
    setDuePrompt(status === 'later' ? { id: thread.id, key: Date.now() } : undefined);
    setEntering(undefined);
    // Right after an undo the reopened thread may not be back in the list yet, so fall back to its date position.
    const at = order.findIndex(t => t.id === thread.id);
    const following =
      at >= 0
        ? order[at + 1] || order[at - 1]
        : order.find(t => t.date <= thread.date) || order.at(-1);
    if (!current) {
      if (focusId === thread.id) {
        setDeparting({ id: thread.id, order });
        setCursor(following?.id);
      }
      return;
    }
    if (!reducedMotion())
      setLeaving({ thread, status, key: Date.now(), to: exitDirection(status), drag });
    if (following && following.id !== thread.id) setRoute(r => ({ ...r, threadId: following.id }));
    else setRoute(r => ({ ...r, threadId: undefined }));
    if (following?.unread)
      void invoke('thread.update', {
        ids: [following.id],
        patch: { unread: false },
        recordUndo: false,
        compact: true,
      }).catch(() => {});
  }
  function toggleBookmark(thread: Thread) {
    const next = !thread.bookmarked;
    const leaves = !searchMode && bookmarkLeavesList(thread, next, route.view, laterTab);
    const current = thread.id === selectedThread?.id;
    if (leaves) hintExit(thread.id, 'down');
    const label = next ? 'Saved to Bookmarks' : 'Removed from Bookmarks';
    void patch([thread.id], { bookmarked: next }, leaves && current ? undefined : label, leaves);
    if (!leaves) return;
    lastTriage.current = { id: thread.id, status: 'bookmark', reopen: current };
    setEntering(undefined);
    const at = order.findIndex(t => t.id === thread.id);
    const following =
      at >= 0
        ? order[at + 1] || order[at - 1]
        : order.find(t => t.date <= thread.date) || order.at(-1);
    if (!current) {
      if (focusId === thread.id) {
        setDeparting({ id: thread.id, order });
        setCursor(following?.id);
      }
      return;
    }
    if (!reducedMotion()) setLeaving({ thread, status: 'bookmark', key: Date.now(), to: 'down' });
    if (following && following.id !== thread.id) setRoute(r => ({ ...r, threadId: following.id }));
    else setRoute(r => ({ ...r, threadId: undefined }));
    if (following?.unread)
      void invoke('thread.update', {
        ids: [following.id],
        patch: { unread: false },
        recordUndo: false,
        compact: true,
      }).catch(() => {});
  }
  function bulk(status: Triage | 'new', label: string) {
    const ids = [...selected];
    for (const id of ids) hintExit(id, status === 'new' ? 'down' : exitDirection(status));
    if (focusId && selected.has(focusId))
      setCursor(
        (
          order.slice(focusIndex + 1).find(t => !selected.has(t.id)) ||
          order
            .slice(0, focusIndex)
            .reverse()
            .find(t => !selected.has(t.id))
        )?.id,
      );
    void patch(ids, { status }, `${label} · ${ids.length} email${ids.length === 1 ? '' : 's'}`);
  }
  function talk(phase: 'start' | 'release') {
    if (phase === 'start') {
      if (talkHeld.current || !selectedThread) return;
      talkHeld.current = true;
      const release = () => {
        removeEventListener('pointerup', release);
        talk('release');
      };
      addEventListener('pointerup', release);
      void newDraft({}, selectedThread, state?.settings.defaultReply);
    } else if (talkHeld.current) {
      talkHeld.current = false;
      dispatchEvent(new Event('aplos:talk-release'));
    }
  }
  async function setDue(id: string, dueDate: string, label: string) {
    setDuePrompt(undefined);
    try {
      await invoke('thread.update', {
        ids: [id],
        patch: { dueDate },
        recordUndo: false,
        compact: true,
      });
      notify(label);
    } catch (e) {
      fail(e);
    }
  }
  function openSearch() {
    leaveCompose(() => {
      setSearchMode(true);
      setRoute(r => ({ ...r, threadId: undefined }));
      setTimeout(() => searchInput.current?.focus(), 20);
    });
  }
  function closeSearch() {
    setSearchMode(false);
    setSearch('');
  }
  function rememberSearch(query: string) {
    const value = query.trim();
    if (!value) return;
    setRecentSearches(prev => {
      const next = [value, ...prev.filter(q => q !== value)].slice(0, 5);
      localStorage.setItem(recentSearchKey, JSON.stringify(next));
      return next;
    });
  }
  function searchKeys(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (search) setSearch('');
      else closeSearch();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveCursor(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const target = focused;
      if (target) {
        e.preventDefault();
        rememberSearch(search);
        openThread(target.id);
      }
    }
  }
  function command(command: string) {
    if (command.startsWith('thread:')) {
      navigate('all', command.slice(7));
      return;
    }
    switch (command) {
      case 'compose':
        void newDraft();
        break;
      case 'settings':
        navigate('settings');
        break;
      case 'search':
        openSearch();
        break;
      case 'ask':
        if (!popoutThread && !popoutDraft) {
          if (ask && dockTab === 'ask') setAsk(false);
          else {
            setDockTab('ask');
            setAsk(true);
          }
        }
        break;
      case 'today':
        toggleToday();
        break;
      case 'shortcuts':
        setShortcutHelp(true);
        break;
      case 'toggle-sidebar':
        if (state?.settings.sidebarStyle === 'minimized') {
          document.querySelector<HTMLElement>('.sidebar-menu-trigger')?.click();
          break;
        }
        if (squeezed) setPeek(v => !v);
        else void updateSettings({ sidebar: !state?.settings.sidebar });
        break;
      case 'back':
        historyMove(-1);
        break;
      case 'forward':
        historyMove(1);
        break;
      case 'refresh':
        void sync();
        break;
      case 'undo':
        void undo();
        break;
      default:
        if (sections.some(s => s.view === command)) navigate(command as View);
    }
  }
  eventHandler.current = event => {
    if (event.type === 'state') live.snapshot(event.payload as AppState);
    else if (event.type === 'changes') live.apply(event.payload as StateChanges);
    else if (event.type === 'prepare-close') {
      if (!composeRef.current) void invoke('window.closeReady').catch(() => {});
    } else if (event.type === 'command') command(String(event.payload));
    else if (event.type === 'update') setUpdate(event.payload as UpdateInfo);
    else if (event.type === 'deep-link') {
      try {
        const url = new URL(String(event.payload));
        if (url.protocol === 'mailto:')
          void newDraft({
            to: decodeURIComponent(url.pathname),
            subject: url.searchParams.get('subject') || '',
            html: escapeHtml(url.searchParams.get('body') || '').replace(/\n/g, '<br>'),
            cc: url.searchParams.get('cc') || '',
            bcc: url.searchParams.get('bcc') || '',
          });
        else if (url.host === 'compose')
          void newDraft({
            to: url.searchParams.get('to') || '',
            subject: url.searchParams.get('subject') || '',
            html: escapeHtml(url.searchParams.get('body') || ''),
          });
        else if (url.host === 'settings') navigate('settings');
        else if (url.host === 'thread') navigate('all', decodeURIComponent(url.pathname.slice(1)));
      } catch {
        notify('That link could not be opened.');
      }
    } else if (event.type === 'sent') {
      notify('Message sent');
      if ((event.payload as { playSound?: boolean })?.playSound) {
        try {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.setValueAtTime(540, ctx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(810, ctx.currentTime + 0.12);
          gain.gain.setValueAtTime(0.035, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
          osc.start();
          osc.stop(ctx.currentTime + 0.23);
          osc.onended = () => void ctx.close();
        } catch {
          /* no sound without audio permission */
        }
      }
    } else if (event.type === 'send-error' || event.type === 'error')
      toast.show({
        tone: 'error',
        text:
          typeof event.payload === 'string'
            ? event.payload
            : (event.payload as { message?: string })?.message || 'Something needs your attention.',
      });
    else if (event.type === 'reminder')
      notify('Reminder: ' + (event.payload as { title: string }).title);
  };
  useEffect(() => {
    function keyboard(e: KeyboardEvent) {
      const element = e.target as HTMLElement;
      const typing =
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
      // A control reached with the keyboard keeps Space, Enter and arrows for itself; mouse clicks leave no :focus-visible.
      const control =
        !!element.closest?.(
          'button,a[href],[role=tab],[role=option],[role=menuitem],[role=checkbox]',
        ) &&
        !element.closest('.row-content') &&
        element.matches(':focus-visible') &&
        [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key);
      if (dialogOpen()) return;
      if (e.key === 'Escape' && squeezed && peek) {
        e.preventDefault();
        setPeek(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && ['k', 'j', ',', '/'].includes(e.key)) {
        e.preventDefault();
        command(
          e.key === 'k'
            ? 'search'
            : e.key === 'j'
              ? 'ask'
              : e.key === ','
                ? 'settings'
                : 'shortcuts',
        );
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key) && !composer) {
        const section = sections[Number(e.key) - 1];
        if (section) {
          e.preventDefault();
          navigate(section.view);
        }
        return;
      }
      if (e.key === 'Escape' && route.view === 'settings' && !composer && !eventEditor) {
        e.preventDefault();
        if (typing) element.blur();
        else navigate(beforeSettings.current.view, beforeSettings.current.threadId);
        return;
      }
      if (composer || eventEditor || typing || control) return;
      if (e.key === 'Escape') {
        setDuePrompt(undefined);
        if (selected.size) {
          setSelected(new Set());
          return;
        }
        if (selectedThread) setRoute(r => ({ ...r, threadId: undefined }));
        else if (searchMode) {
          setSearchMode(false);
          setSearch('');
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !selectedThread && order.length) {
        e.preventDefault();
        setSelected(new Set(order.map(t => t.id)));
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        toggleToday();
        return;
      }
      const t = selectedThread;
      const pointed = !t && !['settings', 'calendar'].includes(route.view) ? focused : undefined;
      const subject = t || pointed;
      // Trash only offers Restore and Spam adds Done and Trash, so the other triage, reply and action keys stay quiet there. Undo (Z) still works.
      const binned = subject?.status === 'trash' || subject?.status === 'spam';
      if (e.key === ' ' && t) {
        if (binned) return;
        e.preventDefault();
        if (e.repeat || spaceHold.current) return;
        const hold: { timer?: ReturnType<typeof setTimeout>; fired: boolean } = { fired: false };
        hold.timer = setTimeout(() => {
          hold.fired = true;
          talk('start');
        }, 300);
        spaceHold.current = hold;
        return;
      }
      const keys: Record<string, () => void> = {
        c: () => void newDraft(),
        '/': () => command('search'),
        '?': () => setShortcutHelp(true),
        '[': () => command('toggle-sidebar'),
        z: () => void undo(),
        s: () => {
          const first = pointed || order[0];
          if (first) openThread(first.id);
        },
      };
      // Arrow keys keep scrolling the message while the reader is open.
      if (t) {
        keys.j = () => nextThread(1);
        keys.k = () => nextThread(-1);
      } else if (!['settings', 'calendar'].includes(route.view)) {
        keys.j = keys.ArrowDown = () => moveCursor(1, e.repeat);
        keys.k = keys.ArrowUp = () => moveCursor(-1, e.repeat);
      }
      // The focused row: Space, Enter or O opens it, R replies in the reader, S starts the stack from the top.
      // Space runs the suggested action (or opens); Enter and O always open the email.
      if (pointed && !binned) {
        keys[' '] = () => {
          if (!e.repeat) void runAction(pointed);
        };
        keys.r = () => {
          openThread(pointed.id);
          void newDraft({}, pointed, state?.settings.defaultReply);
        };
        keys.R = () => {
          openThread(pointed.id);
          void newDraft(
            {},
            pointed,
            state?.settings.defaultReply === 'reply-all' ? 'reply' : 'reply-all',
          );
        };
        keys.f = () => void newDraft({}, pointed, 'forward');
      }
      if (pointed) {
        keys.Enter = keys.o = () => openThread(pointed.id);
        keys.x = () => selectRow(pointed, e.shiftKey ? 'range' : 'toggle');
        keys.X = keys.x;
        keys.s = () => openThread(order[0].id);
        keys['.'] = () => {
          const more = document.querySelector<HTMLElement>(
            `.mail-row[data-thread-id="${CSS.escape(pointed.id)}"] .card-more`,
          );
          if (more) {
            setMenuThread(pointed);
            rowMenu.openAt(more);
          }
        };
      }
      if (subject && !binned) {
        const doneLeft = state?.settings.triageDirection === 'done-left';
        keys.e = () => triage(subject, 'done');
        keys.l = () => triage(subject, 'later');
        keys.b = () => toggleBookmark(subject);
        keys.u = () => void patch([subject.id], { unread: !subject.unread });
        keys['#'] = () => triage(subject, 'trash');
        keys.ArrowLeft = () => triage(subject, doneLeft ? 'done' : 'later');
        keys.ArrowRight = () => triage(subject, doneLeft ? 'later' : 'done');
      }
      if (subject?.status === 'spam') {
        keys.e = () => triage(subject, 'done');
        keys['#'] = () => triage(subject, 'trash');
      }
      if (t && !binned) {
        keys.r = () => void newDraft({}, t, state?.settings.defaultReply);
        keys.R = () =>
          void newDraft(
            {},
            t,
            state?.settings.defaultReply === 'reply-all' ? 'reply' : 'reply-all',
          );
        keys.f = () => void newDraft({}, t, 'forward');
      }
      if (keys[e.key]) {
        e.preventDefault();
        keys[e.key]();
      }
    }
    function keyup(e: KeyboardEvent) {
      if (e.key !== ' ') return;
      const hold = spaceHold.current;
      if (!hold) return;
      spaceHold.current = null;
      clearTimeout(hold.timer);
      if (hold.fired) talk('release');
      else if (selectedThread && !composer)
        void newDraft({}, selectedThread, state?.settings.defaultReply);
    }
    addEventListener('keydown', keyboard);
    addEventListener('keyup', keyup);
    return () => {
      removeEventListener('keydown', keyboard);
      removeEventListener('keyup', keyup);
    };
  });
  const bulkBar = usePresence(selected.size > 0);
  const listShown = !popoutThread && !selectedThread;
  const listKey = (searchMode ? 'search' : route.view) + (route.view === 'later' ? laterTab : '');
  useEffect(() => {
    if (route.threadId) setCursor(route.threadId);
  }, [route.threadId]);
  useLayoutEffect(() => {
    setCursor(route.threadId);
    focusAt.current = 0;
    selectAnchor.current = null;
  }, [listKey]);
  // Writing scrollTop forces a synchronous layout of the new view, so skip it when the list is already at the top.
  useLayoutEffect(() => {
    if (listRef.current && listScroll.current) listRef.current.scrollTop = 0;
    listScroll.current = 0;
  }, [listKey]);
  // In stack mode the list unmounts behind the reader; put it back where it was before scrolling to the cursor.
  useLayoutEffect(() => {
    if (listShown && listRef.current) listRef.current.scrollTop = listScroll.current;
  }, [listShown]);
  // When the sidebar shows or hides, the workspace jumps to its new place once and then slides there from the
  // old one with a transform, in step with the sidebar's own CSS slide.
  useLayoutEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const left = el.offsetLeft,
      prev = workspaceLeft.current;
    workspaceLeft.current = left;
    if (prev === null || prev === left || reducedMotion()) return;
    workspaceSlide.current?.cancel();
    workspaceSlide.current = el.animate(
      [{ transform: `translateX(${prev - left}px)` }, { transform: 'none' }],
      { duration: 200, easing: 'cubic-bezier(.16,1,.3,1)' },
    );
  }, [!!state, squeezed, peek, state?.settings.sidebar, state?.settings.sidebarStyle]);
  // Keep the focused card at a steady place and glide between cards.
  useFocusGlide(listRef, focusId, listShown);

  // Derived data and stable handlers for the memoized panes. Cursor moves, hovers and typing then re-render
  // only what changed instead of the sidebar, Ask and every row.
  const highlight = useMemo(
    () => (searchMode ? highlightTerms(search) : undefined),
    [searchMode, search],
  );
  const drafts = useMemo(
    () =>
      state?.drafts.filter(
        d =>
          !d.pendingSendAt &&
          (state.selectedAccountId === 'all' || d.accountId === state.selectedAccountId),
      ) ?? [],
    [state?.drafts, state?.selectedAccountId],
  );
  const pending = useMemo(() => state?.drafts.filter(d => d.pendingSendAt) ?? [], [state?.drafts]);
  const counts = useMemo(() => {
    return {
      home:
        scoped.filter(t => t.status === 'new' && !t.bookmarked).length + buckets.homeLater.length,
      later: buckets.later.length,
      drafts: drafts.length,
    } as Partial<Record<View, number>>;
  }, [scoped, buckets, drafts]);
  const rowActions = useHandlers<RowActions>({
    open: t => {
      if (searchMode) rememberSearch(search);
      openThread(t.id);
    },
    select: (t, how) => selectRow(t, how),
    triage: (t, status) => triage(t, status),
    bookmark: t => toggleBookmark(t),
    restore: t => {
      hintExit(t.id, 'down');
      void patch([t.id], { status: 'new' }, 'Restored to Home');
    },
    more: (t, anchor) => {
      setMenuThread(t);
      rowMenu.openAt(anchor);
    },
    focus: t => {
      prepareFocusMove('pointer', t.id);
      setCursor(t.id);
    },
    run: t => void runAction(t),
  });
  const sidebarActions = useHandlers({
    navigate: (view: View) => {
      setPeek(false);
      navigate(view);
    },
    back: () => historyMove(-1),
    forward: () => historyMove(1),
    sync: () => void sync(),
    hide: () => {
      if (squeezed) setPeek(false);
      else void updateSettings({ sidebar: false });
    },
    // The Calendar stays open and filters to the chosen account; mail views start again from its Home.
    selectAccount: (id: string) => {
      void invoke('account.select', { id }).catch(fail);
      if (id !== 'all' && route.view !== 'calendar') setRoute({ view: 'home' });
    },
    shortcuts: () => {
      setPeek(false);
      setShortcutHelp(true);
    },
    onError: (error: Error) => fail(error),
  });
  const topbarActions = useHandlers({
    showSidebar: () => {
      if (squeezed) setPeek(true);
      else void updateSettings({ sidebar: true });
    },
    back: () => leaveCompose(() => setRoute(r => ({ ...r, threadId: undefined }))),
    compose: () => void newDraft(),
    ask: () => {
      setDockTab('ask');
      setAsk(true);
    },
    calendar: () => {
      setDockTab('today');
      setAsk(true);
    },
  });
  const calendarActions = useHandlers({
    edit: (event: Partial<CalendarEvent>) => setEventEditor(event),
    onThread: (id: string) => navigate('all', id),
    onSchedule: (thread: Thread) => void findEvent(thread, () => viewNow.current === 'calendar'),
    onHidden: (keys: string[]) => void updateSettings({ hiddenCalendars: keys }),
  });
  // Emails whose suggested step is a calendar event that is not on a calendar yet.
  const calendarSuggestions = useMemo(
    () =>
      !state || route.view !== 'calendar'
        ? noThreads
        : state.threads.filter(
            t =>
              (state.selectedAccountId === 'all' || t.accountId === state.selectedAccountId) &&
              !['trash', 'spam'].includes(t.status) &&
              liveAction(t)?.kind === 'calendar' &&
              !state.events.some(e => e.threadId === t.id),
          ),
    [state?.threads, state?.events, state?.selectedAccountId, route.view],
  );
  const todayActions = useHandlers({
    edit: (event: Partial<CalendarEvent>) => setEventEditor(event),
    onThread: (id: string) => navigate('all', id),
    onFind: (thread: Thread) => void findPlans(thread),
  });
  const askActions = useHandlers({
    onOpen: () => {
      setDockTab('ask');
      setAsk(true);
    },
    onClose: () => setAsk(false),
    onSearch: (query: string) =>
      leaveCompose(() => {
        setSearch(query);
        setSearchMode(true);
        setRoute(r => ({ ...r, threadId: undefined }));
      }),
    onCommand: (name: string) => command(name),
    onEditEvent: (event: Partial<CalendarEvent>) => setEventEditor(event),
    onThread: (id: string) => navigate('all', id),
    notify: (text: string) => notify(text),
    // A reply proposal opens against its email, like Reply does.
    onDraft: (draft: Partial<Draft>) => {
      const thread = draft.threadId ? state?.threads.find(t => t.id === draft.threadId) : undefined;
      void newDraft(draft, thread, thread ? (draft.mode ?? 'reply') : 'new');
    },
    currentContext: () => ({
      view: route.view,
      threadId: actionTarget.current,
      selectedIds: [...selected].slice(0, 50),
    }),
    currentDraft: () => liveDraft.current || composer,
    onApplyDraft: (p: Partial<Draft>) => {
      if (!composer) return;
      const base = liveDraft.current || composer;
      setComposer({
        ...base,
        ...p,
        id: composer.id,
        accountId: composer.accountId,
        mode: composer.mode,
        threadId: composer.threadId,
        attachments: base.attachments,
        revision: base.revision,
        updatedAt: new Date().toISOString(),
      });
    },
  });

  if (!state)
    return (
      <div className="loading-screen">
        <AppIcon size={72} />
        <h2>{fatal ? 'Aplos needs a moment.' : 'Making room for your mail…'}</h2>
        {fatal ? (
          <>
            <p>{fatal}</p>
            <Button variant="primary" onClick={() => void refresh()}>
              Try again
            </Button>
            <p className="small muted">For browser development, run npm run dev.</p>
          </>
        ) : (
          <Spinner size={20} className="muted" />
        )}
      </div>
    );

  const prefs = state.settings;
  const { low, later, homeLater, replyHome, followUps, today } = buckets;
  const heading = { title: searchMode ? 'Search' : titles[route.view], count: filtered.length };
  const replySlot =
    inlineReply && composer ? (
      <Compose
        key={composer.id}
        inline
        exitRef={composeExit}
        draft={composer}
        accounts={state.accounts}
        settings={prefs}
        thread={selectedThread}
        close={closeCompose}
        notify={notify}
        onChange={setLiveDraft}
        contacts={contacts}
        fresh={freshDraft.current === composer.id}
        holdToTalk={() => talkHeld.current}
        suggestion={
          selectedThread?.action?.kind === 'reply' ? selectedThread.action.prompt : undefined
        }
      />
    ) : busy === 'reply' && !composer ? (
      <div className="compose-inline">
        <ComposeSkeleton />
      </div>
    ) : undefined;
  // A plan found in the reader goes to Today for review; a saved event opens in the editor.
  const readerProps = {
    settings: prefs,
    editEvent: (event: Partial<CalendarEvent>) => {
      if (event.threadId && !event.id) reviewPlan(event.threadId, event);
      else setEventEditor(event);
    },
    events: state.events,
    notify,
    undo: () => void undo(),
    talk,
    heading,
  };
  // The suggested step also sits in the reader's AI card; there Space keeps replying, so it shows no key.
  const openAction = selectedThread && liveAction(selectedThread);
  const suggested = openAction && openAction.kind !== 'read' ? openAction : undefined;
  const readerAction = suggested && selectedThread && (
    <Button
      size="sm"
      variant="tinted"
      className="reader-suggested"
      icon={actionIcon(suggested.kind)}
      loading={actionBusy === selectedThread.id}
      onClick={() => void runAction(selectedThread)}
    >
      {suggested.label}
    </Button>
  );
  const reader = selectedThread && (
    <Reader
      key={selectedThread.id}
      {...readerProps}
      thread={selectedThread}
      index={readerIndex}
      total={order.length}
      back={() => {
        if (popoutThread) window.close();
        else leaveCompose(() => setRoute(r => ({ ...r, threadId: undefined })));
      }}
      patch={patch}
      restore={() =>
        void patch([selectedThread.id], { status: 'new' }, 'Restored to Home').then(ok => {
          if (ok) navigate('home', selectedThread.id);
        })
      }
      triage={(status, drag) => triage(selectedThread, status, drag)}
      bookmark={() => toggleBookmark(selectedThread)}
      reply={mode => void newDraft({}, selectedThread, mode)}
      standalone={!!popoutThread}
      replySlot={replySlot}
      previewId={previewFile?.threadId === selectedThread.id ? previewFile.attachmentId : undefined}
      entering={entering?.id === selectedThread.id ? entering.from : undefined}
      action={readerAction}
    />
  );
  const ghost = leaving && (
    <div
      key={leaving.key}
      className={cx(
        'fling',
        'fling-' + leaving.status,
        'fling-to-' + leaving.to,
        leaving.drag && 'is-dragged',
      )}
      style={
        leaving.drag &&
        ({
          '--from-x': leaving.drag.x + 'px',
          '--from-r': ((leaving.drag.x / leaving.drag.width) * 6).toFixed(2) + 'deg',
        } as React.CSSProperties)
      }
      aria-hidden="true"
    >
      <Reader
        ghost
        {...readerProps}
        thread={leaving.thread}
        index={0}
        total={1}
        back={noop}
        patch={async () => {}}
        triage={noop}
        reply={noop}
      />
    </div>
  );
  const doneLeft = prefs.triageDirection === 'done-left';
  // Beside an open reader the list only marks the open row; the card would repeat what the reader shows.
  const rows: RowHandlers = {
    activeId: route.threadId,
    cursorId: selectedThread ? undefined : focusId,
    departingId: departing?.id,
    busyId: actionBusy,
    indexOf: orderIndex,
    selected,
    doneLeft,
    highlight,
    swipe: prefs.swipe,
    actions: rowActions,
  };
  const group = (
    title: string,
    threads: Thread[],
    action?: React.ReactNode,
    showCount = true,
    plain = false,
  ) => (
    <MailSection
      key={title}
      title={title}
      threads={threads}
      action={action}
      showCount={showCount}
      rows={rows}
      plain={plain}
    />
  );
  const titled = (title: string, body: React.ReactNode) => (
    <section className="mail-section">
      <header>
        <h2>{title}</h2>
      </header>
      {body}
    </section>
  );
  const emptyFor = (view: View) => {
    const spec = searchMode
      ? { icon: Search, title: 'No matches yet', detail: 'Try fewer words, or a sender’s name.' }
      : (empties[view] ?? { title: 'Nothing here' });
    return <EmptyState icon={spec.icon} title={spec.title} detail={spec.detail} />;
  };

  if (popoutDraft)
    return (
      <>
        <div className="popout-titlebar" />
        {composer ? (
          <Compose
            draft={composer}
            accounts={state.accounts}
            settings={prefs}
            thread={state.threads.find(t => t.id === composer.threadId)}
            close={closeCompose}
            notify={notify}
            onChange={setLiveDraft}
            contacts={contacts}
            popout
            fresh={freshDraft.current === composer.id}
          />
        ) : (
          <div className="loading-screen">
            <h2>
              {draftBlocked
                ? 'This draft is open in another window.'
                : 'This draft is no longer available.'}
            </h2>
            <Button onClick={() => window.close()}>Close window</Button>
          </div>
        )}
        <Toaster />
        <ConfirmHost />
      </>
    );

  const syncing = busy === 'sync' || state.sync.busy;
  const listView = !['settings', 'calendar'].includes(route.view);
  // Today follows the email that is open, or the one the list cursor is on.
  const todayThread =
    (planReview && state.threads.find(t => t.id === planReview.threadId)) ||
    selectedThread ||
    (listView ? focused : undefined);
  const swipe = (
    <Button
      variant="pill"
      icon={Layers}
      shortcut="S"
      onClick={() => {
        if (order[0]) openThread(order[0].id);
      }}
    >
      Swipe through them
    </Button>
  );
  const composerLayer = !!composer && !inlineReply;
  // Minimized, the sidebar is gone and its contents live in a menu at the top left.
  const minimized = prefs.sidebarStyle === 'minimized' && !popoutThread;
  const sidebarHidden = !!popoutThread || minimized || (squeezed ? !peek : !prefs.sidebar);
  const peeking = squeezed && peek && !popoutThread && !minimized;
  const view = route.view;
  // Bulk actions follow what is selected (search can mix folders): Trash only restores, Spam also takes Done and Trash.
  const picked = state.threads.filter(t => selected.has(t.id));
  const pickedTrash = picked.some(t => t.status === 'trash'),
    pickedSpam = picked.some(t => t.status === 'spam'),
    pickedMail = picked.some(t => t.status !== 'trash' && t.status !== 'spam');
  const thread = menuThread;

  let list: React.ReactNode;
  if (searchMode)
    list = search ? (
      filtered.length ? (
        group(
          `${filtered.length} result${filtered.length === 1 ? '' : 's'}`,
          filtered,
          undefined,
          false,
        )
      ) : (
        !searching && searchedFor === search && emptyFor(view)
      )
    ) : (
      <EmptyState
        compact
        icon={Search}
        title="Search your mail"
        detail="Senders, subjects and the words inside your messages."
      />
    );
  else if (view === 'home')
    list = (
      <>
        {group('New', filtered, swipe)}
        {low.length > 0 && (
          <button
            className="low-line"
            data-flip="low-line"
            style={{ '--i': filtered.length - 0.5 } as React.CSSProperties}
            onClick={() => navigate('low')}
          >
            <span className="low-count">{low.length}</span>
            <strong>Low importance</strong>
            <small>{[...new Set(low.map(t => t.messages[0].fromName))].join(', ')}</small>
          </button>
        )}
        {group(
          'Ready when you are',
          homeLater,
          <Button
            variant="text"
            onClick={() => {
              for (const t of homeLater) hintExit(t.id, 'down');
              void invoke('home.hide', { ids: homeLater.map(t => t.id), compact: true })
                .then(() => notify(`Hid ${homeLater.length} from Home. They stay in Later.`))
                .catch(fail);
            }}
          >
            Hide all
          </Button>,
        )}
        {group('Waiting on you', replyHome)}
        {group('No reply yet', followUps)}
        {!filtered.length &&
          !low.length &&
          !homeLater.length &&
          !replyHome.length &&
          !followUps.length &&
          emptyFor('home')}
      </>
    );
  else if (view === 'drafts')
    list = titled(
      'Drafts',
      drafts.length ? (
        <DraftList
          drafts={drafts}
          open={d => void openDraft(d)}
          remove={async d => {
            if (
              !(await confirmAction({
                title: 'Delete this draft?',
                message: 'It will be removed from this device and from your account’s drafts.',
                confirmLabel: 'Delete',
                danger: true,
              }))
            )
              return;
            hintExit(d.id, 'down');
            void invoke('draft.delete', { id: d.id }).catch(fail);
          }}
        />
      ) : (
        emptyFor('drafts')
      ),
    );
  else if (view === 'later' && laterTab === 'todos')
    list = (
      <>
        {group('Overdue', todoGroups.overdue)}
        {group('Today', todoGroups.today)}
        {group('Upcoming', todoGroups.upcoming)}
        {group('No due date', todoGroups.undated)}
        {!filtered.length && emptyFor('later')}
      </>
    );
  else {
    const title = view === 'later' ? 'Bookmarks' : titles[view];
    list = filtered.length
      ? group(
          title,
          filtered,
          view === 'low' ? (
            <Button
              variant="pill"
              icon={CheckCheck}
              onClick={() => {
                for (const t of filtered) hintExit(t.id, exitDirection('done'));
                void patch(
                  filtered.map(t => t.id),
                  { status: 'done' },
                  'Low-importance mail marked done',
                );
              }}
            >
              Mark all done
            </Button>
          ) : undefined,
          false,
          view === 'later',
        )
      : titled(
          title,
          view === 'later' ? (
            <EmptyState
              icon={Bookmark}
              title="No bookmarks"
              detail="Press B on an email to save it here. It leaves Home until you remove the bookmark."
            />
          ) : (
            emptyFor(view)
          ),
        );
  }

  return (
    <div
      className={cx(
        'app-shell',
        window.aplos && 'desktop',
        mac && 'mac',
        sidebarHidden && 'sidebar-hidden',
        peeking && 'sidebar-peek',
        ask && !popoutThread && 'with-ask',
      )}
    >
      {peeking && <div className="sidebar-scrim" onPointerDown={() => setPeek(false)} />}
      {!popoutThread && !minimized && (
        <div
          className="sidebar-slot"
          inert={sidebarHidden || undefined}
          onKeyDown={e => {
            if (peeking && e.key === 'Escape') {
              e.stopPropagation();
              setPeek(false);
            }
          }}
        >
          <Sidebar
            state={state}
            view={searchMode ? null : route.view}
            counts={counts}
            zen={prefs.zen}
            online={online}
            syncing={syncing}
            canBack={historyIndex > 0}
            canForward={historyIndex < routes.length - 1}
            {...sidebarActions}
          />
        </div>
      )}
      <main className="workspace" ref={workspaceRef}>
        <Topbar
          menu={
            minimized && (
              <SidebarMenu
                state={state}
                view={searchMode ? null : route.view}
                counts={counts}
                zen={prefs.zen}
                online={online}
                syncing={syncing}
                navigate={sidebarActions.navigate}
                sync={sidebarActions.sync}
                selectAccount={sidebarActions.selectAccount}
                shortcuts={sidebarActions.shortcuts}
                onError={sidebarActions.onError}
              />
            )
          }
          showSidebarButton={sidebarHidden && !popoutThread}
          showBack={!!selectedThread && !popoutThread}
          showActions={!popoutThread}
          showAsk={!ask}
          composeBusy={busy === 'draft' || busy === 'reply'}
          {...topbarActions}
        />
        {state.sync.error && (
          <div className="sync-error">
            <WifiOff size={14} />
            <span>{state.sync.error}</span>
            <Button variant="text" size="sm" onClick={() => void sync()}>
              Retry
            </Button>
          </div>
        )}
        <div className="content-layout">
          {listShown && view === 'calendar' && (
            <Calendar
              events={state.events}
              accounts={state.accounts}
              accountId={state.selectedAccountId}
              hidden={prefs.hiddenCalendars}
              suggestions={calendarSuggestions}
              busyId={actionBusy}
              paused={!!composer || shortcutHelp}
              {...calendarActions}
            />
          )}
          {listShown && view !== 'calendar' && (
            <div
              className="mail-content"
              ref={listRef}
              onScroll={e => {
                listScroll.current = e.currentTarget.scrollTop;
              }}
            >
              {view === 'settings' ? (
                <Settings
                  state={state}
                  capabilities={capabilities}
                  update={update}
                  onUpdate={setUpdate}
                  onChange={p => void updateSettings(p)}
                  notify={notify}
                  shortcuts={() => setShortcutHelp(true)}
                />
              ) : (
                <div
                  className={cx(
                    'mail-view',
                    view === 'later' && laterTab === 'bookmarks' && 'bookmarks-view',
                    view === 'home' && !searchMode && !selectedThread && 'focus-fade',
                  )}
                  style={{ '--f': Math.max(0, focusIndex) } as React.CSSProperties}
                  key={(searchMode ? 'search' : view) + (view === 'later' ? laterTab : '')}
                >
                  {searchMode && (
                    <div className="search-heading">
                      <div className="search-box">
                        <Search size={17} />
                        <input
                          ref={searchInput}
                          autoFocus
                          placeholder="Search your mail"
                          aria-label="Search mail query"
                          value={search}
                          onChange={e => setSearch(e.target.value)}
                          onKeyDown={searchKeys}
                        />
                        {searching && <Spinner size={16} />}
                        <IconButton
                          label="Close search"
                          shortcut="Esc"
                          icon={X}
                          onClick={closeSearch}
                        />
                      </div>
                      {!search && recentSearches.length > 0 && (
                        <p className="search-hints">
                          <span>Recent</span>
                          {recentSearches.map(hint => (
                            <button
                              key={hint}
                              onClick={() => {
                                setSearch(hint);
                                searchInput.current?.focus();
                              }}
                            >
                              {hint}
                            </button>
                          ))}
                        </p>
                      )}
                      {searchHints.length > 0 && (
                        <p className="search-hints">
                          <span>Try</span>
                          {searchHints.map(hint => (
                            <button
                              key={hint}
                              className={search === hint ? 'is-active' : undefined}
                              onClick={() => {
                                setSearch(hint);
                                searchInput.current?.focus();
                              }}
                            >
                              {hint}
                            </button>
                          ))}
                        </p>
                      )}
                      {search && filtered.length > 0 && (
                        <p className="search-hints search-keys">
                          <Keys combo="↑" />
                          <Keys combo="↓" /> to move, <Keys combo="↩" /> to open
                        </p>
                      )}
                    </div>
                  )}
                  {view === 'later' && !searchMode && (
                    <Tabs
                      variant="underline"
                      label="Later groups"
                      className="later-tabs"
                      value={laterTab}
                      onChange={setLaterTab}
                      items={[
                        { id: 'todos', label: 'Todos', icon: CircleCheck, count: later.length },
                        {
                          id: 'bookmarks',
                          label: 'Bookmarks',
                          icon: Bookmark,
                          count: scoped.filter(isBookmark).length,
                        },
                      ]}
                    />
                  )}
                  {bulkBar.mounted && (
                    <div className={cx('bulk-toolbar ui-surface', bulkBar.closing && 'is-closing')}>
                      <Checkbox
                        checked={selected.size === order.length && order.length > 0}
                        indeterminate={selected.size > 0 && selected.size < order.length}
                        label={`${selected.size || 1} selected`}
                        onChange={on => setSelected(new Set(on ? order.map(t => t.id) : []))}
                      />
                      <div className="actions">
                        {!pickedMail && (pickedTrash || pickedSpam) && (
                          <Button
                            variant="ghost"
                            icon={RotateCcw}
                            onClick={() => bulk('new', 'Restored to Home')}
                          >
                            Restore
                          </Button>
                        )}
                        {!pickedTrash && (
                          <Button
                            variant="ghost"
                            icon={Check}
                            onClick={() => bulk('done', 'Marked done')}
                          >
                            Done
                          </Button>
                        )}
                        {!pickedTrash && !pickedSpam && (
                          <Button
                            variant="ghost"
                            icon={Clock}
                            onClick={() => bulk('later', 'Moved to Todo')}
                          >
                            Todo
                          </Button>
                        )}
                        {!pickedTrash && (
                          <IconButton
                            label="Move selected to Trash"
                            icon={Trash2}
                            onClick={() => bulk('trash', 'Moved to Trash')}
                          />
                        )}
                        <IconButton
                          label="Clear selection"
                          shortcut="Esc"
                          icon={X}
                          onClick={() => setSelected(new Set())}
                        />
                      </div>
                    </div>
                  )}
                  {list}
                </div>
              )}
            </div>
          )}
          {reader}
          {ghost}
        </div>
        {composerLayer && composer && (
          <Compose
            key={composer.id}
            exitRef={composeExit}
            draft={composer}
            accounts={state.accounts}
            settings={prefs}
            thread={state.threads.find(t => t.id === composer.threadId)}
            close={closeCompose}
            notify={notify}
            onChange={setLiveDraft}
            contacts={contacts}
            fresh={freshDraft.current === composer.id}
            closing={composeClosing}
            holdToTalk={() => talkHeld.current}
          />
        )}
        {busy === 'draft' && !composer && (
          <div className="compose-layer">
            <ComposeSkeleton />
          </div>
        )}
        <DuePopover
          prompt={duePrompt}
          setDue={(id, day, label) => void setDue(id, day, label)}
          dismiss={() => setDuePrompt(undefined)}
        />
      </main>
      {!popoutThread && (
        <div className={cx('ask-dock', ask && 'open')} inert={!ask || undefined}>
          <div className="dock-panel">
            <div className="dock-head">
              <div className="dock-head-start">
                <Tabs
                  variant="segmented"
                  label="Dock"
                  className="dock-tabs"
                  value={dockTab}
                  onChange={setDockTab}
                  items={[
                    {
                      id: 'ask',
                      label: 'Ask',
                      tooltip: { title: 'Ask me anything', detail: 'Tap A · ⌘ J' },
                    },
                    {
                      id: 'today',
                      label: 'Calendar',
                      tooltip: { title: 'Calendar beside your mail', detail: '⇧ A' },
                    },
                  ]}
                />
                <div className="dock-head-tools" ref={setAskTools} />
              </div>
              <IconButton label="Close" shortcut="⌘ J" icon={X} onClick={() => setAsk(false)} />
            </div>
            <div className="dock-body" hidden={dockTab !== 'ask'}>
              <Ask
                open={ask && dockTab === 'ask'}
                toolsSlot={dockTab === 'ask' ? askTools : null}
                conversations={state.conversations}
                threads={state.threads}
                events={state.events}
                accounts={state.accounts}
                contacts={contacts}
                accountId={state.selectedAccountId}
                settings={prefs}
                examples={askExamples}
                hasDraft={!!composer}
                {...askActions}
              />
            </div>
            {dockTab === 'today' && (
              <div className="dock-body">
                <TodayPanel
                  events={state.events}
                  accounts={state.accounts}
                  accountId={state.selectedAccountId}
                  hidden={prefs.hiddenCalendars}
                  thread={todayThread}
                  review={planReview?.threadId === todayThread?.id ? planReview : undefined}
                  finding={!!todayThread && actionBusy === todayThread.id}
                  {...todayActions}
                />
              </div>
            )}
          </div>
        </div>
      )}
      <Menu
        open={rowMenu.open}
        anchor={rowMenu.anchor}
        onClose={rowMenu.close}
        placement="bottom-end"
        label="Email actions"
        onError={fail}
        groups={
          thread
            ? [
                [
                  {
                    label: 'Open in separate window',
                    icon: ExternalLink,
                    onSelect: () => invoke('window.thread', { threadId: thread.id }),
                  },
                ],
                [
                  {
                    label: 'Mark ' + (thread.unread ? 'read' : 'unread'),
                    icon: MailOpen,
                    keys: 'U',
                    onSelect: () => patch([thread.id], { unread: !thread.unread }),
                  },
                  {
                    label: thread.bookmarked ? 'Remove bookmark' : 'Save to Bookmarks',
                    icon: Bookmark,
                    keys: 'B',
                    onSelect: () => toggleBookmark(thread),
                  },
                  {
                    label:
                      thread.importance === 'important'
                        ? 'Move to Low importance'
                        : 'Mark important',
                    icon: Layers,
                    onSelect: () =>
                      patch(
                        [thread.id],
                        { importance: thread.importance === 'important' ? 'low' : 'important' },
                        thread.importance === 'important'
                          ? 'Moved to Low importance'
                          : 'Marked important',
                      ),
                  },
                  {
                    label:
                      thread.replyStatus === 'needs-reply' ? 'Clear Needs reply' : 'Needs my reply',
                    icon: CornerUpLeft,
                    onSelect: () =>
                      patch([thread.id], {
                        replyStatus: thread.replyStatus === 'needs-reply' ? 'none' : 'needs-reply',
                      }),
                  },
                ],
                [
                  {
                    label: 'Move to Spam',
                    icon: ShieldAlert,
                    onSelect: () => triage(thread, 'spam'),
                  },
                  {
                    label: 'Move to Trash',
                    icon: Trash2,
                    keys: '#',
                    danger: true,
                    onSelect: () => triage(thread, 'trash'),
                  },
                ],
              ]
            : []
        }
      />
      {eventEditor && (
        <EventEditor
          key={eventEditor.id || eventEditor.title || 'new'}
          event={eventEditor}
          accounts={state.accounts}
          onClose={() => setEventEditor(null)}
          notify={notify}
        />
      )}
      <ShortcutsDialog
        open={shortcutHelp}
        close={() => setShortcutHelp(false)}
        doneLeft={doneLeft}
        minimized={minimized}
      />
      <Welcome
        open={welcome && !popoutThread}
        capabilities={capabilities}
        settings={prefs}
        notify={notify}
        onSettings={patch => void updateSettings(patch)}
        onFinish={() => {
          setWelcome(false);
          if (!prefs.onboardingDone) void updateSettings({ onboardingDone: true });
        }}
      />
      <PendingSends
        drafts={pending}
        seconds={prefs.undoSeconds}
        undo={async d => {
          try {
            await invoke('draft.undoSend', { id: d.id });
            notify('Send cancelled. Your draft is safe.');
          } catch (e) {
            fail(e);
          }
        }}
      />
      <Toaster />
      <ConfirmHost />
    </div>
  );
}
