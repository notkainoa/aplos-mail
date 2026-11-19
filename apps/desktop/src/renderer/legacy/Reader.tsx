import { useCallback, useEffect, useRef, useState } from 'react';
import { rememberPlans, usePlans } from './detectedPlans';
import { askModelLabel } from '@aplos/contract/legacy/ask';
import {
  describeSummaryError,
  hasRealSummary,
  summarize,
  summarizeIfNeeded,
  summaryProvider,
  useSummaryJob,
  type SummaryProvider,
} from './summaries';
import { dayKey, timeRange } from './calendarTime';
import { planSaved } from './calendarLayout';
import { liveAction } from '@aplos/contract/legacy/mailbox';
import {
  Ban,
  Bell,
  Bookmark,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  ExternalLink,
  Forward,
  HelpCircle,
  ImageOff,
  MailOpen,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  RefreshCw,
  Reply,
  ReplyAll,
  RotateCcw,
  Search,
  ShieldAlert,
  Trash2,
  Undo2,
  X,
  CornerUpLeft,
} from './icons';
import type {
  Attachment,
  CalendarEvent,
  Message,
  Settings,
  Thread,
} from '@aplos/contract/legacy/types';
import { dateLabel, dueLabel, fullDate, invoke, isoDay, openUrl, saveFile } from './bridge';
import { inlineAttachments, prepareMessageBody } from './mailBody';
import {
  Avatar,
  Button,
  Dialog,
  DialogClose,
  IconButton,
  Keys,
  Menu,
  Notice,
  Popover,
  Spinner,
  Tooltip,
  confirmAction,
  cx,
  useMenu,
  useSwipe,
  type MenuGroups,
  type SwipeSide,
} from './ui';
type Triage = 'done' | 'later' | 'trash' | 'spam';
export type CardDrag = { x: number; width: number };
// Dragging with a mouse would otherwise steal text selection in the message itself; it starts from the card's chrome instead.
const selectableText =
  '.email-body,.quoted-content,h1,.ai-summary,.ai-todo-text,.ai-plan-text,.find-bar';
