import type { Settings, ThreadAction, ThreadRow, ThreadSelector, ViewSpec } from '@aplos/contract';
import { accountsOf, type Fixture } from '../engine';
import type { Tx } from '../store';
import { dueBand, localDay } from '../time';
import { homeParts, runView, senderGroups } from '../views';
import { blobOf, ownBlob } from './core';
import { requireOriginating } from '@aplos/contract/access';
import { clean, fail, getRows, live, must, plainHtml, type Part } from './util';

/** The stand-in srcdoc's inner policy (freeze FR-34): no script, no network, inline styles and data: images only. */
export const srcdocCsp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const role = (t: ThreadRow, r: string) => `${t.accountId}:${r}`;
const withLabel = (t: ThreadRow, r: string, on: boolean) => {
  const id = role(t, r),
    has = t.labels.includes(id);
  return on === has ? t.labels : on ? [...t.labels, id] : t.labels.filter(l => l !== id);
};
const lanes = ['do', 'update', 'low'] as const;

const withLabelled = (t: ThreadRow, r: string, on: boolean): ThreadRow => ({
  ...t,
  labels: withLabel(t, r, on),
});

/** The row and workflow a handler edits, plus the settings and clock its action reads. */
interface ActionState {
  next: ThreadRow;
  w: ThreadRow['workflow'];
  settings: Settings;
  now: number;
  today: string;
}

type ActionOf<K extends ThreadAction['type']> = Extract<ThreadAction, { type: K }>;

/** What the account's `doneAction`/`laterAction` asks for after the status change. */
const after = (s: ActionState, mode: 'archive' | 'read' | 'unread') => {
  if (mode === 'archive') s.next.labels = withLabel(s.next, 'INBOX', false);
  else
    s.next = {
      ...s.next,
      unread: mode === 'unread',
      unreadCount: mode === 'unread' ? Math.max(1, s.next.unreadCount) : 0,
    };
};

const user = (s: ActionState, rank: Partial<ThreadRow['rank']>) => {
  s.next.rank = { ...s.next.rank, ...rank, source: 'user', rankedAt: s.now };
};

function actDone(s: ActionState) {
  s.w.status = 'done';
  s.w.doneAt = s.now;
  delete s.w.laterUntil;
  after(s, s.settings.mail.doneAction);
}

function actRestore(s: ActionState) {
  s.w.status = 'new';
  delete s.w.laterUntil;
  delete s.w.doneAt;
  s.w.hiddenFromHome = false;
  s.next.labels = withLabel(
    withLabelled(withLabelled(s.next, 'TRASH', false), 'SPAM', false),
    'INBOX',
    true,
  );
}

function actLater(s: ActionState, a: ActionOf<'later'>) {
  s.w.status = 'later';
  // Snoozed again, it comes back to Home at the new date even if Clear from Home took it off.
  s.w.hiddenFromHome = false;
  if (a.until === undefined) delete s.w.laterUntil;
  else s.w.laterUntil = a.until;
  after(s, s.settings.mail.laterAction);
}

function actTrash(s: ActionState) {
  s.next.labels = withLabel(withLabelled(s.next, 'INBOX', false), 'TRASH', true);
}

function actSpam(s: ActionState) {
  s.next.labels = withLabel(withLabelled(s.next, 'INBOX', false), 'SPAM', true);
}

function actReadState(s: ActionState, a: ActionOf<'read' | 'unread'>) {
  after(s, a.type);
}

function actFlag(s: ActionState, a: ActionOf<'flag'>) {
  s.next = { ...s.next, flagged: a.on, labels: withLabel(s.next, 'STARRED', a.on) };
}

function actBookmark(s: ActionState, a: ActionOf<'bookmark'>) {
  s.w.bookmarked = a.on;
}

function actDue(s: ActionState, a: ActionOf<'due'>) {
  if (a.date) {
    s.w.dueDate = a.date;
    s.w.dueSource = 'user';
  } else {
    delete s.w.dueDate;
    delete s.w.dueSource;
  }
  s.next.rank = { ...s.next.rank, dueBand: dueBand(s.w.dueDate, s.today) };
}

