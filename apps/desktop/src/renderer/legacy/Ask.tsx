import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CalendarDays,
  Clock,
  CornerDownLeft,
  FileText,
  Gear,
  History,
  Home,
  Keyboard,
  MessageCircle,
  Plus,
  Search,
  Square,
  SquarePen,
  X,
} from './icons';
import {
  Avatar,
  IconButton,
  Kbd,
  Keys,
  Menu,
  Notice,
  Spinner,
  Tooltip,
  confirmAction,
  cx,
  dialogOpen,
  useMenu,
  type Icon,
} from './ui';
import type {
  Account,
  AskStep,
  CalendarEvent,
  Conversation,
  Draft,
  Settings,
  Thread,
} from '@aplos/contract/legacy/types';
import { bridge, dateLabel, invoke, uid } from './bridge';
import { askModelLabel } from '@aplos/contract/legacy/ask';
import { AskDraftCard, AskSources, AskSteps, AskTriageCard, Prose } from './AskAnswer';
import { useVoice } from './useVoice';
import { LevelMeter } from './LevelMeter';
import { Marked } from './components/MailList';
import { AskEvent } from './AskEvent';
import { showSettingsTab } from './Settings';
import type { Contact } from './Compose';

// The one event type the dock hears (see the subscribe below).
const ASK_EVENTS = { only: ['ai.progress'] } as const;
const holdDelay = 220;
// Emails opened from Ask, newest first: picked from its matches or clicked in an answer.
const openedKey = 'aplos.askOpened';
const openedLimit = 20;
function loadOpened() {
  try {
    const saved = JSON.parse(localStorage.getItem(openedKey) || '[]');
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === 'string').slice(0, openedLimit)
      : [];
  } catch {
    return [];
  }
}
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
type Props = {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSearch: (query: string) => void;
  onCommand: (command: string) => void;
  conversations: Conversation[];
  threads: Thread[];
  events: CalendarEvent[];
  accounts: Account[];
  contacts: Contact[];
  accountId: string;
  settings: Settings;
  examples: string[];
  onThread: (id: string) => void;
  onDraft: (draft: Partial<Draft>) => void;
  notify: (t: string) => void;
  currentDraft: () => Draft | undefined;
  hasDraft: boolean;
  onApplyDraft: (proposal: Partial<Draft>) => void;
  onEditEvent: (event: Partial<CalendarEvent>) => void;
  /** What the user is looking at, so "summarize this" needs no search. */
  currentContext: () => { view: string; threadId?: string; selectedIds?: string[] };
  /** The dock header beside the Ask/Calendar tabs, where Ask puts New chat and Recent chats. */
  toolsSlot?: HTMLElement | null;
};
/** The answer being written: streamed text, tool steps and the sources cited so far. */
type Live = { text: string; steps: AskStep[]; cites: string[] };
type Item = {
  key: string;
  group?: string;
  icon?: React.ReactNode;
  remove?: () => void;
  label: React.ReactNode;
  detail?: React.ReactNode;
  keys?: string;
  run: () => void;
};
const commands: { id: string; label: string; icon: Icon; keys?: string; words?: string }[] = [
  { id: 'compose', label: 'Compose', icon: SquarePen, keys: 'C', words: 'new email write' },
  { id: 'home', label: 'Go to Home', icon: Home, keys: '⌃ 1', words: 'inbox' },
  { id: 'later', label: 'Go to Later', icon: Clock, keys: '⌃ 2', words: 'todo bookmarks' },
  {
    id: 'calendar',
    label: 'Go to Calendar',
    icon: CalendarDays,
    keys: '⌃ 6',
    words: 'events schedule plans',
  },
  { id: 'drafts', label: 'Go to Drafts', icon: FileText, keys: '⌃ 4' },
  {
    id: 'settings',
    label: 'Go to Settings',
    icon: Gear,
    keys: '⌘ ,',
    words: 'preferences accounts',
  },
  { id: 'search', label: 'Search all mail', icon: Search, keys: '/', words: 'find' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, keys: '?', words: 'help keys' },
];

// The typed character, so layouts other than QWERTY use the key labelled A.
const isA = (event: KeyboardEvent) => event.key.toLowerCase() === 'a';
const inScope = (accountId: string) => (t: Thread) =>
  (accountId === 'all' || t.accountId === accountId) && t.status !== 'trash' && t.status !== 'spam';
