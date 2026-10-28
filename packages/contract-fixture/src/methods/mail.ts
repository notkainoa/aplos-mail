import type { Settings, ThreadAction, ThreadRow, ThreadSelector, ViewSpec } from '@aplos/contract';
import { accountsOf, type Fixture } from '../engine';
import type { Tx } from '../store';
import { dueBand, localDay } from '../time';
import { homeParts, runView, senderGroups } from '../views';
import { blobOf } from './core';
import { clean, fail, getRows, must, plainHtml, type Part } from './util';

const role = (t: ThreadRow, r: string) => `${t.accountId}:${r}`;
const withLabel = (t: ThreadRow, r: string, on: boolean) => {
  const id = role(t, r),
    has = t.labels.includes(id);
  return on === has ? t.labels : on ? [...t.labels, id] : t.labels.filter(l => l !== id);
};
const lanes = ['do', 'update', 'low'] as const;

/** Applies one `Thread/act` action to a row (ARCH 3.2 workflow facts, DESIGN 7.2 for what Done and Later do). */
export function applyAction(
  t: ThreadRow,
  action: ThreadAction,
  settings: Settings,
  now: number,
  today: string,
): ThreadRow {
  const w = { ...t.workflow };
  let next: ThreadRow = { ...t, workflow: w };
  const after = (mode: 'archive' | 'read' | 'unread') => {
    if (mode === 'archive') next.labels = withLabel(next, 'INBOX', false);
    else
      next = {
        ...next,
        unread: mode === 'unread',
        unreadCount: mode === 'unread' ? Math.max(1, next.unreadCount) : 0,
      };
  };
  const user = (rank: Partial<ThreadRow['rank']>) => {
    next.rank = { ...next.rank, ...rank, source: 'user', rankedAt: now };
  };
  switch (action.type) {
    case 'done':
      w.status = 'done';
      w.doneAt = now;
      delete w.laterUntil;
      after(settings.mail.doneAction);
      break;
    case 'restore':
      w.status = 'new';
      delete w.laterUntil;
      delete w.doneAt;
      w.hiddenFromHome = false;
      next.labels = withLabel(
        withLabelled(withLabelled(next, 'TRASH', false), 'SPAM', false),
        'INBOX',
        true,
      );
      break;
    case 'later':
      w.status = 'later';
      if (action.until === undefined) delete w.laterUntil;
      else w.laterUntil = action.until;
      after(settings.mail.laterAction);
      break;
    case 'trash':
      next.labels = withLabel(withLabelled(next, 'INBOX', false), 'TRASH', true);
      break;
    case 'spam':
      next.labels = withLabel(withLabelled(next, 'INBOX', false), 'SPAM', true);
      break;
    case 'read':
    case 'unread':
      after(action.type);
      break;
    case 'flag':
      next = { ...next, flagged: action.on, labels: withLabel(next, 'STARRED', action.on) };
      break;
    case 'bookmark':
      w.bookmarked = action.on;
      break;
    case 'due':
      if (action.date) {
        w.dueDate = action.date;
        w.dueSource = 'user';
      } else {
        delete w.dueDate;
        delete w.dueSource;
      }
      next.rank = { ...next.rank, dueBand: dueBand(w.dueDate, today) };
      break;
    case 'reminder':
      if (action.at === undefined) {
        delete w.reminderAt;
        delete w.reminderIfNoReply;
      } else {
        w.reminderAt = action.at;
        w.reminderIfNoReply = !!action.ifNoReply;
      }
      delete w.reminderFiredAt;
      break;
    case 'lane':
      user({ lane: action.lane });
      break;
    case 'laneStep': {
      const i = lanes.indexOf(next.rank.lane as (typeof lanes)[number]);
      user({
        lane: lanes[
          Math.max(0, Math.min(2, (i < 0 ? 1 : i) + (action.direction === 'up' ? -1 : 1)))
        ]!,
      });
      break;
    }
    case 'importance':
      user({ importance: action.importance });
      next.labels = withLabel(next, 'IMPORTANT', action.importance === 'important');
      break;
    case 'replyStatus':
      w.replyStatus = action.status;
      break;
    case 'todo':
      if (action.text) w.todo = action.text;
      else delete w.todo;
      break;
    case 'home':
      w.hiddenFromHome = action.hidden;
      break;
    case 'labels':
      next.labels = [
        ...new Set([...next.labels.filter(l => !action.remove.includes(l)), ...action.add]),
      ];
      break;
  }
  // Acting on a Back from Later row moves it on; Later again waits for the new date.
  if (['done', 'restore', 'later', 'trash', 'spam', 'home'].includes(action.type))
    next.fromLater = false;
  w.editedAt = now;
  return next;
}
const withLabelled = (t: ThreadRow, r: string, on: boolean): ThreadRow => ({
  ...t,
  labels: withLabel(t, r, on),
});

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
    const srcdoc = `<!doctype html><meta charset="utf-8"><body>${plainHtml(fx.bodies[messageId] ?? '')}</body>`;
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
    'Search/remote': ({ opId }, cx) => {
      const runId = fx.id('search');
      const { receipt } = fx.write(
        { opId, kind: 'Search/remote', undoable: false },
        () => undefined,
      );
      const step = { id: 'server', text: 'Searching the mail server' };
      fx.clock.after(100, () =>
        fx.emit(
          {
            frame: 'progress',
            runId,
            source: 'search',
            kind: 'step',
            step: { ...step, state: 'running' },
          },
          cx.sessionId,
        ),
      );
      fx.clock.after(600, () => {
        fx.emit(
          {
            frame: 'progress',
            runId,
            source: 'search',
            kind: 'step',
            step: { ...step, state: 'done', count: 0 },
          },
          cx.sessionId,
        );
        fx.emit({ frame: 'progress', runId, source: 'search', kind: 'done' }, cx.sessionId);
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
                ? `${t.fromName} is waiting on you: ${t.workflow.todo.charAt(0).toLowerCase()}${t.workflow.todo.slice(1)}.`
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

    'Operation/undo': ({ opId, undoOpId }) => {
      const rec = fx.ops.get(opId) ?? fail('notFound', 'This change can no longer be undone.');
      if (!rec.operation.undoable) fail('conflict', 'This change cannot be undone.');
      if (rec.operation.state === 'cancelled') fail('conflict', 'This change was already undone.');
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
    'Operation/retry': ({ opId }) => {
      const rec = fx.ops.get(opId) ?? fail('notFound', 'This change is no longer in the queue.');
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
    'Attachment/get': ({ messageId, attachmentId }) => {
      const file =
        fx.files[`${messageId}/${attachmentId}`] ??
        fail('notFound', 'This attachment is no longer available.');
      return {
        blobId: blobOf(fx, file.bytes, file.mime, file.name),
        name: file.name,
        mime: file.mime,
        size: file.bytes.length,
      };
    },
    'Message/original': ({ messageId }) => {
      const m = must(fx.store, 'Message', messageId, 'This message is no longer available.');
      const header = (name: string, list: { address: string; name?: string }[]) =>
        list.length
          ? `${name}: ${list.map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}\r\n`
          : '';
      const raw = `${header('From', m.from ? [m.from] : [])}${header('To', m.to)}Subject: ${m.subject}\r\nDate: ${new Date(m.date).toUTCString()}\r\nMessage-ID: ${m.internetId ?? `<${m.id}@fixture.example>`}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${fx.bodies[messageId] ?? ''}\r\n`;
      const bytes = new TextEncoder().encode(raw);
      const name = `${m.subject.replace(/[^\w -]+/g, '').slice(0, 60) || 'message'}.eml`;
      return { blobId: blobOf(fx, bytes, 'message/rfc822', name), name, size: bytes.length };
    },

    'Blob/put': ({ bytes, mime, name }) => {
      if (bytes.length > 25 * 1024 * 1024) fail('tooLarge', 'Files can be at most 25 MB.');
      return { blobId: blobOf(fx, bytes, mime, name), size: bytes.length };
    },
    'Blob/get': ({ blobId }) => {
      const b = fx.blobs.get(blobId) ?? fail('notFound', 'This file is no longer available.');
      return clean({ bytes: b.bytes, mime: b.mime, name: b.name, size: b.bytes.length });
    },
    'Blob/release': ({ blobId }) => {
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