const capital = (text: string) => text && text[0].toUpperCase() + text.slice(1);
type Person = { name: string; email: string };
/** "Jordan Park <jordan@studio.example>" or a bare address. */
function person(raw: string): Person {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: raw.trim() };
}
const dayOffset = (value?: string) => {
  if (!value) return undefined;
  const date = new Date(value.slice(0, 10) + 'T12:00:00');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.round((+date - +today) / 86400000);
};
export function Reader({
  thread,
  settings,
  index,
  total,
  back,
  patch,
  restore,
  triage,
  bookmark,
  reply,
  editEvent,
  events,
  notify,
  undo,
  heading,
  replySlot,
  ghost,
  entering,
  talk,
  action,
  previewId,
}: {
  thread: Thread;
  settings: Settings;
  index: number;
  total: number;
  back: () => void;
  patch: (ids: string[], p: Partial<Thread>, label?: string) => Promise<unknown>;
  restore?: () => void;
  triage: (status: Triage, drag?: CardDrag) => void;
  bookmark?: () => void;
  reply: (mode: 'reply' | 'reply-all' | 'forward') => void;
  editEvent: (event: Partial<CalendarEvent>) => void;
  /** Calendar events, to tell which of this email's plans are already on a calendar. */ events: CalendarEvent[];
  notify: (text: string) => void;
  undo: () => void;
  standalone?: boolean;
  heading?: { title: string; count: number };
  replySlot?: React.ReactNode;
  ghost?: boolean;
  entering?: string;
  talk: (phase: 'start' | 'release') => void;
  /** The AI-suggested next step, shown in the summary card beside the due date. */ action?: React.ReactNode;
  /** An attachment to preview on open (the suggested action); files only leave Aplos through the preview's own buttons. */ previewId?: string;
}) {
  const menu = useMenu();
  const importance = useMenu();
  const [dates, setDates] = useState(false);
  const [find, setFind] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<Attachment | undefined>();
  const [error, setError] = useState('');
  const [remote, setRemote] = useState(settings.remoteImages);
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set([thread.messages.at(-1)?.id ?? '']),
  );
  const [quotes, setQuotes] = useState<Set<string>>(new Set());
  const [inlineFiles, setInlineFiles] = useState<Record<string, Attachment>>({});
  const inlineCache = useRef<Record<string, Attachment>>({});
  const inlinePending = useRef<Record<string, Promise<Attachment>>>({});
  const [inlineLoading, setInlineLoading] = useState(false);
  const [inlineError, setInlineError] = useState('');
  const [inlineRetry, setInlineRetry] = useState(0);
  const [shownPreview, setShownPreview] = useState<Attachment>();
  useEffect(() => {
    if (preview) setShownPreview(preview);
  }, [preview]);
  useEffect(() => {
    setExpanded(new Set([thread.messages.at(-1)?.id ?? '']));
    setQuotes(new Set());
    menu.close();
    importance.close();
    setDates(false);
    setError('');
    setRemote(settings.remoteImages);
    setPreview(undefined);
    setQuery('');
    inlineCache.current = {};
    inlinePending.current = {};
    setInlineFiles({});
    setInlineError('');
  }, [thread.id]);
  useEffect(() => {
    const file =
      previewId && !ghost
        ? thread.messages.flatMap(m => m.attachments).find(a => a.id === previewId)
        : undefined;
    if (file) void attachment(file);
  }, [previewId]);
  useEffect(() => {
    let cancelled = false;
    setInlineLoading(false);
    setInlineError('');
    if (thread.status === 'spam') return;
    const files = [
      ...new Map(
        thread.messages
          .filter(message => expanded.has(message.id))
          .flatMap(inlineAttachments)
          .filter(file => !inlineCache.current[file.id])
          .map(file => [file.id, file]),
      ).values(),
    ];
    if (!files.length) return;
    setInlineLoading(true);
    let cursor = 0;
    const failures: string[] = [];
    void Promise.all(
      Array.from({ length: Math.min(3, files.length) }, async () => {
        while (cursor < files.length && !cancelled) {
          const file = files[cursor++]; // Effects restart while downloads are in flight (expanding, thread refreshes); share the request rather than downloading again.
          const pending = inlinePending.current;
          const request = (pending[file.id] ??= invoke<Attachment>('attachment.get', {
            threadId: thread.id,
            attachmentId: file.id,
          }));
          request.catch(() => {
            if (pending[file.id] === request) delete pending[file.id];
          });
          try {
            const ready = await request;
            if (!cancelled) {
              inlineCache.current = { ...inlineCache.current, [ready.id]: ready };
              setInlineFiles(inlineCache.current);
            }
          } catch (error) {
            failures.push(error instanceof Error ? error.message : 'Inline image unavailable.');
          }
        }
      }),
    ).then(() => {
      if (!cancelled) {
        setInlineLoading(false);
        if (failures.length) setInlineError(failures[0]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [thread.id, thread.status, thread.messages, expanded, inlineRetry]);
  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function attachment(a: Attachment, download = false) {
    await run(a.id, async () => {
      const ready = a.data
        ? a
        : await invoke<Attachment>('attachment.get', { threadId: thread.id, attachmentId: a.id });
      if (download) await saveFile(ready.name, ready.data!);
      else setPreview(ready);
    });
  }
  function handleEmailLink(e: React.MouseEvent<HTMLElement>) {
    const link = (e.target as HTMLElement).closest('a');
    if (!link) return;
    e.preventDefault();
    if (thread.status === 'spam') return;
    const href = link.getAttribute('href');
    if (href) void openUrl(href).catch(error => setError(error.message));
  }
  const scroller = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [hit, setHit] = useState(0);
  const [hits, setHits] = useState(0);
  const needle = query.trim();
  function closeFind() {
    setFind(false);
    setQuery('');
  }
  function step(delta: number) {
    if (hits) setHit(value => (value + delta + hits) % hits);
  }
  useEffect(() => {
    if (ghost) return;
    const open = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'f' || e.altKey) return;
      if (
        (e.target as HTMLElement | null)?.closest?.(
          '.compose-layer,.compose-inline,.ask-panel,.ui-dialog',
        )
      )
        return;
      e.preventDefault();
      setFind(true);
      requestAnimationFrame(() => {
        findInput.current?.focus();
        findInput.current?.select();
      });
    };
    addEventListener('keydown', open);
    return () => removeEventListener('keydown', open);
  }, [ghost]);
  // Open collapsed messages that contain the search text, otherwise their matches stay invisible.
  useEffect(() => {
    if (needle.length < 2) return;
    const lower = needle.toLowerCase();
    const containing = thread.messages
      .filter(m => m.text.toLowerCase().includes(lower))
      .map(m => m.id);
    if (containing.length)
      setExpanded(prev =>
        containing.every(id => prev.has(id)) ? prev : new Set([...prev, ...containing]),
      );
  }, [needle, thread.messages]);
  useEffect(() => {
    setHits(needle ? (scroller.current?.querySelectorAll('.email-body mark').length ?? 0) : 0);
    setHit(0);
  }, [needle, expanded, quotes, inlineFiles, remote]);
  useEffect(() => {
    const marks = [...(scroller.current?.querySelectorAll('.email-body mark') ?? [])];
    marks.forEach((mark, i) => mark.classList.toggle('is-current', i === hit));
    marks[hit]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [hit, hits]);
  useEffect(() => {
    if (!replySlot || !scroller.current) return;
    const el = scroller.current;
    requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
  }, [!!replySlot]);
  // An email without a real summary yet is summarized on open; the card shows that work, or why it failed.
  const job = useSummaryJob(thread.id);
  const hasSummary = hasRealSummary(thread);
  // A request from the list that fails leaves no job behind, so the open email then asks for itself.
  useEffect(() => {
    if (!ghost) summarizeIfNeeded(thread, settings.summaryModel);
  }, [thread.id, ghost, !job]);
  // While the model works, a placeholder holds the to-do's place; what it finds fades in rather than popping in.
  const pending = !hasSummary && !job?.error;
  const waited = useRef<{ id: string; next: boolean; todo: boolean; due: boolean }>(undefined);
  const resummarize = () =>
    void summarize(thread.id, { summaryModel: settings.summaryModel }).then(error => {
      if (error)
        notify(
          describeSummaryError(error, summaryProvider(settings.summaryModel)).title +
            '. The previous summary is kept.',
        );
    });
  const dueInput = thread.dueDate?.slice(0, 10) ?? '';
  const doneRight = settings.triageDirection !== 'done-left';
  const card = useRef<HTMLDivElement>(null);
  const swipeAction = (side: SwipeSide) =>
    (side === 'right') === doneRight ? ('done' as const) : ('later' as const);
  // Trash offers only Restore and Spam adds Done and Trash; everything else comes back once it is restored. Undo stays.
  const binned = thread.status === 'trash' || thread.status === 'spam';
  const restoreThread = () =>
    restore ? restore() : void patch([thread.id], { status: 'new' }, 'Restored to Home');
  const swipeable = settings.swipe && !ghost && !replySlot && !binned;
  const swipe = useSwipe({
    enabled: swipeable,
    host: card,
    actionFor: swipeAction,
    onCommit: (side, x, width) => triage(swipeAction(side), { x, width }),
    canStart: (target, pointer) => pointer !== 'mouse' || !target.closest(selectableText),
  });
  const swipeBadge = (side: SwipeSide) => {
    const done = swipeAction(side) === 'done';
    return (
      <span data-for={side}>
        {done ? <Check size={17} /> : <Clock size={16} />}
        {done ? 'Done' : 'Todo'}
      </span>
    );
  };
  const laterPill = (
    <Tooltip key="later" content="Todo" shortcut={'L'}>
      <button className="dock-pill later" aria-label="Move to Todo" onClick={() => triage('later')}>
        {doneRight && <Keys combo="←" />}
        <Clock size={17} />
        <span>Todo</span>
        {!doneRight && <Keys combo="→" />}
      </button>
    </Tooltip>
  );
  const donePill = (
    <Tooltip key="done" content="Done" shortcut={'E'}>
      <button className="dock-pill done" aria-label="Mark Done" onClick={() => triage('done')}>
        {!doneRight && <Keys combo="←" />}
        <Check size={18} />
        <span>Done</span>
        {doneRight && <Keys combo="→" />}
      </button>
    </Tooltip>
  );
  const replyAll = settings.defaultReply === 'reply-all';
  const menuGroups: MenuGroups = [
    [
      {
        label: 'Open in separate window',
        icon: ExternalLink,
        onSelect: () => invoke('window.thread', { threadId: thread.id }),
      },
    ],
    [
      {
        label: replyAll ? 'Reply to sender' : 'Reply all',
        icon: replyAll ? Reply : ReplyAll,
        keys: '⇧ R',
        onSelect: () => reply(replyAll ? 'reply' : 'reply-all'),
      },
      { label: 'Forward', icon: Forward, keys: 'F', onSelect: () => reply('forward') },
    ],
    [
      { label: 'Due date & reminder', icon: Bell, onSelect: openDates },
      {
        label: 'Find plans in this email',
        icon: CalendarDays,
        hint: 'Suggest calendar events from dates in the thread',
        onSelect: () =>
          run('plans', async () => {
            const found = await invoke<Partial<CalendarEvent>[]>('calendar.extract', {
              threadId: thread.id,
            });
            rememberPlans(thread.id, found);
            if (!found.length) notify('No definite dates or plans found in this email.');
          }),
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
        label: thread.replyStatus === 'needs-reply' ? 'Clear Needs reply' : 'Needs my reply',
        icon: CornerUpLeft,
        onSelect: () =>
          patch([thread.id], {
            replyStatus: thread.replyStatus === 'needs-reply' ? 'none' : 'needs-reply',
          }),
      },
      {
        label:
          thread.replyStatus === 'awaiting-reply' ? 'Clear Awaiting reply' : 'Awaiting a reply',
        icon: MessageCircle,
        onSelect: () =>
          patch([thread.id], {
            replyStatus: thread.replyStatus === 'awaiting-reply' ? 'none' : 'awaiting-reply',
          }),
      },
      { label: 'Find in message', icon: Search, onSelect: () => setFind(true) },
    ],
    [
      {
        label: 'Block sender',
        icon: Ban,
        hint: 'Future mail from this address goes to Spam',
        onSelect: () =>
          run('block', async () => {
            const email = thread.messages[0].from;
            if (
              await confirmAction({
                title: 'Block ' + email + '?',
                message:
                  'Their current and future mail will go to Spam. You can unblock them in Settings.',
                confirmLabel: 'Block sender',
                danger: true,
              })
            )
              await invoke('sender.block', { email });
          }),
      },
      {
        label: 'Unsubscribe',
        icon: X,
        onSelect: () =>
          run('unsubscribe', async () => {
            const r = await invoke<{ url?: string; message: string }>('thread.unsubscribe', {
              id: thread.id,
            });
            if (r.url) {
              if (
                await confirmAction({
                  title: 'Open the unsubscribe page?',
                  message: r.message,
                  confirmLabel: 'Open page',
                })
              )
                await openUrl(r.url);
            } else notify(r.message);
          }),
      },
      {
        label:
          thread.status === 'trash' || thread.status === 'spam'
            ? 'Restore to Home'
            : 'Move to Spam',
        icon: ShieldAlert,
        onSelect: () =>
          thread.status === 'trash' || thread.status === 'spam'
            ? patch([thread.id], { status: 'new' })
            : triage('spam'),
      },
    ],
    [
      {
        label: 'Move to Trash',
        icon: Trash2,
        keys: '#',
        danger: true,
        onSelect: () => triage('trash'),
      },
    ],
  ];
  // A tap opens the reply; pressing and holding opens it and starts dictation until release.
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; held: boolean } | null>(null);
  const [holding, setHolding] = useState(false);
  const replyButton = (
    <Tooltip
      content={replyAll ? 'Reply all' : 'Reply'}
      detail="Tap to write · hold to talk"
      placement="top"
    >
      <button
        className={cx('dock-reply', holding && 'is-holding')}
        onPointerDown={e => {
          if (e.button !== 0) return;
          setHolding(true);
          const state: { timer?: ReturnType<typeof setTimeout>; held: boolean } = { held: false };
          state.timer = setTimeout(() => {
            state.held = true;
            talk('start');
          }, 300);
          press.current = state;
        }}
        onPointerUp={() => {
          setHolding(false);
          const state = press.current;
          if (state && !state.held) clearTimeout(state.timer);
          if (state?.held) talk('release');
        }}
        onPointerLeave={() => {
          setHolding(false);
          const state = press.current;
          if (state && !state.held) {
            clearTimeout(state.timer);
            press.current = null;
          }
        }}
        onClick={() => {
          const state = press.current;
          press.current = null;
          if (state?.held) return;
          reply(settings.defaultReply);
        }}
      >
        <span>
          <Reply size={17} />
          {replyAll ? 'Reply all' : 'Reply'}
          <Keys combo="Space" size="sm" />
        </span>
        <small>Hold to talk</small>
      </button>
    </Tooltip>
  );
  // The bar floats over the top of the thread and turns into a compact title once the subject scrolls under it.
  const title = useRef<HTMLHeadingElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    const el = title.current,
      root = scroller.current;
    if (!el || !root || ghost) return;
    const observer = new IntersectionObserver(
      ([entry]) =>
        setScrolled(
          !entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0) + 1,
        ),
      { root, rootMargin: '-56px 0px 0px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ghost]);
  // The due pill shows only for a due date the email has (found or set); "Due date & reminder" shows it while picking.
  const duePill = useRef<HTMLButtonElement | null>(null);
  const [dueAnchor, setDueAnchor] = useState<HTMLButtonElement | null>(null);
  const dueRef = useCallback((el: HTMLButtonElement | null) => {
    duePill.current = el;
    setDueAnchor(el);
  }, []);
  function openDates() {
    setDates(true);
    requestAnimationFrame(() =>
      duePill.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  }
  const due = dayOffset(thread.dueDate);
  const dueTone = due === undefined ? '' : due < 0 ? 'is-overdue' : due === 0 ? 'is-today' : '';
  // Plans Groq found in this email take the place of the "Add to calendar" suggestion, with their details.
  const plans = usePlans(thread.id)?.found ?? [];
  const showPlans = plans.length > 0 && !binned;
  const planned = showPlans && liveAction(thread)?.kind === 'calendar';
  const hasNext =
    !binned &&
    !!(thread.todo || thread.dueDate || dates || thread.reminderAt || (action && !planned));
  // What the card showed while the model worked; only what it adds afterwards fades in.
  if (pending)
    waited.current = { id: thread.id, next: hasNext, todo: !!thread.todo, due: !!thread.dueDate };
  const seen = waited.current?.id === thread.id && !pending ? waited.current : undefined;
  // While summarizing, an empty to-do slot shows a placeholder beside any date or action already there.
  const ai = (
    <div className="ai-card">
      <div className="ai-lede">
        {hasSummary ? (
          <p className="ai-summary" key={thread.summary}>
            {capital(thread.summary.trim())}
          </p>
        ) : job?.error ? (
          <SummaryFailure
            error={job.error}
            provider={job.provider ?? summaryProvider(settings.summaryModel)}
            retry={() => void summarize(thread.id, { summaryModel: settings.summaryModel })}
          />
        ) : (
          <p className="ai-summary is-pending" role="status">
            Summarizing…
          </p>
        )}
        {hasSummary && (
          <IconButton
            className={cx('ai-refresh', job?.running && 'is-busy')}
            label="Summarize again"
            detail={`With ${askModelLabel(settings.summaryModel, 'summary').provider}`}
            size="xs"
            icon={RefreshCw}
            iconSize={13}
            loading={job?.running}
            onClick={resummarize}
          />
        )}
      </div>
      {hasNext ? (
        <div
          className={cx(
            'ai-next',
            !thread.todo && !pending && 'no-todo',
            seen && !seen.next && 'is-arriving',
          )}
        >
          {thread.todo ? (
            <span className={cx('ai-todo', seen?.next && !seen.todo && 'is-arriving')}>
              <span className="todo-ring" aria-hidden="true" />
              <span className="ai-todo-text">{thread.todo}</span>
            </span>
          ) : (
            pending && (
              <span className="ai-todo is-placeholder" aria-hidden="true">
                <span className="todo-ring" />
                <span className="ai-skeleton" />
              </span>
            )
          )}
          <span className="ai-controls">
            {(thread.dueDate || dates) && (
              <button
                ref={dueRef}
                className={cx(
                  'due-pill',
                  dueTone,
                  !thread.dueDate && 'is-empty',
                  dates && 'is-open',
                  seen?.next && !seen.due && thread.dueDate && 'is-arriving',
                )}
                aria-haspopup="dialog"
                aria-expanded={dates}
                onClick={() => setDates(value => !value)}
              >
                <CalendarDays size={14} />
                <span>{thread.dueDate ? dueLabel(thread.dueDate) : 'Add due date'}</span>
                <ChevronDown size={12} />
              </button>
            )}
            {thread.reminderAt && (
              <button
                className="due-pill reminder"
                aria-label={'Reminder ' + fullDate(thread.reminderAt)}
                onClick={openDates}
              >
                <Bell size={13} />
                <span>{dateLabel(thread.reminderAt, true)}</span>
              </button>
            )}
            {!planned && action}
          </span>
        </div>
      ) : (
        pending &&
        !binned && (
          <div className="ai-next is-placeholder" aria-hidden="true">
            <span className="todo-ring" />
            <span className="ai-skeleton" />
          </div>
        )
      )}
      {showPlans && (
        <div className="ai-plans" aria-label="Plans in this email">
          {plans.map((plan, i) => {
            const saved = planSaved(
              plan,
              events.filter(e => e.threadId === thread.id),
            );
            const day = plan.start ? dayKey(plan.start) : undefined;
            const date = day ? new Date(day + 'T00:00:00') : undefined;
            return (
              <div className={cx('ai-plan', saved && 'is-saved')} key={i}>
                <span className="ai-plan-date" aria-hidden="true">
                  {date ? (
                    <>
                      <small>{date.toLocaleDateString([], { month: 'short' })}</small>
                      <strong>{date.getDate()}</strong>
                    </>
                  ) : (
                    <CalendarDays size={18} />
                  )}
                </span>
                <span className="ai-plan-text">
                  <strong>{plan.title || 'A plan'}</strong>
                  <span className="ai-plan-when">
                    {date ? (
                      <>
                        <span>
                          {date.toLocaleDateString([], {
                            weekday: 'long',
                            month: 'long',
                            day: 'numeric',
                          })}
                          {plan.end && ' ·'}
                        </span>
                        {plan.end && (
                          <>
                            {' '}
                            <span>
                              {timeRange({
                                start: plan.start!,
                                end: plan.end,
                                allDay: !!plan.allDay,
                              })}
                            </span>
                          </>
                        )}
                      </>
                    ) : (
                      'No time yet'
                    )}
                  </span>
                  {(plan.location || !!plan.guests?.length) && (
                    <span>
                      {[
                        plan.location,
                        plan.guests?.length
                          ? 'With ' +
                            plan.guests.slice(0, 3).join(', ') +
                            (plan.guests.length > 3 ? ` and ${plan.guests.length - 3} more` : '')
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                </span>
                {/* Both go to Today in the dock: a new plan to confirm there, a saved one to see on its day. */}
                {saved ? (
                  <Button
                    variant="text"
                    size="sm"
                    icon={Check}
                    onClick={() =>
                      editEvent({ ...plan, threadId: thread.id, accountId: thread.accountId })
                    }
                  >
                    On your calendar
                  </Button>
                ) : (
                  <Button
                    variant="tinted"
                    size="sm"
                    icon={CalendarDays}
                    onClick={() =>
                      editEvent({ ...plan, threadId: thread.id, accountId: thread.accountId })
                    }
                  >
                    Add to calendar
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
  return (
    <section
      className={'reader stack-reader' + (ghost ? ' ghost' : '')}
      aria-label={ghost ? undefined : 'Email thread'}
      aria-hidden={ghost || undefined}
      inert={ghost || undefined}
    >
      {heading && (
        <div className="stack-heading">
          {heading.title}
          <span>{total > 1 ? `${index + 1} of ${total}` : heading.count}</span>
          {total > 1 && (
            <span className="stack-keys">
              <Keys combo="K" size="sm" />
              <Keys combo="J" size="sm" />
            </span>
          )}
        </div>
      )}
      <div className={'deck' + (index < total - 1 && !replySlot ? ' has-next' : '')}>
        <div
          ref={card}
          className={'reader-card' + (entering ? ' entering-' + entering : '')}
          {...swipe}
        >
          {swipeable && (
            <div className="card-swipe" aria-hidden="true">
              {swipeBadge('right')}
              {swipeBadge('left')}
            </div>
          )}
          {find && (
            <div className="find-bar">
              <Search size={15} />
              <input
                ref={findInput}
                autoFocus
                aria-label="Find in message"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeFind();
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    step(e.shiftKey ? -1 : 1);
                  }
                }}
                placeholder="Find in this conversation"
              />
              {query.trim().length > 0 && (
                <span className={cx('find-count', !hits && 'is-empty')} aria-live="polite">
                  {hits ? `${hit + 1} of ${hits}` : 'No matches'}
                </span>
              )}
              <IconButton
                label="Previous match"
                shortcut="⇧ ↩"
                size="sm"
                icon={ChevronUp}
                disabled={hits < 2}
                onClick={() => step(-1)}
              />
              <IconButton
                label="Next match"
                shortcut="↩"
                size="sm"
                icon={ChevronDown}
                disabled={hits < 2}
                onClick={() => step(1)}
              />
              <IconButton
                label="Close find"
                shortcut="Esc"
                size="sm"
                icon={X}
                onClick={closeFind}
              />
            </div>
          )}
          <div className="reader-frame">
            <header className={cx('reader-bar', moved && 'is-raised', scrolled && 'is-scrolled')}>
              <span className="reader-bar-title" aria-hidden="true">
                {thread.subject || '(No subject)'}
              </span>
              {!binned && (
                <div className="actions">
                  <Button
                    variant="ghost"
                    className={cx('importance-button', importance.open && 'is-open')}
                    aria-label="Importance"
                    aria-haspopup="menu"
                    iconRight={ChevronDown}
                    onClick={importance.toggle}
                  >
                    {thread.importance === 'important' ? 'Important' : 'Low importance'}
                  </Button>
                  <Menu
                    open={importance.open}
                    anchor={importance.anchor}
                    onClose={importance.close}
                    placement="bottom-end"
                    label="Importance"
                    className="importance-menu"
                    groups={[
                      (['important', 'low'] as const).map(level => ({
                        label: level === 'important' ? 'Important' : 'Low importance',
                        hint: level === 'important' ? 'Shown in Home' : 'Bundled out of the way',
                        checked: thread.importance === level,
                        onSelect: () => {
                          if (thread.importance !== level)
                            void patch(
                              [thread.id],
                              { importance: level },
                              level === 'low' ? 'Moved to Low importance' : 'Marked important',
                            );
                        },
                      })),
                    ]}
                  />
                  <IconButton
                    label="Move to Trash"
                    shortcut="#"
                    icon={Trash2}
                    size="lg"
                    iconSize={18}
                    onClick={() => triage('trash')}
                  />
                  <IconButton
                    label="More thread actions"
                    tooltip={false}
                    icon={MoreHorizontal}
                    size="lg"
                    iconSize={19}
                    loading={['plans', 'block', 'unsubscribe'].includes(busy)}
                    className={menu.open ? 'is-open' : undefined}
                    onClick={menu.toggle}
                  />
                  <Menu
                    open={menu.open}
                    anchor={menu.anchor}
                    onClose={menu.close}
                    placement="bottom-end"
                    label="Thread actions"
                    className="thread-menu"
                    groups={menuGroups}
                    onError={e => setError(e.message)}
                  />
                </div>
              )}
            </header>
            <div
              className="reader-scroll"
              ref={scroller}
              onScroll={e => {
                const next = e.currentTarget.scrollTop > 2;
                if (next !== moved) setMoved(next);
              }}
            >
              {thread.status === 'spam' && (
                <div className="spam-banner">
                  <ShieldAlert size={17} />
                  <span>
                    This message is in Spam. Links and remote images are disabled until you restore
                    it.
                  </span>
                </div>
              )}
              {ai}
              <h1 ref={title} className="reader-title">
                {thread.subject || '(No subject)'}
              </h1>
              {error && (
                <Notice
                  action={
                    <IconButton
                      label="Dismiss"
                      size="xs"
                      icon={X}
                      tooltip={false}
                      onClick={() => setError('')}
                    />
                  }
                >
                  {error}
                </Notice>
              )}
              {inlineLoading && (
                <p className="inline-image-status">
                  <Spinner size={12} /> Loading inline images…
                </p>
              )}
              {inlineError && (
                <Notice
                  action={
                    <Button
                      variant="text"
                      size="sm"
                      onClick={() => setInlineRetry(value => value + 1)}
                    >
                      Retry
                    </Button>
                  }
                >
                  {inlineError}
                </Notice>
              )}
              {thread.messages.map(m => {
                const open = expanded.has(m.id);
                const quoted = quotes.has(m.id);
                const content = prepareMessageBody(m, {
                  remote,
                  spam: thread.status === 'spam',
                  inline: inlineFiles,
                  query: needle,
                });
                const name = m.fromName || m.from;
                const toggle = () =>
                  setExpanded(prev => {
                    const n = new Set(prev);
                    n.has(m.id) ? n.delete(m.id) : n.add(m.id);
                    return n;
                  });
                return (
                  <article className={cx('message', !open && 'collapsed')} key={m.id}>
                    <div className="message-heading">
                      <button
                        className="message-toggle"
                        onClick={toggle}
                        aria-expanded={open}
                        aria-label={(open ? 'Collapse' : 'Expand') + ' message from ' + name}
                      />
                      {open && !ghost ? (
                        <Sender message={m} />
                      ) : (
                        <span className="sender-static">
                          <Avatar name={name} size={28} />
                          <strong>{name}</strong>
                        </span>
                      )}
                      {!open && <span className="preview">{m.text.slice(0, 240)}</span>}
                      <time className="message-date" dateTime={m.date} title={fullDate(m.date)}>
                        {dateLabel(m.date, true)}
                      </time>
                    </div>
                    {open && (
                      <div className="message-content">
                        {!remote && content.hasRemoteImages && thread.status !== 'spam' && (
                          <button className="remote-image-button" onClick={() => setRemote(true)}>
                            <ImageOff size={14} />
                            Remote images hidden · Load images
                          </button>
                        )}
                        <div
                          className="email-body"
                          onClick={handleEmailLink}
                          dangerouslySetInnerHTML={{ __html: content.body }}
                        />
                        {content.quoted && (
                          <>
                            <Tooltip content={quoted ? 'Hide quoted text' : 'Show quoted text'}>
                              <button
                                className={cx('quoted-toggle', quoted && 'is-open')}
                                aria-label={quoted ? 'Hide quoted text' : 'Show quoted text'}
                                aria-expanded={quoted}
                                onClick={() =>
                                  setQuotes(prev => {
                                    const n = new Set(prev);
                                    n.has(m.id) ? n.delete(m.id) : n.add(m.id);
                                    return n;
                                  })
                                }
                              >
                                <MoreHorizontal size={16} />
                              </button>
                            </Tooltip>
                            {quoted && (
                              <div
                                className="quoted-content email-body"
                                onClick={handleEmailLink}
                                dangerouslySetInnerHTML={{ __html: content.quoted }}
                              />
                            )}
                          </>
                        )}
                        {m.attachments.length > 0 && (
                          <div className="message-attachments">
                            {m.attachments.map(a => (
                              <div className="attachment" key={a.id}>
                                <button
                                  className="attachment-open"
                                  onClick={() => void attachment(a)}
                                  disabled={!!busy || thread.status === 'spam'}
                                >
                                  {busy === a.id ? <Spinner size={14} /> : <Paperclip size={14} />}
                                  <span>{a.name}</span>
                                  <span className="attachment-size">
                                    {Math.ceil(a.size / 1024)} KB
                                  </span>
                                </button>
                                <IconButton
                                  label={'Download ' + a.name}
                                  size="xs"
                                  icon={Download}
                                  iconSize={14}
                                  disabled={thread.status === 'spam'}
                                  onClick={() => void attachment(a, true)}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
              {replySlot}
            </div>
          </div>
        </div>
      </div>
      {replySlot ? null : binned ? (
        <footer className="reader-dock" aria-label="Thread actions">
          {thread.status === 'spam' && (
            <IconButton
              variant="glass"
              size="lg"
              className="dock-icon"
              label="Move to Trash"
              shortcut="#"
              placement="top"
              icon={Trash2}
              iconSize={17}
              onClick={() => triage('trash')}
            />
          )}
          <button className="dock-pill restore" onClick={restoreThread}>
            <RotateCcw size={17} />
            <span>Restore</span>
          </button>
          {thread.status === 'spam' && (
            <Tooltip content="Done" shortcut={'E'}>
              <button
                className="dock-pill done"
                aria-label="Mark Done"
                onClick={() => triage('done')}
              >
                <Check size={18} />
                <span>Done</span>
              </button>
            </Tooltip>
          )}
          <IconButton
            variant="glass"
            size="lg"
            className="dock-icon"
            label="Undo"
            shortcut="Z"
            placement="top"
            icon={Undo2}
            iconSize={17}
            onClick={undo}
          />
        </footer>
      ) : (
        <footer className="reader-dock" aria-label="Thread actions">
          <IconButton
            variant="glass"
            size="lg"
            className="dock-icon"
            label={thread.bookmarked ? 'Remove bookmark' : 'Save to Bookmarks'}
            shortcut="B"
            placement="top"
            active={thread.bookmarked}
            onClick={() =>
              bookmark ? bookmark() : void patch([thread.id], { bookmarked: !thread.bookmarked })
            }
          >
            <Bookmark
              key={String(thread.bookmarked)}
              className={thread.bookmarked ? 'pop' : undefined}
              size={17}
              fill={thread.bookmarked ? 'currentColor' : 'none'}
            />
          </IconButton>
          {doneRight ? laterPill : donePill}
          {replyButton}
          {doneRight ? donePill : laterPill}
          <IconButton
            variant="glass"
            size="lg"
            className="dock-icon"
            label="Undo"
            shortcut="Z"
            placement="top"
            icon={Undo2}
            iconSize={17}
            onClick={undo}
          />
        </footer>
      )}
      {!ghost && (
        <DuePicker
          open={dates && !!dueAnchor}
          anchor={dueAnchor}
          thread={thread}
          patch={patch}
          onClose={() => setDates(false)}
        />
      )}
      <Dialog
        open={!!preview}
        onClose={() => setPreview(undefined)}
        label="Attachment preview"
        className="attachment-preview"
      >
        {shownPreview && (
          <>
            <header>
              <strong>{shownPreview.name}</strong>
              <div className="actions">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Download}
                  onClick={() => void saveFile(shownPreview.name, shownPreview.data!)}
                >
                  Download
                </Button>
                <DialogClose label="Close preview" onClick={() => setPreview(undefined)} />
              </div>
            </header>
            {shownPreview.type.startsWith('image/') ? (
              <img
                src={`data:${shownPreview.type};base64,${shownPreview.data}`}
                alt={shownPreview.name}
              />
            ) : shownPreview.type.startsWith('text/') ? (
              <pre>
                {new TextDecoder().decode(
                  Uint8Array.from(atob(shownPreview.data!), c => c.charCodeAt(0)),
                )}
              </pre>
            ) : (
              <div className="file-preview-fallback">
                <Paperclip size={40} />
                <h2>{shownPreview.name}</h2>
                <p>This file opens best in its own app.</p>
                <Button
                  variant="primary"
                  iconRight={ExternalLink}
                  onClick={() =>
                    void saveFile(shownPreview.name, shownPreview.data!, true).catch(e =>
                      setError(e.message),
                    )
                  }
                >
                  Open file
                </Button>
              </div>
            )}
          </>
        )}
      </Dialog>
    </section>
  );
}

/** The sender's name; hovering (after a moment) or clicking shows who it was from and to, and when. */
function Sender({ message }: { message: Message }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [copied, setCopied] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const later = (fn: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  const close = useCallback(() => {
    clearTimeout(timer.current);
    pinned.current = false;
    setOpen(false);
    setAll(false);
  }, []);
  const leave = () => {
    if (!pinned.current) later(close, 220);
  };
  const from = person(message.fromName ? `${message.fromName} <${message.from}>` : message.from);
  const name = message.fromName || message.from;
  async function copy(email: string) {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(email);
      setTimeout(() => setCopied(value => (value === email ? '' : value)), 1400);
    } catch {
      /* Clipboard access can be refused; the address stays selectable. */
    }
  }
  const address = (p: Person, key: string) => (
    <button
      key={key}
      className={cx('address', copied === p.email && 'is-copied')}
      onClick={() => void copy(p.email)}
      title={'Copy ' + p.email}
    >
      {p.name && <span className="address-name">{p.name}</span>}
      <span className="address-email">{copied === p.email ? 'Copied' : p.email}</span>
    </button>
  );
  const group = (label: string, list: string[]) => {
    if (!list.length) return null;
    const people = list.map(person);
    const shown = all ? people : people.slice(0, 4);
    return (
      <div className="sender-card-row">
        <span className="sender-card-label">{label}</span>
        <span className="sender-card-people">
          {shown.map((p, i) => address(p, label + i))}
          {people.length > shown.length && (
            <button className="address more" onClick={() => setAll(true)}>
              {people.length - shown.length} more
            </button>
          )}
        </span>
      </div>
    );
  };
  return (
    <>
      <button
        ref={trigger}
        className={cx('sender-trigger', open && 'is-open')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerEnter={e => {
          if (e.pointerType !== 'mouse') return;
          if (open) clearTimeout(timer.current);
          else later(() => setOpen(true), 380);
        }}
        onPointerLeave={leave}
        onClick={e => {
          e.stopPropagation();
          if (open && pinned.current) {
            close();
            return;
          }
          clearTimeout(timer.current);
          pinned.current = true;
          setOpen(true);
          if (e.detail === 0)
            requestAnimationFrame(() =>
              body.current?.querySelector<HTMLElement>('button')?.focus(),
            );
        }}
      >
        <Avatar name={name} size={28} />
        <strong>{name}</strong>
      </button>
      <Popover
        open={open}
        anchor={trigger.current}
        onClose={close}
        placement="bottom-start"
        gap={6}
        className="sender-card ui-surface"
        role="dialog"
        label={'Message from ' + name}
      >
        <div
          ref={body}
          className="sender-card-body"
          onPointerEnter={() => clearTimeout(timer.current)}
          onPointerLeave={leave}
        >
          <div className="sender-card-head">
            <Avatar name={name} size={36} />
            <span className="sender-card-who">
              <strong>{from.name || from.email}</strong>
              {address({ name: '', email: from.email }, 'from')}
            </span>
          </div>
          {(message.to.length > 0 || !!message.cc?.length) && (
            <div className="sender-card-rows">
              {group('To', message.to)}
              {group('Cc', message.cc ?? [])}
            </div>
          )}
          {!message.to.length && !message.cc?.length && (
            <div className="sender-card-rows">
              <div className="sender-card-row">
                <span className="sender-card-label">To</span>
                <span className="sender-card-people muted">Undisclosed recipients</span>
              </div>
            </div>
          )}
          <time className="sender-card-date" dateTime={message.date}>
            {fullDate(message.date)}
          </time>
        </div>
      </Popover>
    </>
  );
}

/** Takes the summary's place when the model couldn't write one: the reason, a retry and, behind "?", what to do about it. */
function SummaryFailure({
  error,
  provider,
  retry,
}: {
  error: string;
  provider: SummaryProvider;
  retry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState<HTMLButtonElement | null>(null);
  const problem = describeSummaryError(error, provider);
  return (
    <div className="ai-failed" role="alert">
      <div className="ai-failed-text">
        <strong>Couldn’t summarize this email</strong>
        <span>{problem.title}</span>
      </div>
      <IconButton
        ref={setHelp}
        className={cx('ai-failed-help', open && 'is-open')}
        label="Why did this fail?"
        tooltip={!open}
        size="sm"
        icon={HelpCircle}
        iconSize={16}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      />
      <Button variant="secondary" size="sm" icon={RotateCcw} onClick={retry}>
        Retry
      </Button>
      <Popover
        open={open}
        anchor={help}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        gap={6}
        className="ai-failed-card ui-surface"
        role="dialog"
        label="Why the summary failed"
      >
        <strong>{problem.title}</strong>
        <p>{problem.detail}</p>
        <code>{error}</code>
      </Popover>
    </div>
  );
}

/** Due date and reminder, opened from the due pill in the summary card. */
function DuePicker({
  open,
  anchor,
  thread,
  patch,
  onClose,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  thread: Thread;
  patch: (ids: string[], p: Partial<Thread>, label?: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const nextWeek = (8 - new Date().getDay()) % 7 || 7;
  const current = thread.dueDate?.slice(0, 10) ?? '';
  const set = (dueDate: string, label: string) => {
    void patch([thread.id], { dueDate }, label);
    onClose();
  };
  const reminder = thread.reminderAt
    ? new Date(+new Date(thread.reminderAt) - new Date().getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : '';
  return (
    <Popover
      open={open}
      anchor={anchor}
      onClose={onClose}
      placement="bottom-end"
      gap={6}
      className="due-picker ui-surface"
      role="dialog"
      label="Due date and reminder"
    >
      <div className="due-picker-quick">
        {(
          [
            ['Today', 0],
            ['Tomorrow', 1],
            ['Next week', nextWeek],
          ] as const
        ).map(([label, offset]) => {
          const day = isoDay(offset);
          return (
            <button
              key={label}
              className={cx(current === day && 'is-current')}
              onClick={() => set(day, 'Due ' + label.toLowerCase())}
            >
              {label}
            </button>
          );
        })}
      </div>
      <label className="due-picker-field">
        <CalendarDays size={14} />
        <span>Due</span>
        <input
          aria-label="Due date"
          type="date"
          value={current}
          onChange={e => void patch([thread.id], { dueDate: e.target.value })}
        />
      </label>
      <label className="due-picker-field">
        <Bell size={14} />
        <span>Remind</span>
        <input
          aria-label="Reminder time"
          type="datetime-local"
          value={reminder}
          onChange={e =>
            void patch([thread.id], {
              reminderAt: e.target.value ? new Date(e.target.value).toISOString() : '',
              reminderFired: false,
            })
          }
        />
      </label>
      {(thread.dueDate || thread.reminderAt) && (
        <button
          className="due-picker-clear"
          onClick={() => {
            void patch([thread.id], { dueDate: '', reminderAt: '' }, 'Due date removed');
            onClose();
          }}
        >
          Remove due date{thread.reminderAt ? ' and reminder' : ''}
        </button>
      )}
    </Popover>
  );
}