const typingIn = (el: HTMLElement) =>
  ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;

/** Where a hold began: A outside any field, A inside Ask's own field (a tap still types the letter) or the talk chip. */
type Hold = {
  timer?: ReturnType<typeof setTimeout>;
  recording: boolean;
  source: 'key' | 'field' | 'pointer';
  key: string;
};

/** The docked Ask panel. Tap A to type, hold A anywhere (even in Ask's field) or the talk chip to talk and release to ask; nothing acts without a click. */
export const Ask = memo(function Ask({
  open,
  onOpen,
  onClose,
  onSearch,
  onCommand,
  conversations,
  threads,
  events,
  accounts,
  contacts,
  accountId,
  settings,
  examples,
  onThread,
  onDraft,
  notify,
  currentDraft,
  hasDraft,
  onApplyDraft,
  onEditEvent,
  currentContext,
  toolsSlot,
}: Props) {
  const recentMenu = useMenu();
  const [id, setId] = useState<string | undefined>();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [active, setActive] = useState(-1);
  const [held, setHeld] = useState<'' | 'key' | 'pointer'>('');
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [live, setLive] = useState<Live | undefined>();
  const [opened, setOpened] = useState(loadOpened);
  const field = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const conversation = conversations.find(c => c.id === id);
  const mounted = useRef(true);
  const request = useRef<string | undefined>(undefined);
  const snapshots = useRef(new Map<string, string>());
  const openRef = useRef(open);
  openRef.current = open;
  const returnFocus = useRef<HTMLElement | null>(null);
  const firstRender = useRef(true);
  const hold = useRef<Hold | null>(null);
  const autoAsk = useRef(false);
  const prefix = useRef('');
  function fingerprint(draft?: Draft) {
    return draft
      ? JSON.stringify([
          draft.id,
          draft.to,
          draft.cc,
          draft.bcc,
          draft.subject,
          draft.html,
          draft.attachments.map(a => a.id),
        ])
      : '';
  }
  useEffect(() => {
    const area = field.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = Math.min(area.scrollHeight, 132) + 'px';
  }, [input]);
  // Opening focuses the field (not at launch, and not while A is still held); closing gives focus back.
  useLayoutEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (open) {
      if (!panel.current?.contains(document.activeElement))
        returnFocus.current = document.activeElement as HTMLElement | null;
      if (!hold.current) requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    } else if (panel.current?.contains(document.activeElement)) {
      const back = returnFocus.current;
      if (back?.isConnected && back !== document.body) back.focus();
      else (document.activeElement as HTMLElement).blur();
    }
  }, [open]);
  async function ask(text = input) {
    if (!text.trim() || request.current || voice.isActive()) return;
    const requestId = uid();
    request.current = requestId;
    const draft = currentDraft();
    const snapshot = fingerprint(draft);
    setBusy(true);
    setError('');
    setPending(text.trim());
    setInput('');
    setLive({ text: '', steps: [], cites: [] });
    try {
      const result = await invoke<Conversation>('ai.ask', {
        conversationId: id,
        message: text,
        accountId,
        draft,
        requestId,
        timeZone,
        context: currentContext(),
      });
      if (!mounted.current || request.current !== requestId) return;
      snapshots.current.set(`${result.id}:${result.messages.length - 1}`, snapshot);
      setId(result.id);
    } catch (error) {
      if (mounted.current && request.current === requestId) {
        setError((error as Error).message);
        setInput(text);
      }
    } finally {
      if (mounted.current && request.current === requestId) {
        request.current = undefined;
        setBusy(false);
        setPending('');
        setLive(undefined);
      }
    }
  }
  // Progress for the running answer streams in as engine events; anything for another request is ignored.
  // `only`: this dock listens before the app does and must not take the deep-link, command and prepare-close events held for it.
  useEffect(
    () =>
      bridge.subscribe(event => {
        if (event.type !== 'ai.progress') return;
        const p = event.payload as {
          requestId?: string;
          type: string;
          text?: string;
          step?: AskStep;
          index?: number;
          threadId?: string;
        };
        if (!p || p.requestId !== request.current) return;
        setLive(current => {
          if (!current) return current;
          if (p.type === 'text' && p.text) return { ...current, text: current.text + p.text };
          if (p.type === 'reset') return { ...current, text: '', cites: [] };
          if (p.type === 'cite' && p.index && p.threadId) {
            const cites = [...current.cites];
            cites[p.index - 1] = p.threadId;
            return { ...current, cites };
          }
          if (p.type === 'step' && p.step) {
            const steps = current.steps.filter(s => s.id !== p.step!.id);
            const at = current.steps.findIndex(s => s.id === p.step!.id);
            steps.splice(at < 0 ? steps.length : at, 0, p.step);
            return { ...current, steps };
          }
          return current;
        });
      }, ASK_EVENTS),
    [],
  );
  const askLatest = useRef(ask);
  askLatest.current = ask;
  function cancelRequest() {
    const requestId = request.current;
    if (requestId)
      void invoke('ai.cancel', { requestId }).catch(error => {
        if (mounted.current) setError(error.message);
      });
  }
  function openThread(threadId: string) {
    setOpened(prev => {
      const next = [threadId, ...prev.filter(x => x !== threadId)].slice(0, openedLimit);
      localStorage.setItem(openedKey, JSON.stringify(next));
      return next;
    });
    onThread(threadId);
  }
  function openChat(chatId: string) {
    setId(chatId);
    setInput('');
    field.current?.focus();
  }
  function removeChat(chatId: string) {
    void invoke('conversation.delete', { id: chatId })
      .then(() => {
        if (mounted.current && id === chatId) setId(undefined);
      })
      .catch(e => notify(e.message));
  }
  async function apply(proposal: Partial<Draft>, index: number) {
    const fields: Partial<Draft> = {};
    for (const key of ['to', 'cc', 'bcc', 'subject', 'html'] as const) {
      const value = proposal[key];
      if (typeof value === 'string' && (key === 'html' || value.trim())) fields[key] = value;
    }
    // A reply opens against its email so it threads and picks the right account.
    const reply =
      proposal.threadId && threads.some(t => t.id === proposal.threadId)
        ? { threadId: proposal.threadId, mode: proposal.mode ?? ('reply' as const) }
        : {};
    const draft = currentDraft();
    if (draft) {
      const snapshot = snapshots.current.get(`${id}:${index}`);
      if (
        snapshot !== fingerprint(draft) &&
        !(await confirmAction({
          title: 'Apply this suggestion?',
          message:
            'The draft changed since this suggestion was written. Applying it replaces the matching fields.',
          confirmLabel: 'Apply',
        }))
      )
        return;
      onApplyDraft(fields);
      notify('Suggestion applied. Review the draft before sending.');
    } else onDraft({ ...fields, ...reply });
  }
  // What was spoken follows anything already typed, so "summarize the email from" + "Jordan" asks the whole sentence.
  const voice = useVoice(
    settings.microphone,
    text => {
      const auto = autoAsk.current;
      autoAsk.current = false;
      const said = [prefix.current, text.trim()].filter(Boolean).join(' ');
      prefix.current = '';
      if (auto && text.trim()) {
        setInput(said);
        setTimeout(() => void askLatest.current(said), 0);
        return;
      } // ask once the recorder settles to idle
      if (auto) {
        setError('I didn’t catch that. Try again, a little closer to the mic.');
        return;
      }
      setInput(said);
      field.current?.focus();
    },
    message => {
      setError(message);
      if (!openRef.current) onOpen();
    },
  );
  function listen(auto: boolean) {
    autoAsk.current = auto;
    prefix.current = field.current?.value.trim() ?? '';
    setError('');
    void voice.start();
  }
  function cancelVoice() {
    autoAsk.current = false;
    setHeld('');
    if (hold.current) {
      clearTimeout(hold.current.timer);
      hold.current = null;
    }
    voice.cancel();
  }
  // A tap on A opens and focuses the panel (in Ask's field it types the letter; on the chip it starts talking);
  // a hold opens it, records, and asks on release.
  function press(source: Hold['source'], key = '') {
    if (hold.current) return;
    const state: Hold = { recording: false, source, key };
    state.timer = setTimeout(() => {
      if (request.current || voice.isActive()) return;
      state.recording = true;
      setHeld(source === 'pointer' ? 'pointer' : 'key');
      listen(true);
    }, holdDelay);
    hold.current = state;
    if (!openRef.current) onOpen();
  }
  // The letter held back while deciding between a tap and a hold, typed the way the keyboard would have.
  function type(key: string) {
    const area = field.current;
    if (!area) return;
    area.focus({ preventScroll: true });
    document.execCommand('insertText', false, key);
  }
  function release() {
    const state = hold.current;
    if (!state) return;
    hold.current = null;
    clearTimeout(state.timer);
    setHeld('');
    if (state.recording) voice.stop();
    else if (state.source === 'field') type(state.key);
    else if (state.source === 'pointer') listen(false);
    else requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
  }
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const inField = target === field.current;
      // Fast typing presses the next key before A comes up: type the A first so the letters stay in order.
      if (hold.current?.source === 'field' && !hold.current.recording && !isA(event)) {
        const state = hold.current;
        hold.current = null;
        clearTimeout(state.timer);
        type(state.key);
      }
      // While A is held its repeats belong to Ask, even once focus has moved into the panel.
      if (hold.current && isA(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (
        event.key === 'Escape' &&
        (hold.current || voice.isActive()) &&
        !panel.current?.contains(target)
      ) {
        event.preventDefault();
        event.stopPropagation();
        cancelVoice();
        return;
      }
      if (
        !isA(event) ||
        event.repeat ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        dialogOpen()
      )
        return;
      if (inField ? field.current!.readOnly : hasDraft || typingIn(target)) return;
      event.preventDefault();
      event.stopPropagation();
      press(inField ? 'field' : 'key', event.key);
    };
    const up = (event: KeyboardEvent) => {
      if (isA(event) && hold.current && hold.current.source !== 'pointer') release();
    };
    // The chip turns into Done once recording starts, so its release is heard on the window.
    const pointerUp = () => {
      if (hold.current?.source === 'pointer') release();
    };
    const blur = () => {
      const state = hold.current;
      if (!state) return;
      if (state.recording || state.source === 'field') release();
      else {
        clearTimeout(state.timer);
        hold.current = null;
      }
    };
    // Capture so the list's own shortcuts never see a press that belongs to Ask.
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerUp);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerUp);
      window.removeEventListener('blur', blur);
    };
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelRequest();
    };
  }, []);
  // The menu hangs off the clock button; once that is gone (panel closed, last chat removed) the menu goes too.
  const hasChats = conversations.length > 0;
  useEffect(() => {
    if (!open || !hasChats) recentMenu.close();
  }, [open, hasChats]);
  const query = input.trim();
  const matches = useMemo(() => {
    if (!query || conversation) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return threads
      .filter(inScope(accountId))
      .filter(t => {
        const text = [t.subject, t.summary, ...t.messages.map(m => m.fromName + ' ' + m.from)]
          .join(' ')
          .toLowerCase();
        return words.every(word => text.includes(word));
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5);
  }, [query, threads, accountId, !!conversation]);
  const commandItem = (c: (typeof commands)[number]): Item => ({
    key: 'cmd-' + c.id,
    group: 'Commands',
    icon: <c.icon size={15} />,
    label: c.label,
    keys: c.keys,
    run: () => onCommand(c.id),
  });
  // A calendar example with someone this mailbox actually writes to shows that Ask can schedule too.
  const suggestions = useMemo(() => {
    const person = contacts.find(c => /^\p{Lu}\p{L}+ \p{L}/u.test(c.name))?.name.split(' ')[0];
    return [
      ...examples,
      person
        ? `Book lunch with ${person} Friday at noon`
        : 'Add lunch on Friday at noon to my calendar',
    ];
  }, [examples, contacts]);
  const voiceBusy = voice.recording || voice.busy;
  const recentMail = useMemo(() => {
    const byThread = new Map(threads.map(t => [t.id, t]));
    return opened
      .map(x => byThread.get(x))
      .filter((t): t is Thread => !!t && inScope(accountId)(t));
  }, [opened, threads, accountId]);
  const mailItem =
    (group: string, terms: string[] = []) =>
    (t: Thread): Item => {
      const m = t.messages.at(-1)!;
      return {
        key: group + t.id,
        group,
        icon: <Avatar name={m.fromName || m.from} size={22} />,
        label: (
          <span className="ask-item-mail">
            <strong>
              <Marked text={m.fromName || m.from} terms={terms} />
            </strong>
            <span>
              <Marked text={t.subject} terms={terms} />
            </span>
          </span>
        ),
        detail: dateLabel(t.date),
        run: () => openThread(t.id),
      };
    };
  const items = useMemo<Item[]>(() => {
    if (conversation || busy || voiceBusy) return [];
    // First time, examples; after that, recent chats and the emails last opened from Ask.
    if (!query)
      return !conversations.length && !recentMail.length
        ? suggestions.map((example, i): Item => ({
            key: 'ex' + i,
            group: 'Try asking',
            icon: <MessageCircle size={15} />,
            label: example,
            run: () => void askLatest.current(example),
          }))
        : [
            ...[...conversations]
              .reverse()
              .slice(0, 3)
              .map((c): Item => ({
                key: 'c' + c.id,
                group: 'Recent',
                label: c.title,
                run: () => openChat(c.id),
                remove: () => removeChat(c.id),
              })),
            ...recentMail.map(mailItem('Last searched')),
          ];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const terms = query.split(/\s+/).filter(w => w.length > 1);
    return [
      {
        key: 'ask',
        icon: <MessageCircle size={15} />,
        label: (
          <>
            Ask <strong>“{query}”</strong>
          </>
        ),
        run: () => void askLatest.current(),
      },
      ...matches.map(mailItem('Mail', terms)),
      {
        key: 'search',
        group: 'Mail',
        icon: <Search size={15} />,
        label: <>Search all mail</>,
        keys: '⌘ ↵',
        run: () => onSearch(query),
      },
      ...commands
        .filter(c =>
          words.every(w =>
            (c.label + ' ' + (c.words ?? ''))
              .toLowerCase()
              .split(/\s+/)
              .some(x => x.startsWith(w)),
          ),
        )
        .map(commandItem),
    ];
  }, [query, matches, conversations, recentMail, suggestions, !!conversation, busy, voiceBusy]);
  // Typed text highlights "Ask" so Enter asks; with nothing typed no row is chosen until the arrows move.
  useEffect(() => setActive(query ? 0 : -1), [query, items.length]);
  useEffect(() => {
    panel.current?.querySelector('.ask-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  // A new answer scrolls so its question sits at the top, rather than jumping to the end of a long reply.
  useLayoutEffect(() => {
    const box = scroller.current;
    const last = box && [...box.querySelectorAll<HTMLElement>('.ask-msg.user')].at(-1);
    if (box && last) box.scrollTo({ top: last.offsetTop - 12, behavior: open ? 'smooth' : 'auto' });
  }, [conversation?.messages.length, busy, id]);
  function newChat() {
    if (busy) return;
    setId(undefined);
    setError('');
    setInput('');
    field.current?.focus();
  }
  function keys(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (voice.isActive() || request.current || hold.current) {
        cancelVoice();
        cancelRequest();
      } else if (input) setInput('');
      else onClose();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'n') {
      event.preventDefault();
      event.stopPropagation();
      newChat();
      return;
    }
    // Plain keys typed or pressed in Ask never reach the mail list's shortcuts; ⌘ and ⌃ shortcuts still do.
    if (!event.metaKey && !event.ctrlKey) event.stopPropagation();
  }
  function fieldKeys(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.shiftKey) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(i =>
        i < 0 ? (step > 0 ? 0 : items.length - 1) : (i + step + items.length) % items.length,
      );
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (query) onSearch(query);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const item = items[active];
      if (item) item.run();
      else void ask();
    }
  }
  const recording = voice.recording || voice.preparing;
  const transcribing = voice.busy && !voice.preparing;
  const chat = !!conversation || busy;
  const activeItem = items[active];
  const byId = useMemo(() => new Map(threads.map(t => [t.id, t])), [threads]);
  const modelName = useMemo(() => {
    const label = askModelLabel(settings.askModel);
    return `${label.provider} ${label.model}`;
  }, [settings.askModel]);
  const body = items.length ? (
    <div className="ask-list" role="listbox" aria-label={query ? 'Matches' : 'Suggestions'}>
      {items.map((item, i) => (
        <div key={item.key} className="ask-item-wrap">
          {item.group && item.group !== items[i - 1]?.group && (
            <p className="ask-group">{item.group}</p>
          )}
          <div className={cx('ask-item-row', item.remove && 'has-remove')}>
            <button
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              className={cx(
                'ask-item',
                i === active && 'is-active',
                item.key === 'ask' && 'is-ask',
              )}
              onPointerMove={() => {
                if (active !== i) setActive(i);
              }}
              onMouseDown={e => e.preventDefault()}
              onClick={item.run}
            >
              {item.icon && <span className="ask-item-icon">{item.icon}</span>}
              <span className="ask-item-label">{item.label}</span>
              {item.detail && <span className="ask-item-detail">{item.detail}</span>}
              {i === active ? (
                <Keys combo="↵" size="sm" />
              ) : (
                item.keys && <Keys combo={item.keys} size="sm" className="ask-item-keys" />
              )}
            </button>
            {item.remove && (
              <IconButton
                size="xs"
                className="ask-item-remove"
                label="Remove from Recent"
                tooltip={false}
                icon={X}
                tabIndex={-1}
                onMouseDown={e => e.preventDefault()}
                onClick={item.remove}
              />
            )}
          </div>
        </div>
      ))}
      {!!query && !matches.length && <p className="ask-empty">No mail matches that yet.</p>}
    </div>
  ) : chat ? (
    <div className="ask-chat">
      {conversation?.messages.map((m, i) => (
        <div key={i} className={'ask-msg ' + m.role}>
          {m.role === 'assistant' ? (
            <>
              {!!m.steps?.length && <AskSteps steps={m.steps} />}
              <div className="ask-msg-text">
                <Prose
                  text={m.content}
                  cite={n => byId.get(m.citations?.[n - 1] ?? '')}
                  onThread={openThread}
                />
              </div>
              {!!m.citations?.length && (
                <AskSources citations={m.citations} threads={byId} onThread={openThread} />
              )}
              {m.proposal && (
                <AskDraftCard
                  proposal={m.proposal}
                  threads={byId}
                  hasDraft={hasDraft}
                  onApply={() => void apply(m.proposal!, i)}
                />
              )}
              {m.event && (
                <AskEvent
                  key={`${id}:${i}`}
                  proposal={m.event}
                  accounts={accounts}
                  accountId={accountId}
                  events={events}
                  contacts={contacts}
                  savedId={saved[`${id}:${i}`]}
                  onSaved={eventId => setSaved(s => ({ ...s, [`${id}:${i}`]: eventId }))}
                  notify={notify}
                  onEdit={onEditEvent}
                  onCalendar={() => onCommand('calendar')}
                />
              )}
              {m.triage && (
                <AskTriageCard
                  triage={m.triage}
                  threads={byId}
                  notify={notify}
                  onThread={openThread}
                />
              )}
            </>
          ) : (
            <div className="ask-msg-text">{m.content}</div>
          )}
        </div>
      ))}
      {busy && (
        <>
          <div className="ask-msg user">
            <div className="ask-msg-text">{pending}</div>
          </div>
          <div className="ask-msg assistant is-live" aria-live="polite" aria-busy="true">
            {/* Working: steps and a live line. Answering: the steps fold into one line above the streaming text. */}
            {live?.text ? (
              <>
                {!!live.steps.length && <AskSteps steps={live.steps} />}
                <div className="ask-msg-text is-streaming">
                  <Prose
                    text={live.text}
                    cite={n => byId.get(live.cites[n - 1] ?? '')}
                    onThread={openThread}
                    streaming
                  />
                </div>
              </>
            ) : (
              <AskSteps steps={live?.steps ?? []} live />
            )}
          </div>
        </>
      )}
    </div>
  ) : null;
  // In a chat the field moves to the bottom, under the conversation; New chat and Recent chats sit beside the dock's tabs.
  const tools =
    toolsSlot &&
    open &&
    createPortal(
      <>
        {conversations.length > 0 && (
          <IconButton
            size="sm"
            label="Recent chats"
            icon={History}
            active={recentMenu.open}
            disabled={busy}
            onClick={recentMenu.toggle}
          />
        )}
        {chat && (
          <IconButton
            size="sm"
            label="New chat"
            shortcut="⌘ N"
            icon={Plus}
            disabled={busy}
            onClick={newChat}
          />
        )}
        <Menu
          open={recentMenu.open}
          anchor={recentMenu.anchor}
          onClose={recentMenu.close}
          placement="bottom-start"
          label="Recent chats"
          className="ask-recent-menu"
          groups={[
            [...conversations]
              .reverse()
              .map(c => ({ label: c.title, checked: c.id === id, onSelect: () => openChat(c.id) })),
          ]}
        />
      </>,
      toolsSlot,
    );
  return (
    <aside
      ref={panel}
      className={cx('ask-panel', chat && 'is-chat')}
      aria-label="Ask Aplos"
      onKeyDown={keys}
    >
      {tools}
      <div className="ask-head">
        <div className="ask-column">
          <div className={cx('ask-field', recording && 'is-recording', busy && 'is-busy')}>
            {recording &&
              (voice.preparing ? <Spinner size={14} /> : <LevelMeter level={voice.level} />)}
            <textarea
              ref={field}
              aria-label="Ask me anything"
              rows={1}
              value={input}
              readOnly={recording || transcribing}
              onChange={e => setInput(e.target.value)}
              onKeyDown={fieldKeys}
              placeholder={
                voice.preparing
                  ? 'Starting the mic…'
                  : recording
                    ? 'Listening…'
                    : transcribing
                      ? 'Transcribing…'
                      : conversation
                        ? 'Ask a follow-up'
                        : 'Ask me anything'
              }
            />
            {busy ? (
              <button className="ask-chip" onClick={cancelRequest}>
                Stop
              </button>
            ) : recording ? (
              <button
                className="ask-chip is-recording"
                onClick={() => {
                  setHeld('');
                  if (hold.current) {
                    clearTimeout(hold.current.timer);
                    hold.current = null;
                  }
                  voice.stop();
                }}
              >
                <Square size={10} />
                Done
              </button>
            ) : transcribing ? (
              <Spinner size={15} className="ask-spinner" />
            ) : query ? (
              <Tooltip
                content={activeItem && activeItem.key !== 'ask' ? 'Open the selected item' : 'Ask'}
                detail="⌘ ↵ searches mail instead"
                shortcut="↵"
              >
                <button
                  className="ask-chip is-go"
                  onClick={() => {
                    if (activeItem) activeItem.run();
                    else void ask();
                  }}
                >
                  {activeItem && activeItem.key !== 'ask' ? 'Open' : 'Ask'}
                  <CornerDownLeft size={12} />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content="Talk instead" detail="Click to start, or hold and release to ask">
                <button
                  className="ask-chip ask-talk"
                  onMouseDown={e => e.preventDefault()}
                  onPointerDown={e => {
                    if (e.button === 0) press('pointer');
                  }}
                  onClick={e => {
                    if (e.detail === 0) listen(false);
                  }}
                >
                  Hold <Kbd size="sm">A</Kbd> to talk
                </button>
              </Tooltip>
            )}
          </div>
          {recording && (
            <p className="ask-hint is-recording" role="status">
              {held === 'key' ? (
                <>
                  Release <Kbd size="sm">A</Kbd> to ask
                </>
              ) : held === 'pointer' ? (
                <>Release to ask</>
              ) : (
                <>Recording, press Done to finish</>
              )}
              <span>·</span>
              <Kbd size="sm">Esc</Kbd> to cancel
            </p>
          )}
          {transcribing && (
            <p className="ask-hint" role="status">
              Transcribing with {askModelLabel(settings.voiceModel, 'voice').provider}…
            </p>
          )}
          {error && <Notice className="ask-notice">{error}</Notice>}
        </div>
      </div>
      <div ref={scroller} className="ask-scroll">
        {body}
      </div>
      {chat && (
        <p className="ask-footnote">
          Answers use the selected mailbox ·{' '}
          <button
            onClick={() => {
              showSettingsTab('AI');
              onCommand('settings');
            }}
            title="Change the Ask model in Settings"
          >
            {modelName}
          </button>
        </p>
      )}
    </aside>
  );
});