function actReminder(s: ActionState, a: ActionOf<'reminder'>) {
  // `clear` removes it (FR-28); without `at` it falls due after `mail.followUpDays`.
  if (a.clear) {
    delete s.w.reminderAt;
    delete s.w.reminderIfNoReply;
  } else {
    s.w.reminderAt = a.at ?? s.now + s.settings.mail.followUpDays * 86_400_000;
    s.w.reminderIfNoReply = !!a.ifNoReply;
  }
  delete s.w.reminderFiredAt;
}

function actLane(s: ActionState, a: ActionOf<'lane'>) {
  user(s, { lane: a.lane });
}

function actLaneStep(s: ActionState, a: ActionOf<'laneStep'>) {
  const i = lanes.indexOf(s.next.rank.lane as (typeof lanes)[number]);
  user(s, {
    lane: lanes[Math.max(0, Math.min(2, (i < 0 ? 1 : i) + (a.direction === 'up' ? -1 : 1)))]!,
  });
}

function actImportance(s: ActionState, a: ActionOf<'importance'>) {
  user(s, { importance: a.importance });
  s.next.labels = withLabel(s.next, 'IMPORTANT', a.importance === 'important');
}

function actReplyStatus(s: ActionState, a: ActionOf<'replyStatus'>) {
  s.w.replyStatus = a.status;
}

function actTodo(s: ActionState, a: ActionOf<'todo'>) {
  if (a.text) s.w.todo = a.text;
  else delete s.w.todo;
}

function actHome(s: ActionState, a: ActionOf<'home'>) {
  s.w.hiddenFromHome = a.hidden;
}

function actClearFromHome(s: ActionState) {
  // Back to Later with its own date (still Overdue there), off Home until acted on (FR-28).
  if (s.w.status === 'later' && s.next.fromLater) s.w.hiddenFromHome = true;
}

function actLabels(s: ActionState, a: ActionOf<'labels'>) {
  s.next.labels = [...new Set([...s.next.labels.filter(l => !a.remove.includes(l)), ...a.add])];
}

type ActionHandlers = {
  [K in ThreadAction['type']]: (s: ActionState, a: ActionOf<K>) => void;
};

const actionHandlers: ActionHandlers = {
  done: actDone,
  restore: actRestore,
  later: actLater,
  trash: actTrash,
  spam: actSpam,
  read: actReadState,
  unread: actReadState,
  flag: actFlag,
  bookmark: actBookmark,
  due: actDue,
  reminder: actReminder,
  lane: actLane,
  laneStep: actLaneStep,
  importance: actImportance,
  replyStatus: actReplyStatus,
  todo: actTodo,
  home: actHome,
  clearFromHome: actClearFromHome,
  labels: actLabels,
};

/** Applies one `Thread/act` action to a row (ARCH 3.2 workflow facts, DESIGN 7.2 for what Done and Later do). */
export function applyAction(
  t: ThreadRow,
  action: ThreadAction,
  settings: Settings,
  now: number,
  today: string,
): ThreadRow {
  const w = { ...t.workflow };
  const state: ActionState = { next: { ...t, workflow: w }, w, settings, now, today };
  const handle = actionHandlers[action.type] as (s: ActionState, a: ThreadAction) => void;
  handle(state, action);
  const next = state.next;
  // Acting on a Back from Later row moves it on; Later again waits for the new date.
  if (['done', 'restore', 'later', 'trash', 'spam', 'home'].includes(action.type))
    next.fromLater = false;
  w.editedAt = now;
  return next;
}

/** `Thread/act` inside a transaction, keeping each message's read flag in step with its thread. */
export function actOn(fx: Fixture, tx: Tx, ids: string[], action: ThreadAction) {
  const settings = must(fx.store, 'Settings', 'settings');
  const today = localDay(fx.now, fx.zone);
  for (const id of ids) {
    const t = tx.get('Thread', id) ?? fail('notFound', 'This conversation is no longer available.');
    const next = tx.put('Thread', applyAction(t, action, settings, fx.now, today));
    if (next.unread !== t.unread)
      for (const m of fx.store.all('Message').filter(m => m.threadId === id))
        tx.put('Message', { ...m, seen: !next.unread });
  }
}

