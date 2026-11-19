import type { Draft, Event, EventFields, Submission } from '@aplos/contract';
import type { Fixture } from '../engine';
import type { Tx } from '../store';
import { addDays, atLocal, localDay } from '../time';
import { instant } from '../views';
import { seriesPatches, type SeriesPatch } from '../series';
import { actOn } from './mail';
import { ownBlob } from './core';
import { requireScope } from '@aplos/contract/access';
import { OVERDUE_GRACE_MS, WAITING_SUBMISSION_STATES } from '@aplos/contract/rules';
import { clean, fail, getRows, live, must, textOf, type Part } from './util';

const uncertainCopy = 'We could not confirm this was sent. Check Sent, or Send anyway.';
export const overdueCopy =
  'This was due while your Mac was off. Send it now, or choose a new time.';

/** Drafts, the send state machine (ARCH 7.1-7.3) on the engine clock, calendars, events and plans. */
export function compose(fx: Fixture) {
  const liveSub = (draft: Draft) => {
    const s = draft.submissionId ? fx.store.get('Submission', draft.submissionId) : undefined;
    return s && live.has(s.state) ? s : undefined;
  };
  /** A draft with a live send is locked (freeze FR-7): the submission sends the revision it recorded. */
  const unlocked = (draft: Draft) => {
    const s = liveSub(draft);
    if (s?.state === 'sending')
      fail('conflict', 'This message is sending. Wait a moment, then try again.');
    if (s)
      fail(
        'stateMismatch',
        s.state === 'queued' || s.state === 'scheduled'
          ? 'This message is waiting to send. Undo the send to edit it.'
          : 'This message has not been sent. Cancel the send to edit it.',
      );
  };
  /** Ends a send that has not started (undo, cancel, a discarded draft): `cancelled`, timers stopped, the draft unlocked. */
  const cancel = (tx: Tx, sub: Submission) => {
    fx.runs.get(sub.id)?.();
    fx.runs.delete(sub.id);
    fx.alsoDone.delete(sub.id);
    const d = tx.get('Draft', sub.draftId);
    if (d?.submissionId === sub.id) {
      const { submissionId: _, ...draft } = d;
      tx.put('Draft', draft);
    }
    const { problem: __, ...rest } = sub;
    return tx.put('Submission', { ...rest, state: 'cancelled' });
  };

  /** Schedules the attempt at `notBefore`; the attempt itself ends `sent`, `uncertain` or `failed` 400 ms later. */
  const schedule = (sub: Submission) => {
    fx.runs.get(sub.id)?.();
    fx.runs.set(
      sub.id,
      fx.clock.after(Math.max(0, sub.notBefore - fx.now), () => attempt(sub.id)),
    );
  };
  const attempt = (id: string) => {
    fx.runs.delete(id);
    const sub = fx.store.get('Submission', id);
    if (!sub || !['queued', 'scheduled', 'uncertain', 'failed', 'suspended'].includes(sub.state))
      return;
    // The overdue rule (FR-2): a held send, undo window or send later alike, that wakes up past its time is suspended.
    if (
      (WAITING_SUBMISSION_STATES as readonly string[]).includes(sub.state) &&
      fx.now > sub.notBefore + OVERDUE_GRACE_MS
    ) {
      fx.write({ kind: 'Submission/suspend' }, tx =>
        tx.put('Submission', {
          ...sub,
          state: 'suspended',
          problem: { reasonCode: 'send.overdue', message: overdueCopy, at: fx.now },
        }),
      );
      return;
    }
    const { problem: _, ...rest } = sub;
    fx.write({ kind: 'Submission/attempt' }, tx =>
      tx.put('Submission', { ...rest, state: 'sending', attemptAt: fx.now }),
    );
    fx.runs.set(
      id,
      fx.clock.after(400, () => settle(id, fx.sendOutcomes.shift() ?? 'sent')),
    );
  };
  const settle = (id: string, outcome: 'sent' | 'uncertain' | 'failed') => {
    fx.runs.delete(id);
    const sub = fx.store.get('Submission', id);
    if (!sub || sub.state !== 'sending') return;
    fx.write({ kind: 'Submission/settle' }, tx => {
      if (outcome !== 'sent') {
        tx.put('Submission', {
          ...sub,
          state: outcome,
          problem:
            outcome === 'uncertain'
              ? { reasonCode: 'net.offline', message: uncertainCopy, at: fx.now }
              : {
                  reasonCode: 'net.offline',
                  message: 'Your message was not sent. Check your connection, then try again.',
                  at: fx.now,
                },
        });
        return;
      }
      tx.put('Submission', { ...sub, state: 'sent', sentAt: fx.now });
      const draft = tx.get('Draft', sub.draftId);
      const account = tx.get('Account', sub.accountId);
      if (!draft || !account) return;
      const threadId =
        draft.threadId && tx.get('Thread', draft.threadId)
          ? draft.threadId
          : `${account.id}:sent-${sub.id}`;
      const messageId = `${threadId}.${sub.id}`;
      const me = { address: account.address, name: account.name };
      const text = textOf(draft.html);
      tx.put('Message', {
        id: messageId,
        threadId,
        accountId: account.id,
        rev: 0,
        internetId: sub.internetId,
        from: draft.from ?? me,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        snippet: text.slice(0, 140),
        date: fx.now,
        seen: true,
        flagged: false,
        answered: false,
        fromMe: true,
        labels: [`${account.id}:SENT`],
        attachments: [],
        bodyState: 'present',
        bodyKind: 'html',
      });
      fx.bodies[messageId] = text;
      const prev = tx.get('Thread', threadId);
      tx.put(
        'Thread',
        prev
          ? {
              ...prev,
              lastDate: fx.now,
              messageCount: prev.messageCount + 1,
              snippet: text.slice(0, 140),
              labels: [...new Set([...prev.labels, `${account.id}:SENT`])],
              workflow: { ...prev.workflow, replyStatus: 'awaitingReply' },
              follow: { since: fx.now },
            }
          : {
              id: threadId,
              accountId: account.id,
              rev: 0,
              subject: draft.subject,
              snippet: text.slice(0, 140),
              fromName: account.name,
              participants: [
                { ...me, me: true },
                ...draft.to.slice(0, 5).map(a => clean({ name: a.name, address: a.address })),
              ],
              lastDate: fx.now,
              messageCount: 1,
              unreadCount: 0,
              partial: false,
              unread: false,
              flagged: false,
              hasAttachments: false,
              labels: [`${account.id}:SENT`],
              workflow: {
                status: 'done',
                doneAt: fx.now,
                bookmarked: false,
                hiddenFromHome: false,
                replyStatus: 'awaitingReply',
              },
              rank: { lane: 'update', importance: 'normal', source: 'heuristic', dueBand: 3 },
              summary: { state: 'none' },
              follow: { since: fx.now },
              unsubscribe: false,
              fromLater: false,
            },
      );
      tx.del('Draft', draft.id);
      if (fx.alsoDone.delete(sub.id) && draft.threadId && tx.get('Thread', draft.threadId))
        actOn(fx, tx, [draft.threadId], { type: 'done' });
    });
  };

  const eventFrom = (
    accountId: string,
    calendarId: string,
    f: EventFields,
    id = `${accountId}:ev-${fx.id('n')}`,
  ): Event => {
    if (
      instant(f.end, fx.zone) <= instant(f.start, fx.zone) &&
      !(f.allDay && f.end.type === 'date' && f.start.type === 'date' && f.end.date >= f.start.date)
    )
      fail('validation', 'An event must end after it starts.', {
        path: ['change', 'fields', 'end'],
      });
    const account = must(fx.store, 'Account', accountId, 'This account is no longer connected.');
    const self = {
      address: account.address,
      name: account.name,
      response: 'accepted',
      organizer: true,
      self: true,
    };
    return clean({
      id,
      rev: 0,
      accountId,
      calendarId,
      recurring: false,
      exception: false,
      title: f.title,
      start: f.start,
      end: f.end,
      allDay: f.allDay,
      timeZone: f.timeZone ?? fx.zone,
      location: f.location,
      description: f.description,
      organizer: self,
      attendees: f.attendees?.length
        ? [
            self,
            ...f.attendees.map(a =>
              clean({
                address: a.address.toLowerCase(),
                name: a.name,
                response: 'needsAction',
                organizer: false,
                self: false,
                optional: a.optional,
              }),
            ),
          ]
        : [],
      myResponse: 'accepted',
      status: 'confirmed',
      can: { edit: true, move: true, delete: true, rsvp: false, editGuests: true },
      threadId: f.threadId,
      sync: 'pending',
    });
  };

  return {
    'Draft/get': ({ ids }) => getRows(fx.store, 'Draft', ids),
    'Draft/set': ({ opId, id, baseRevision, fields }, cx) => {
      must(fx.store, 'Account', fields.accountId, 'This account is no longer connected.');
      const prev = id ? must(fx.store, 'Draft', id, 'This draft no longer exists.') : undefined;
      if (prev) unlocked(prev);
      // A newly attached upload must be the caller's own blob (FR-6); ones already on the draft stay.
      const had = new Set(prev?.attachments.map(a => a.blobId));
      for (const a of fields.attachments)
        if (a.blobId && !had.has(a.blobId))
          ownBlob(fx, cx.caller, a.blobId, 'This file is no longer available. Attach it again.');
      if (prev && baseRevision !== undefined && baseRevision !== prev.revision)
        fail('stateMismatch', 'This draft changed in another window. Reopen it before editing.');
      const draft: Draft = clean({
        ...prev,
        ...fields,
        id: prev?.id ?? `${fields.accountId}:draft-${fx.id('n')}`,
        rev: prev?.rev ?? 0,
        revision: (prev?.revision ?? 0) + 1,
        updatedAt: fx.now,
        origin: prev?.origin ?? 'local',
        sync: 'localOnly',
      });
      const { value, receipt } = fx.write({ opId, kind: 'Draft/set', undoable: false }, tx =>
        tx.put('Draft', draft),
      );
      return { draft: value, receipt };
    },
    'Draft/destroy': ({ opId, id }, cx) => {
      const draft = must(fx.store, 'Draft', id, 'This draft no longer exists.');
      const sub = liveSub(draft);
      // Cancelling a send is `send`'s effect everywhere else, so it is here too (R2B-2).
      if (sub) requireScope(cx.caller, 'send');
      if (sub?.state === 'sending')
        fail('conflict', 'This message is sending. Wait a moment, then try again.');
      // Discarding the draft cancels a send that has not started, so the outbox and the Quit warning clear (FR-13).
      // The op records the scope the call needed, so undoing a destroy that cancelled a send needs `send` too (NB-1).
      return fx.write({ opId, kind: 'Draft/destroy', ...(sub ? { scope: 'send' } : {}) }, tx => {
        if (sub) cancel(tx, sub);
        tx.del('Draft', id);
      }).receipt;
    },
    'Contact/suggest': ({ query, accountId, limit = 8 }) => {
      // The correspondents table from mail on hand: who you wrote to and heard from, most first (FR-29).
      const q = query.trim().toLowerCase();
      const people = new Map<
        string,
        { address: string; name?: string; sentTo: number; receivedFrom: number }
      >();
      const mine = new Set(fx.store.all('Account').map(a => a.address.toLowerCase()));
      const count = (a: { address: string; name?: string }, key: 'sentTo' | 'receivedFrom') => {
        const address = a.address.toLowerCase();
        if (mine.has(address)) return;
        const p = people.get(address) ?? { address, sentTo: 0, receivedFrom: 0 };
        p.name ??= a.name;
        p[key]++;
        people.set(address, p);
      };
      for (const m of fx.store.all('Message')) {
        if (accountId && m.accountId !== accountId) continue;
        if (m.fromMe) for (const a of [...m.to, ...m.cc]) count(a, 'sentTo');
        else if (m.from) count(m.from, 'receivedFrom');
      }
      const starts = (p: { address: string; name?: string }) =>
        !q ||
        p.address.startsWith(q) ||
        (p.name ?? '')
          .toLowerCase()
          .split(/\s+/)
          .some(w => w.startsWith(q));
      return {
        list: [...people.values()]
          .filter(starts)
          .sort(
            (a, b) =>
              b.sentTo * 2 + b.receivedFrom - (a.sentTo * 2 + a.receivedFrom) ||
              a.address.localeCompare(b.address),
          )
          .slice(0, limit)
          .map(p => clean(p)),
      };
    },
    'Draft/resolve': ({ opId, id, choice }) => {
      const draft = must(fx.store, 'Draft', id, 'This draft no longer exists.');
      unlocked(draft);
      const { conflict, ...rest } = draft;
      const revision = Math.max(draft.revision, conflict?.theirsRevision ?? 0) + 1;
      const copyId = choice === 'keepBoth' ? `${draft.accountId}:draft-${fx.id('n')}` : undefined;
      const { value, receipt } = fx.write({ opId, kind: 'Draft/resolve' }, tx => {
        if (copyId)
          tx.put('Draft', {
            ...rest,
            id: copyId,
            rev: 0,
            revision: 1,
            updatedAt: fx.now,
            origin: 'local',
            sync: 'localOnly',
          });
        return tx.put('Draft', { ...rest, revision, updatedAt: fx.now, sync: 'pending' });
      });
      return clean({ draft: value, copyId, receipt });
    },

    'Submission/get': ({ ids }) => getRows(fx.store, 'Submission', ids),
    'Submission/set': ({ opId, action }) => {
      const settings = must(fx.store, 'Settings', 'settings');
      if (action.type === 'send') {
        const draft = must(fx.store, 'Draft', action.draftId, 'This draft no longer exists.');
        if (action.revision !== draft.revision)
          fail('stateMismatch', 'This draft changed in another window. Reopen it before sending.');
        const current = draft.submissionId
          ? fx.store.get('Submission', draft.submissionId)
          : undefined;
        if (current && live.has(current.state))
          fail('conflict', 'This message is already on its way.');
        if (!draft.to.length && !draft.cc.length && !draft.bcc.length)
          fail('validation', 'Add at least one recipient.', { path: ['action', 'draftId'] });
        const account = must(
          fx.store,
          'Account',
          draft.accountId,
          'This account is no longer connected.',
        );
        if (account.sendBlockedUntil && account.sendBlockedUntil > fx.now)
          fail('paused', "Gmail's daily sending limit is reached for this account.", {
            resumeAt: account.sendBlockedUntil,
            reasonCode: 'quota.sendLimit',
          });
        const undoAt = fx.now + settings.mail.undoSendSeconds * 1_000;
        const later = action.notBefore !== undefined && action.notBefore > undoAt;
        const id = `sub-${fx.id('n')}`;
        const sub: Submission = clean({
          id,
          rev: 0,
          draftId: draft.id,
          accountId: draft.accountId,
          threadId: draft.threadId,
          internetId: `<${id}.${fx.seed}@fixture.example>`,
          revision: draft.revision,
          state: later ? 'scheduled' : 'queued',
          queuedAt: fx.now,
          notBefore: later ? action.notBefore! : undoAt,
          toNames: [...draft.to, ...draft.cc].slice(0, 20).map(a => a.name ?? a.address),
          subject: draft.subject,
        });
        // The receipt is undoable while the send is held: `Operation/undo` cancels it (FR-14), one undo stack for Z.
        const { value, receipt } = fx.write(
          {
            opId,
            kind: 'Submission/set',
            targets: [id],
            undoUntil: sub.notBefore,
            undo: undoOpId => {
              const held = fx.store.get('Submission', id);
              if (!held || (held.state !== 'queued' && held.state !== 'scheduled'))
                return fail(
                  'conflict',
                  held?.state === 'sending'
                    ? 'This message is sending now.'
                    : 'This message can no longer be unsent.',
                );
              return fx.write(
                { opId: undoOpId, kind: 'Submission/set', undoable: false, scope: 'send' },
                tx => cancel(tx, held),
              ).receipt;
            },
          },
          tx => {
            tx.put('Draft', { ...draft, submissionId: id });
            return tx.put('Submission', sub);
          },
        );
        if (action.alsoDone) fx.alsoDone.add(id);
        schedule(value);
        return { submission: value, receipt };
      }
      const sub = must(
        fx.store,
        'Submission',
        action.submissionId,
        'This message is no longer in the outbox.',
      );
      const allowed: Record<string, string[]> = {
        undo: ['queued', 'scheduled'],
        sendNow: ['queued', 'scheduled', 'suspended'],
        reschedule: ['queued', 'scheduled', 'suspended'],
        sendAnyway: ['uncertain'],
        retry: ['failed'],
        cancel: ['failed', 'uncertain', 'suspended'],
      };
      if (!allowed[action.type]!.includes(sub.state))
        fail(
          'conflict',
          sub.state === 'sent'
            ? 'This message has already been sent.'
            : sub.state === 'sending'
              ? 'This message is sending now.'
              : 'This message cannot do that now.',
        );
      if ('revision' in action && action.revision !== undefined && action.revision !== sub.revision)
        fail('stateMismatch', 'This message changed. Open it again before sending.');
      const { problem: _, ...rest } = sub;
      const stop = action.type === 'undo' || action.type === 'cancel';
      const { value, receipt } = fx.write(
        { opId, kind: 'Submission/set', targets: [sub.id], undoable: false },
        tx =>
          stop
            ? cancel(tx, sub)
            : tx.put(
                'Submission',
                action.type === 'reschedule'
                  ? { ...rest, state: 'scheduled', notBefore: action.notBefore }
                  : { ...rest, state: 'queued', notBefore: fx.now },
              ),
      );
      if (!stop) schedule(value);
      return { submission: value, receipt };
    },

    'Calendar/get': ({ accountId }) => ({
      list: fx.store.all('Calendar').filter(c => !accountId || c.accountId === accountId),
    }),
    'Calendar/set': ({ opId, id, shown, colorTag }) => {
      const cal = must(fx.store, 'Calendar', id, 'This calendar is no longer available.');
      const { value, receipt } = fx.write({ opId, kind: 'Calendar/set' }, tx =>
        tx.put(
          'Calendar',
          clean({ ...cal, shown: shown ?? cal.shown, colorTag: colorTag ?? cal.colorTag }),
        ),
      );
      return { calendar: value, receipt };
    },
    'Event/get': ({ ids }) => getRows(fx.store, 'Event', ids),
    'Event/set': ({ opId, change, notify }) => {
      const notifies = (e: Event) => notify !== false && e.attendees.some(a => !a.self);
      if (change.type === 'create') {
        const cal = must(
          fx.store,
          'Calendar',
          change.calendarId,
          'This calendar is no longer available.',
        );
        if (cal.readOnly) fail('unsupported', 'This calendar is read-only.');
        const event = eventFrom(cal.accountId, cal.id, change.fields);
        const undoUntil = notifies(event) ? fx.now + 10_000 : undefined;
        const { value, receipt } = fx.write(
          { opId, kind: 'Event/set', provider: true, undoUntil },
          tx => tx.put('Event', event),
        );
        return { event: value, receipt };
      }
      const event = must(fx.store, 'Event', change.id, 'This event is no longer available.');
      if (change.scope === 'following')
        fail('unsupported', 'Changing this and following events is not available yet.');
      if (change.type === 'destroy') {
        if (!event.can.delete) fail('unsupported', 'Only the organizer can delete this event.');
        const undoUntil = notifies(event) ? fx.now + 10_000 : undefined;
        return {
          receipt: fx.write({ opId, kind: 'Event/set', provider: true, undoUntil }, tx =>
            tx.del('Event', event.id),
          ).receipt,
        };
      }
      if (!event.can.edit) fail('unsupported', 'Only the organizer can change this event.');
      const zone = event.timeZone ?? fx.zone;
      // A series write named by an occurrence moves the whole series (the 2026-11-04 rule); anything else is this row.
      const targets: SeriesPatch[] =
        change.scope === 'series' && (event.recurring || event.seriesId)
          ? seriesPatches(fx.store.all('Event'), event, change.fields, zone)
          : [{ row: event, fields: change.fields }];
      const merge = ({ row, fields, originalStart }: SeriesPatch): Event => {
        const merged = eventFrom(
          row.accountId,
          row.calendarId,
          {
            title: row.title,
            start: row.start,
            end: row.end,
            allDay: row.allDay,
            timeZone: row.timeZone,
            location: row.location,
            description: row.description,
            attendees: row.attendees
              .filter(a => !a.self)
              .map(a => clean({ address: a.address, name: a.name, optional: a.optional })),
            threadId: row.threadId,
            ...fields,
          },
          row.id,
        );
        // `eventFrom` builds a plain event; a row of a series keeps what makes it one.
        return clean({
          ...merged,
          recurring: row.recurring,
          seriesId: row.seriesId,
          originalStart: originalStart ?? row.originalStart,
          exception: row.exception || (row.recurring && change.scope === 'occurrence'),
          rev: row.rev,
        });
      };
      const rows = targets.map(merge);
      const edited = rows.find(r => r.id === event.id)!;
      const undoUntil = notifies(edited) ? fx.now + 10_000 : undefined;
      const { value, receipt } = fx.write(
        { opId, kind: 'Event/set', provider: true, undoUntil },
        tx => rows.map(r => tx.put('Event', r)).find(r => r.id === event.id)!,
      );
      return { event: value, receipt };
    },
    'Event/hide': ({ opId, ids, hidden }) =>
      // Aplos-side only, like a calendar's visibility: no provider write, so nobody is told (FR-21).
      fx.write({ opId, kind: 'Event/hide', targets: ids }, tx => {
        for (const id of ids) {
          const e = tx.get('Event', id) ?? fail('notFound', 'This event is no longer available.');
          tx.put('Event', clean({ ...e, hidden: hidden || undefined }));
        }
      }).receipt,
    'Event/rsvp': ({ opId, id, response }) => {
      const event = must(fx.store, 'Event', id, 'This event is no longer available.');
      if (!event.can.rsvp) fail('unsupported', 'This event has no invitation to answer.');
      return fx.write({ opId, kind: 'Event/rsvp', provider: true }, tx =>
        tx.put('Event', {
          ...event,
          myResponse: response,
          attendees: event.attendees.map(a => (a.self ? { ...a, response } : a)),
        }),
      ).receipt;
    },
    'Event/extract': ({ opId, threadId }) => {
      const t = must(fx.store, 'Thread', threadId, 'This conversation is no longer available.');
      // The Plans model reads the thread, so the account's AI toggle bounds it (FR-8).
      if (!fx.store.get('Account', t.accountId)?.aiAllowed)
        fail('forbidden', "AI is turned off for this account's mail.", {
          reasonCode: 'ai.accountExcluded',
        });
      const open = fx.store.all('Plan').filter(p => p.threadId === threadId && p.state === 'open');
      const day = addDays(localDay(fx.now, fx.zone), 1);
      const { value, receipt } = fx.write({ opId, kind: 'Event/extract', undoable: false }, tx =>
        open.length
          ? open
          : [
              tx.put('Plan', {
                id: `${t.accountId}:plan-${fx.id('n')}`,
                rev: 0,
                threadId,
                fromName: t.fromName,
                quote: t.snippet.slice(0, 200),
                title: t.subject,
                start: { type: 'utc', utc: atLocal(day, 10, 0, fx.zone) },
                end: { type: 'utc', utc: atLocal(day, 11, 0, fx.zone) },
                allDay: false,
                timeZone: fx.zone,
                state: 'open',
              }),
            ],
      );
      return { plans: value, receipt };
    },
    'Plan/get': ({ ids }) => getRows(fx.store, 'Plan', ids),
    'Plan/confirm': ({ opId, id, calendarId, fields }) => {
      const plan = must(fx.store, 'Plan', id, 'This plan is no longer available.');
      const accountId = plan.threadId.split(':')[0]!;
      const cal = calendarId
        ? must(fx.store, 'Calendar', calendarId, 'This calendar is no longer available.')
        : (fx.store.all('Calendar').find(c => c.accountId === accountId && c.primary) ??
          fx.store.all('Calendar').find(c => c.accountId === accountId) ??
          fail('notFound', 'This account has no calendar.'));
      const event = eventFrom(
        cal.accountId,
        cal.id,
        clean({
          title: plan.title,
          start: plan.start,
          end: plan.end,
          allDay: plan.allDay,
          timeZone: plan.timeZone,
          location: plan.location,
          threadId: plan.threadId,
          ...fields,
        }),
      );
      const { receipt } = fx.write({ opId, kind: 'Plan/confirm', provider: true }, tx => {
        tx.put('Event', event);
        tx.put('Plan', { ...plan, state: 'confirmed', eventId: event.id });
      });
      return { eventId: event.id, receipt };
    },
    'Plan/dismiss': ({ opId, ids }) =>
      fx.write({ opId, kind: 'Plan/dismiss', targets: ids }, tx => {
        for (const id of ids) {
          const p = tx.get('Plan', id);
          if (p) tx.put('Plan', { ...p, state: 'dismissed' });
        }
      }).receipt,
  } satisfies Part;
}
