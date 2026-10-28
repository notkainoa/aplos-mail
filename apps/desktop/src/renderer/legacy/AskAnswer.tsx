import { memo, useMemo, useState } from 'react';
import {
  Bookmark,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheck,
  Clock,
  FileText,
  Inbox,
  Search,
  SquarePen,
  Undo2,
  Users,
} from './icons';
import { Avatar, Button, Checkbox, Notice, Tooltip, cx, type Icon } from './ui';
import type { AskStep, AskTriage, Draft, Thread } from '@aplos/contract/legacy/types';
import { invoke, plain } from './bridge';

/** Ask's answer body: the tool steps it took, the streamed text with inline citations, and its source chips. */

const stepIcons: Record<string, Icon> = {
  search_mail: Search,
  read_thread: FileText,
  list_events: CalendarDays,
  find_contact: Users,
  current_context: Inbox,
  propose_draft: SquarePen,
  propose_event: CalendarDays,
  propose_triage: CircleCheck,
  wait: Clock,
};
/** One calm sentence for collapsed steps, e.g. "Searched mail, read 2 emails". */
function summary(steps: AskStep[]) {
  const n = (tool: string) => steps.filter(s => s.tool === tool).length;
  const parts = [
    n('search_mail') && 'searched mail',
    n('read_thread') && `read ${n('read_thread')} email${n('read_thread') === 1 ? '' : 's'}`,
    n('list_events') && 'checked your calendar',
    n('find_contact') &&
      `looked up ${n('find_contact') === 1 ? 'a contact' : n('find_contact') + ' contacts'}`,
    n('current_context') && 'checked what’s open',
    (n('propose_draft') || n('propose_event') || n('propose_triage')) && 'prepared a card',
  ].filter((part): part is string => !!part);
  const text = parts.length
    ? parts.join(', ')
    : `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  return text[0].toUpperCase() + text.slice(1);
}

/** What the live line says while nothing is running: before any tool, "Thinking"; after them, "Writing". */
const idle = (steps: AskStep[]) => (steps.length ? 'Writing the answer' : 'Thinking');
/**
 * Ask's working state and its tool steps. Live: finished steps sit quietly above one shimmering line for what is
 * happening now. Finished (or once the answer streams): a single summary line that opens the list.
 */
export function AskSteps({ steps, live }: { steps: AskStep[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  // A finished wait is not part of the answer.
  const shown = steps.filter(s => s.tool !== 'wait' || s.status === 'running');
  if (live) {
    const done = shown.filter(s => s.status !== 'running'),
      running = shown.filter(s => s.status === 'running');
    return (
      <ol className="ask-steps is-live" aria-label="Working">
        {done.map(s => (
          <Step key={s.id} step={s} />
        ))}
        {running.length ? (
          running.map(s => <Step key={s.id} step={s} />)
        ) : (
          <li className="ask-step is-running">
            <span className="ask-step-icon">
              <i className="ask-pulse" />
            </span>
            <span className="ask-step-label">{idle(shown)}</span>
          </li>
        )}
      </ol>
    );
  }
  if (!shown.length) return null;
  return (
    <div className="ask-steps">
      <button
        className={cx('ask-steps-toggle', open && 'is-open')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>{summary(shown)}</span>
        <ChevronRight size={11} />
      </button>
      {open && (
        <ol className="ask-steps-list">
          {shown.map(s => (
            <Step key={s.id} step={s} />
          ))}
        </ol>
      )}
    </div>
  );
}
function Step({ step }: { step: AskStep }) {
  const Glyph = stepIcons[step.tool] ?? Search;
  return (
    <li className={cx('ask-step', 'is-' + step.status)}>
      <span className="ask-step-icon">
        {step.status === 'running' ? <i className="ask-pulse" /> : <Glyph size={12} />}
      </span>
      <span className="ask-step-label">{step.label}</span>
      {step.count !== undefined && step.status === 'done' && (
        <span className="ask-step-count">{step.count}</span>
      )}
      {step.status === 'error' && <span className="ask-step-count">didn’t work</span>}
    </li>
  );
}

type Cite = (index: number) => Thread | undefined;
/** Light Markdown: **bold**, "- " bullets and citation markers [^n], which become small numbered chips. Put `is-streaming` on the container for a caret. */
export const Prose = memo(function Prose({
  text,
  cite,
  onThread,
  streaming,
}: {
  text: string;
  cite?: Cite;
  onThread?: (id: string) => void;
  streaming?: boolean;
}) {
  const chip = (index: number, key: string) => {
    const t = cite?.(index);
    if (!t) return null;
    const last = t.messages.at(-1);
    return (
      <Tooltip
        key={key}
        content={t.subject || '(no subject)'}
        detail={last?.fromName || last?.from}
      >
        <button
          className="ask-cite"
          aria-label={`Source ${index}: ${t.subject}`}
          onClick={() => onThread?.(t.id)}
        >
          {index}
        </button>
      </Tooltip>
    );
  };
  const bold = (text: string, key: string) =>
    text
      .split(/(\*\*.+?\*\*)/g)
      .map((part, i) =>
        /^\*\*.+\*\*$/.test(part) ? <strong key={key + i}>{part.slice(2, -2)}</strong> : part,
      );
  const inline = (raw: string, key: string) => {
    // Chips sit against the word they support ("closed out¹."), and a half-streamed "**" is not shown.
    let line = raw
      .replace(/\s*([.,;:!?])\s*((?:\[\^\d+\])+)/g, '$2$1')
      .replace(/\s+(\[\^\d+\])/g, '$1');
    if ((line.match(/\*\*/g) ?? []).length % 2)
      line = line.slice(0, line.lastIndexOf('**')) + line.slice(line.lastIndexOf('**') + 2);
    const parts = line.split(/((?:\[\^\d+\])+)/g);
    const out: React.ReactNode[] = [];
    parts.forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) out.push(...bold(part, `${key}${i}-`));
        return;
      }
      // The last word and its chips never wrap apart.
      const before =
        out.length && typeof out[out.length - 1] === 'string' ? (out.pop() as string) : '';
      const split = before.search(/\S+$/);
      if (split > 0) out.push(before.slice(0, split));
      out.push(
        <span key={`${key}${i}`} className="ask-cite-tail">
          {split >= 0 ? before.slice(split) : before}
          {[...part.matchAll(/\[\^(\d+)\]/g)].map((m, j) => chip(Number(m[1]), `${key}${i}-${j}`))}
        </span>,
      );
    });
    return out;
  };
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      const items = list;
      blocks.push(
        <ul key={blocks.length}>
          {items.map((item, i) => (
            <li key={i}>{inline(item, `l${blocks.length}-${i}-`)}</li>
          ))}
        </ul>,
      );
    }
    list = [];
  };
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flush();
    if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line, `p${blocks.length}-`)}</p>);
  }
  flush();
  // The caret itself is drawn after the last line by CSS (.is-streaming), so it sits inside the text.
  if (streaming && !blocks.length) blocks.push(<p key="empty" />);
  return <>{blocks}</>;
});

/** The mail an answer relied on, numbered like the inline chips. */
export function AskSources({
  citations,
  threads,
  onThread,
}: {
  citations: string[];
  threads: Map<string, Thread>;
  onThread: (id: string) => void;
}) {
  const list = citations
    .map((id, i) => ({ id, index: i + 1, thread: threads.get(id) }))
    .filter(c => c.thread);
  if (!list.length) return null;
  return (
    <div className="ask-citations">
      {list.map(({ id, index, thread }) => {
        const last = thread!.messages.at(-1);
        const name = last?.fromName || last?.from || thread!.subject;
        return (
          <button key={id} onClick={() => onThread(id)} title={`${name} · ${thread!.subject}`}>
            <Avatar name={name} size={18} />
            <span>{thread!.subject || '(no subject)'}</span>
            <small>{index}</small>
          </button>
        );
      })}
    </div>
  );
}

/** A draft Ask wrote. Opening or applying it is the user's step; nothing is sent from here. */
export function AskDraftCard({
  proposal,
  threads,
  hasDraft,
  onApply,
}: {
  proposal: Partial<Draft>;
  threads: Map<string, Thread>;
  hasDraft: boolean;
  onApply: () => void;
}) {
  const reply = proposal.threadId ? threads.get(proposal.threadId) : undefined;
  const preview = useMemo(() => plain(proposal.html ?? ''), [proposal.html]);
  const subject =
    proposal.subject ||
    (reply ? 'Re: ' + reply.subject.replace(/^(Re|Fwd):\s*/i, '') : 'New message');
  const to =
    proposal.to || (reply ? reply.messages.at(-1)?.fromName || reply.messages.at(-1)?.from : '');
  return (
    <div className="ask-card ask-draft">
      <header className="ask-card-kind">
        <SquarePen size={13} />
        <span>{reply ? 'Reply' : 'New email'}</span>
      </header>
      <div className="ask-draft-head">
        <strong className="ask-card-title">{subject}</strong>
        {to && <small>To {to}</small>}
      </div>
      {preview && <p className="ask-draft-preview">{preview}</p>}
      <footer>
        <span className="ask-card-note">Not sent until you send it</span>
        <Button variant="primary" size="sm" onClick={onApply}>
          {hasDraft ? 'Apply to draft' : 'Open draft'}
        </Button>
      </footer>
    </div>
  );
}

const triageCopy = {
  done: {
    icon: CircleCheck,
    title: 'Mark Done',
    verb: (n: number) => `Mark ${n} Done`,
    applied: 'Marked Done',
    patch: { status: 'done' } as Partial<Thread>,
    has: (t: Thread) => t.status === 'done',
  },
  later: {
    icon: Clock,
    title: 'Move to Later',
    verb: (n: number) => `Move ${n} to Later`,
    applied: 'Moved to Later',
    patch: { status: 'later' } as Partial<Thread>,
    has: (t: Thread) => t.status === 'later',
  },
  bookmark: {
    icon: Bookmark,
    title: 'Save to Bookmarks',
    verb: (n: number) => `Bookmark ${n}`,
    applied: 'Saved to Bookmarks',
    patch: { bookmarked: true } as Partial<Thread>,
    has: (t: Thread) => t.bookmarked,
  },
};
/** Triage Ask prepared. The user can untick emails, confirm, and undo right here. */
export function AskTriageCard({
  triage,
  threads,
  notify,
  onThread,
}: {
  triage: AskTriage;
  threads: Map<string, Thread>;
  notify: (text: string) => void;
  onThread: (id: string) => void;
}) {
  const copy = triageCopy[triage.action];
  const list = triage.threadIds.map(id => threads.get(id)).filter((t): t is Thread => !!t);
  const [skip, setSkip] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [undoable, setUndoable] = useState(false);
  const chosen = list.filter(t => !skip.has(t.id));
  // Applied once every chosen email already has the state, whether from this card or elsewhere.
  const applied = chosen.length > 0 && chosen.every(copy.has);
  async function run() {
    setBusy(true);
    setError('');
    try {
      await invoke('thread.update', {
        ids: chosen.filter(t => !copy.has(t)).map(t => t.id),
        patch: copy.patch,
        compact: true,
      });
      setUndoable(true);
      notify(`${copy.applied} · ${chosen.length} email${chosen.length === 1 ? '' : 's'}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    setBusy(true);
    setError('');
    try {
      await invoke('thread.undo', { compact: true });
      setUndoable(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!list.length) return null;
  return (
    <div className={cx('ask-card ask-triage', applied && 'is-done')}>
      <header className="ask-card-kind">
        {applied ? <Check size={13} className="ask-card-check" /> : <copy.icon size={13} />}
        <span>{applied ? copy.applied : copy.title}</span>
      </header>
      {triage.reason && !applied && <p className="ask-triage-reason">{triage.reason}</p>}
      <ul className="ask-triage-list">
        {list.map(t => {
          const last = t.messages.at(-1);
          const name = last?.fromName || last?.from || '';
          const on = !skip.has(t.id);
          return (
            <li key={t.id} className={cx(!on && 'is-skipped')}>
              <Checkbox
                label={`Include ${t.subject}`}
                hideLabel
                checked={on}
                disabled={busy || applied}
                onChange={next =>
                  setSkip(s => {
                    const copy = new Set(s);
                    if (next) copy.delete(t.id);
                    else copy.add(t.id);
                    return copy;
                  })
                }
              />
              <button className="ask-triage-mail" onClick={() => onThread(t.id)}>
                <Avatar name={name || t.subject} size={20} />
                <span>
                  <strong>{name}</strong>
                  <span>{t.subject || '(no subject)'}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {error && <Notice>{error}</Notice>}
      <footer>
        {applied ? (
          <>
            <span className="ask-card-note">
              {chosen.length} email{chosen.length === 1 ? '' : 's'}
            </span>
            {undoable && (
              <Button
                variant="text"
                size="sm"
                icon={Undo2}
                loading={busy}
                onClick={() => void undo()}
              >
                Undo
              </Button>
            )}
          </>
        ) : (
          <>
            <span className="ask-card-note">
              {chosen.length} of {list.length} selected
            </span>
            <Button
              variant="primary"
              size="sm"
              icon={Check}
              loading={busy}
              disabled={!chosen.length}
              onClick={() => void run()}
            >
              {copy.verb(chosen.length)}
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}