function counts(fx: Fixture, accountId?: string) {
  const p = homeParts(fx.view, accountId);
  const mine = <T extends { accountId: string }>(rows: T[]) =>
    rows.filter(r => !accountId || r.accountId === accountId);
  const today = localDay(fx.now, fx.zone);
  // Moved off Home today: the last edit was today and left it Done, waiting in Later, or in Trash or Spam. Undo puts the
  // edit time back, so it subtracts.
  const handled = (t: ThreadRow) =>
    t.workflow.editedAt !== undefined &&
    localDay(t.workflow.editedAt, fx.zone) === today &&
    (t.workflow.status === 'done' ||
      (t.workflow.status === 'later' && !t.fromLater) ||
      t.labels.some(l => /:(TRASH|SPAM)$/.test(l)));
  return {
    home: p.doNew.length + p.fromLater.length + p.update.length,
    do: p.doNew.length + p.fromLater.length,
    update: p.update.length,
    follow: p.follow.length,
    laterDue: p.fromLater.length,
    drafts: mine(fx.store.all('Draft')).filter(d => !d.submissionId).length,
    scheduled: mine(fx.store.all('Submission')).filter(
      s => s.state === 'queued' || s.state === 'scheduled',
    ).length,
    unread: mine(fx.store.all('Thread')).filter(
      t => t.unread && t.labels.includes(`${t.accountId}:INBOX`),
    ).length,
    handledToday: mine(fx.store.all('Thread')).filter(handled).length,
  };
}

/** Windows, threads, operations, messages and bodies, the mail frame, blobs, unsubscribe and sender rules. */
export function mail(fx: Fixture) {
  const owned = (windowId: string, sessionId: string) => {
    const w = fx.window(windowId);
    return w.sessionId === sessionId
      ? w
      : fail('notFound', 'This list is no longer open. Reopen it.');
  };
  const folders = (accountId?: string) =>
    fx.store
      .all('Folder')
      .filter(f => !accountId || f.accountId === accountId)
      .map(f => {
        const inIt = fx.store
          .all('Thread')
          .filter(
            t =>
              t.labels.includes(f.id) ||
              (f.role === 'all' &&
                t.accountId === f.accountId &&
                !t.labels.some(l => /:(TRASH|SPAM)$/.test(l))),
          );
        return { ...f, unread: inIt.filter(t => t.unread).length, total: inIt.length };
      });
  const frameFor = (messageId: string, imagePolicy: 'block' | 'load', quotesOpen: boolean) => {
    must(fx.store, 'Message', messageId, 'This message is no longer available.');
    const token = `${fx.id('mf')}-${((fx.random() * 2 ** 32) >>> 0).toString(36)}`;
    const expiresAt = fx.now + 10 * 60_000;
    fx.mailFrames.set(token, { messageId, expiresAt, quotesOpen, imagePolicy });
    // ARCH 10 Stopgap: the srcdoc document carries its own CSP, so even inside the reader's sandbox it loads nothing.
    const srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${srcdocCsp}"><body>${plainHtml(fx.bodies[messageId] ?? '')}</body>`;
    return {
      url: `aplos-mail://m/${token}`,
      expiresAt,
      bodyKind: 'html',
      trackersRemoved: 0,
      hasRemoteImages: false,
      quotedCount: 0,
      srcdoc,
    };
  };
  const token = (url: string) => url.replace(/^aplos-mail:\/\/m\//, '').split('/')[0] ?? '';
  return {
    'View/watch': ({ spec, holdIds, anchor, limit }, cx) =>
      fx.openWindow(cx.sessionId, spec, holdIds, anchor, limit),
    'View/move': ({ windowId, anchor, limit, range }, cx) => {
      if (range && range.to - range.from > 62 * 86_400_000)
        fail('rangeTooLarge', 'Choose a range of at most 62 days.');
      return fx.moveWindow(owned(windowId, cx.sessionId), anchor, limit, range);
    },
    'View/unwatch': ({ windowId }) => {
      fx.closeWindow(windowId);
      return { ok: true as const };
    },
    'View/hold': ({ windowId, ids }, cx) => {
      fx.hold(owned(windowId, cx.sessionId), ids);
      return { ok: true as const };
    },
    'View/release': ({ windowId, ids }, cx) => {
      fx.release(owned(windowId, cx.sessionId), ids);
      return { ok: true as const };
    },
    'View/query': ({ spec, anchor, limit = 100 }) => {
      const r = runView(fx.view, spec);
      const position = Math.max(
        0,
        Math.min(
          anchor?.position ??
            (anchor?.id ? Math.max(0, r.ids.indexOf(anchor.id)) : 0) + (anchor?.offset ?? 0),
          Math.max(0, r.ids.length - 1),
        ),
      );
      return {
        state: fx.store.state,
        rowType: r.rowType,
        ids: spec.kind === 'events' ? r.ids : r.ids.slice(position, position + limit),
        position,
        total: r.ids.length,
        sections: r.sections,
      };
    },
    'Folder/get': ({ accountId }) => ({ state: fx.store.state, list: folders(accountId) }),
    'Counts/get': () => ({
      all: counts(fx),
      accounts: Object.fromEntries(fx.store.all('Account').map(a => [a.id, counts(fx, a.id)])),
      folders: Object.fromEntries(folders().map(f => [f.id, f.unread])),
    }),
    'SenderGroup/get': ({ ids }) => {
      const groups = new Map(senderGroups(fx.view).map(g => [g.id, g]));
      return {
        state: fx.store.state,
        list: ids.flatMap(id => groups.get(id) ?? []),
        notFound: ids.filter(id => !groups.has(id)),
      };
    },
    'Search/remote': ({ opId, query }, cx) => {
      const runId = fx.id('search');
      const { receipt } = fx.write(
        { opId, kind: 'Search/remote', undoable: false },
        () => undefined,
      );
      const script = fx.searchScripts.shift();
      const step = { id: 'server', text: 'Searching the mail server' };
      const progress = (frame: Record<string, unknown>) =>
        fx.emit({ frame: 'progress', runId, source: 'search', ...frame } as never, cx.sessionId);
      fx.clock.after(100, () => progress({ kind: 'step', step: { ...step, state: 'running' } }));
      fx.clock.after(600, () => {
        // A scripted failure: the run reports it and the search windows stop with it (`paused`, `unavailable`).
        if (script?.error) {
          const error = script.error;
          progress({ kind: 'step', step: { ...step, state: 'error' } });
          progress({
            kind: 'error',
            problem: clean({ reasonCode: error.reasonCode ?? error.type, message: error.message }),
          });
          fx.stopWindows(cx.sessionId, 'search', error);
        } else {
          const ids = (script?.ids ?? []).filter(id => fx.store.get('Thread', id));
          if (ids.length) {
            fx.remoteResults.set(query.text, [...(fx.remoteResults.get(query.text) ?? []), ...ids]);
            for (const w of fx.windows.values()) fx.refresh(w);
          }
          progress({ kind: 'step', step: { ...step, state: 'done', count: ids.length } });
        }
        progress({ kind: 'done' });
      });
      return { runId, receipt: { ...receipt, undoable: false } };
    },

    'Thread/get': ({ ids }) => getRows(fx.store, 'Thread', ids),
    'Thread/act': ({ opId, ids, selector, action }) => {
      const targets = selector ? resolveSelector(fx, selector) : ids!;
      for (const id of targets)
        must(fx.store, 'Thread', id, 'This conversation is no longer available.');
      return fx.write({ opId, kind: 'Thread/act', targets, provider: true }, tx =>
        actOn(fx, tx, targets, action),
      ).receipt;
    },
    'Thread/why': ({ threadId }) => {
      const t = must(fx.store, 'Thread', threadId, 'This conversation is no longer available.');
      const m = fx.store
        .all('Message')
        .filter(x => x.threadId === threadId && !x.fromMe)
        .sort((a, b) => b.date - a.date)[0];
      const quote = m
        ? (fx.bodies[m.id] ?? '')
            .replace(/^(hi|hello)[^\n]*\n/i, '')
            .split(/(?<=[.?!])\s/)[0]
            ?.trim()
            .slice(0, 300)
        : undefined;
      const lane =
        t.rank.lane === 'do'
          ? 'Do now'
          : t.rank.lane === 'low'
            ? 'Low importance'
            : 'Important updates';
      const sentence =
        t.rank.source === 'user'
          ? `You moved this to ${lane}.`
          : t.rank.source === 'rule'
            ? `Your rule for ${t.fromName} puts their mail in ${lane}.`
            : t.rank.lane === 'do'
              ? t.workflow.todo
                ? `${t.fromName} asked you something: ${t.workflow.todo.charAt(0).toLowerCase()}${t.workflow.todo.slice(1)}.`
                : `${t.fromName} asked you something and is waiting for a reply.`
              : t.rank.lane === 'low'
                ? `${t.fromName} sends notices and newsletters that rarely need you.`
                : `An update from ${t.fromName} worth knowing about, with nothing for you to do.`;
      return clean({
        threadId,
        sentence,
        quote: quote || undefined,
        messageId: quote ? m?.id : undefined,
        lane: t.rank.lane,
        rankSource: t.rank.source,
      });
    },
    'Thread/open': ({ threadId }) => {
      const t = must(fx.store, 'Thread', threadId, 'This conversation is no longer available.');
      if (t.partial) {
        const count = fx.store.all('Message').filter(m => m.threadId === threadId).length;
        fx.write({ kind: 'Thread/open' }, tx =>
          tx.put('Thread', { ...t, partial: false, messageCount: count }),
        );
      }
      return { threadId, complete: true, state: fx.store.state };
    },

    'Operation/undo': ({ opId, undoOpId }, cx) => {
      const rec = fx.ops.get(opId) ?? fail('notFound', 'This change can no longer be undone.');
      requireOriginating(cx.caller, rec);
      if (!rec.operation.undoable) fail('conflict', 'This change cannot be undone.');
      if (rec.operation.state === 'cancelled') fail('conflict', 'This change was already undone.');
      // A held send is undone by cancelling its submission, the same as `Submission/set` undo (freeze FR-14).
      if (rec.undo) {
        const receipt = rec.undo(undoOpId);
        rec.operation = { ...rec.operation, state: 'cancelled' };
        fx.emit({ frame: 'operation', operation: rec.operation });
        return receipt;
      }
      // Undo while still queued cancels the provider write; after it synced, the inverse goes to the provider in turn.
      const { receipt } = fx.write(
        {
          opId: undoOpId,
          kind: 'Operation/undo',
          targets: rec.operation.targets,
          provider: rec.operation.state === 'synced',
        },
        tx => {
          fx.settlePending(tx, rec);
          fx.restore(tx, rec.touched, 'before');
        },
      );
      rec.operation = { ...rec.operation, state: 'cancelled' };
      fx.emit({ frame: 'operation', operation: rec.operation });
      return receipt;
    },
    'Operation/get': ({ opIds }) => ({
      list: opIds.flatMap(id => fx.ops.get(id)?.operation ?? []),
      notFound: opIds.filter(id => !fx.ops.has(id)),
    }),
    'Operation/retry': ({ opId }, cx) => {
      const rec = fx.ops.get(opId) ?? fail('notFound', 'This change is no longer in the queue.');
      requireOriginating(cx.caller, rec);
      if (rec.operation.state !== 'failed')
        fail('conflict', 'Only a failed change can be retried.');
      fx.write({ kind: 'Operation/retry' }, tx => {
        fx.restore(tx, rec.touched, 'after');
        for (const id of accountsOf(rec.touched))
          if (fx.bumpPending(tx, id, 1)) rec.pending.push(id);
      });
      const { error: _, ...operation } = rec.operation;
      rec.operation = { ...operation, state: 'queued', appliedState: fx.store.state };
      fx.syncLater(opId);
      return { opId, appliedState: fx.store.state, undoable: rec.operation.undoable };
    },

    'Message/get': ({ ids }) => getRows(fx.store, 'Message', ids),
    'MessageBody/get': ({ messageId }) => {
      must(fx.store, 'Message', messageId, 'This message is no longer available.');
      return {
        messageId,
        bodyKind: 'html',
        text: fx.bodies[messageId] ?? '',
        quoted: [],
        quotedCount: 0,
        hasRemoteImages: false,
      };
    },
    'MessageBody/prefetch': () => ({ ok: true as const }),
    'Mail/frame': ({ messageId, imagePolicy, quotesOpen }) =>
      frameFor(messageId, imagePolicy, !!quotesOpen),
    'Mail/allowImages': ({ opId, sender, allow }) => {
      const s = must(fx.store, 'Settings', 'settings');
      const match = sender.toLowerCase(),
        list = s.mail.imageAllowList.filter(x => x !== match);
      return fx.write({ opId, kind: 'Mail/allowImages' }, tx =>
        tx.put('Settings', {
          ...s,
          mail: { ...s.mail, imageAllowList: allow ? [...list, match] : list },
        }),
      ).receipt;
    },
    'Mail/release': ({ url }) => {
      fx.mailFrames.delete(token(url));
      return { ok: true as const };
    },
    'Mail/toggleQuotes': ({ url, open }) => {
      const frame =
        fx.mailFrames.get(token(url)) ??
        fail('notFound', 'This message view has expired. Open the message again.');
      fx.mailFrames.delete(token(url));
      return frameFor(frame.messageId, frame.imagePolicy, open);
    },
    'Mail/serve': ({ token: t }) => {
      const frame = fx.mailFrames.get(t);
      const notFound: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
      if (!frame || frame.expiresAt < fx.now)
        return { status: 404, headers: notFound, body: new TextEncoder().encode('Not found') };
      const html = `<!doctype html><meta charset="utf-8"><body>${plainHtml(fx.bodies[frame.messageId] ?? '')}</body>`;
      return {
        status: 200,
        headers: <Record<string, string>>{
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; img-src aplos-mail: data:",
          'cache-control': 'no-store',
        },
        body: new TextEncoder().encode(html),
      };
    },
    'Attachment/get': ({ messageId, attachmentId }, cx) => {
      const file =
        fx.files[`${messageId}/${attachmentId}`] ??
        fail('notFound', 'This attachment is no longer available.');
      return {
        blobId: blobOf(fx, cx.caller, file.bytes, file.mime, file.name),
        name: file.name,
        mime: file.mime,
        size: file.bytes.length,
      };
    },
    'Message/original': ({ messageId }, cx) => {
      const m = must(fx.store, 'Message', messageId, 'This message is no longer available.');
      const header = (name: string, list: { address: string; name?: string }[]) =>
        list.length
          ? `${name}: ${list.map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}\r\n`
          : '';
      const raw = `${header('From', m.from ? [m.from] : [])}${header('To', m.to)}Subject: ${m.subject}\r\nDate: ${new Date(m.date).toUTCString()}\r\nMessage-ID: ${m.internetId ?? `<${m.id}@fixture.example>`}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${fx.bodies[messageId] ?? ''}\r\n`;
      const bytes = new TextEncoder().encode(raw);
      const name = `${m.subject.replace(/[^\w -]+/g, '').slice(0, 60) || 'message'}.eml`;
      return {
        blobId: blobOf(fx, cx.caller, bytes, 'message/rfc822', name),
        name,
        size: bytes.length,
      };
    },

    'Blob/put': ({ bytes, mime, name }, cx) => {
      if (bytes.length > 25 * 1024 * 1024) fail('tooLarge', 'Files can be at most 25 MB.');
      return { blobId: blobOf(fx, cx.caller, bytes, mime, name), size: bytes.length };
    },
    'Blob/get': ({ blobId }, cx) => {
      const b = ownBlob(fx, cx.caller, blobId, 'This file is no longer available.');
      return clean({ bytes: b.bytes, mime: b.mime, name: b.name, size: b.bytes.length });
    },
    'Blob/release': ({ blobId }, cx) => {
      ownBlob(fx, cx.caller, blobId, 'This file is no longer available.');
      // An attachment of a held, failed or suspended send stays until the send settles (FR-7).
      const held = fx.store
        .all('Draft')
        .some(
          d =>
            d.submissionId &&
            live.has(fx.store.get('Submission', d.submissionId)?.state ?? '') &&
            d.attachments.some(a => a.blobId === blobId),
        );
      if (held) fail('stateMismatch', 'This file is attached to a message waiting to send.');
      fx.blobs.delete(blobId);
      return { ok: true as const };
    },

    'Unsubscribe/get': ({ threadId }) => {
      const t = must(fx.store, 'Thread', threadId, 'This conversation is no longer available.');
      return t.unsubscribe ? { method: 'oneClick' } : { method: 'none' };
    },
    'Unsubscribe/run': ({ opId, threadId }) => {
      const t = must(fx.store, 'Thread', threadId, 'This conversation is no longer available.');
      if (!t.unsubscribe)
        return {
          outcome: 'unavailable',
          message: 'This sender does not offer a way to unsubscribe.',
        };
      const { receipt } = fx.write(
        { opId, kind: 'Unsubscribe/run', targets: [threadId], undoable: false },
        tx => tx.put('Thread', { ...t, unsubscribe: false }),
      );
      return { outcome: 'done', message: `You are unsubscribed from ${t.fromName}.`, receipt };
    },

    'SenderRule/get': ({ accountId }) => ({
      state: fx.store.state,
      list: fx.store
        .all('SenderRule')
        .filter(r => !accountId || !r.accountId || r.accountId === accountId),
    }),
    'SenderRule/set': ({ opId, id, accountId, match, action, lane }) => {
      const prev = id ? must(fx.store, 'SenderRule', id, 'This rule no longer exists.') : undefined;
      const rule = clean({
        id: id ?? fx.id('rule'),
        rev: prev?.rev ?? 0,
        accountId,
        match: match.toLowerCase(),
        action,
        lane,
        atProvider: false,
        createdAt: prev?.createdAt ?? fx.now,
      });
      const { value, receipt } = fx.write({ opId, kind: 'SenderRule/set' }, tx => {
        const saved = tx.put('SenderRule', rule);
        if (action === 'lane' && lane)
          for (const t of senderThreads(fx, rule.match, accountId))
            tx.put('Thread', { ...t, rank: { ...t.rank, lane, source: 'rule' } });
        return saved;
      });
      return { rule: value, receipt };
    },
    'SenderRule/destroy': ({ opId, id }) => {
      must(fx.store, 'SenderRule', id, 'This rule no longer exists.');
      return fx.write({ opId, kind: 'SenderRule/destroy' }, tx => tx.del('SenderRule', id)).receipt;
    },
    'SenderRule/block': ({ opId, address, accountId }) => {
      const rule = clean({
        id: fx.id('rule'),
        rev: 0,
        accountId,
        match: address.toLowerCase(),
        action: 'block',
        atProvider: false,
        createdAt: fx.now,
      });
      const { value, receipt } = fx.write(
        { opId, kind: 'SenderRule/block', provider: true },
        tx => {
          for (const t of senderThreads(fx, rule.match, accountId))
            actOn(fx, tx, [t.id], { type: 'spam' });
          return tx.put('SenderRule', rule);
        },
      );
      return { rule: value, receipt };
    },
    'SenderRule/unblock': ({ opId, address }) =>
      fx.write({ opId, kind: 'SenderRule/unblock' }, tx => {
        for (const r of fx.store.all('SenderRule'))
          if (r.action === 'block' && r.match === address.toLowerCase()) tx.del('SenderRule', r.id);
      }).receipt,
  } satisfies Part;
}

/**
 * The threads a `ThreadSelector` names: the view (Low importance's band on Home is its own section view) or one of its
 * sections, without threads created after `atState`, which the owner never saw.
 */
function resolveSelector(fx: Fixture, { spec, section, atState }: ThreadSelector): string[] {
  if (atState.dbEpoch !== fx.store.dbEpoch)
    fail(
      'stateMismatch',
      'This list changed while you were looking at it. Look again, then try once more.',
    );
  const view: ViewSpec =
    spec.kind === 'home' && section === 'low'
      ? {
          kind: 'homeSection',
          section: 'low',
          ...(spec.accountId ? { accountId: spec.accountId } : {}),
        }
      : spec;
  const r = runView(fx.view, view);
  if (r.rowType !== 'Thread')
    fail('unsupported', 'Only a list of conversations can be acted on as a whole.');
  const run = section
    ? (r.sections.find(s => s.key === section) ?? fail('notFound', 'This section is empty now.'))
    : undefined;
  const ids = run ? r.ids.slice(run.start, run.start + run.count) : r.ids;
  return ids.filter(id => (fx.store.born.get(`Thread\u0000${id}`) ?? 0) <= atState.seq);
}

function senderThreads(fx: Fixture, match: string, accountId?: string) {
  return fx.store
    .all('Thread')
    .filter(
      t =>
        (!accountId || t.accountId === accountId) &&
        t.participants.some(
          p =>
            !p.me &&
            p.address &&
            (match.startsWith('@')
              ? p.address.toLowerCase().endsWith(match)
              : p.address.toLowerCase() === match),
        ),
    );
}
