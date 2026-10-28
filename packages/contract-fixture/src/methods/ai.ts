import type {
  Settings,
  AiJob,
  AskTurn,
  Citation,
  Conversation,
  ModelRef,
  Proposal,
  ThreadRow,
} from '@aplos/contract';
import type { Fixture } from '../engine';
import { aiProviders, curatedModels } from '../data/defaults';
import { atLocal, addDays, localDay } from '../time';
import { actOn } from './mail';
import { ownBlob } from './core';
import { requireScope } from '@aplos/contract/access';
import { clean, fail, getRows, must, plainHtml, type Part } from './util';

type Feature = 'ask' | 'summaries' | 'drafts' | 'plans' | 'voice';

/** A loopback host: mail sent there stays on this Mac. */
export const loopback = (address: string) => {
  try {
    const host = new URL(address).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
};
/** What background consent covers (FR-5): the Summaries provider and model, and that provider's address host. */
export const consentKey = (ai: Settings['ai']) => {
  const { provider, model } = ai.features.summaries;
  const address = ai.providers[provider]?.address;
  let host = '';
  try {
    host = address ? new URL(address).host : '';
  } catch {
    /* an empty or default address */
  }
  return `${provider}\u0000${model}\u0000${host}`;
};
type Block = NonNullable<AskTurn['answer']>['blocks'][number];

/**
 * AI on canned answers: summaries after a short delay on the engine clock, Ask with `progress` frames and citations, and
 * Settings → AI's tables. No request leaves the fixture and it never holds a key.
 */
export function ai(fx: Fixture) {
  const meta = () => must(fx.store, 'Meta', 'meta');
  const model = (feature: Feature): ModelRef =>
    must(fx.store, 'Settings', 'settings').ai.features[feature];
  const ready = (feature: Feature) => {
    const m = model(feature);
    return aiProviders(meta().keys).find(p => p.id === m.provider)?.status === 'ready';
  };
  const need = (feature: Feature) => {
    if (!ready(feature))
      fail(
        'notConfigured',
        `Add a ${model(feature).provider === 'groq' ? 'Groq' : 'provider'} key in Settings → AI to use this.`,
        { reasonCode: 'ai.missingKey' },
      );
    // The `failNextAi` knob: the provider fails this once, with Aplos's own copy for the reason (FR-17, FR-33).
    const failure = feature === 'ask' ? undefined : fx.aiFailures.get(feature);
    if (failure) {
      fx.aiFailures.delete(feature);
      fail('providerError', failure.message ?? 'The AI provider could not answer. Try again.', {
        reasonCode: failure.reasonCode,
      });
    }
  };
  const job = (j: AiJob) => fx.write({ kind: 'AiJob' }, tx => tx.put('AiJob', j));
  const conv = (id: string) =>
    must(fx.store, 'Conversation', id, 'This conversation no longer exists.');
  /** Accounts whose mail may go to AI: "Use this account's mail for AI" bounds every AI scope (freeze FR-8). */
  const aiAccounts = () =>
    new Set(
      fx.store
        .all('Account')
        .filter(a => a.aiAllowed)
        .map(a => a.id),
    );
  /** A thread an AI call names must belong to an AI-allowed account, else `forbidden`; naming it never widens the scope. */
  const aiThread = (threadId: string) => {
    const t = must(fx.store, 'Thread', threadId, 'This conversation is no longer available.');
    if (!aiAccounts().has(t.accountId))
      fail('forbidden', "AI is turned off for this account's mail.", {
        reasonCode: 'ai.accountExcluded',
      });
    return t;
  };

  /** Threads that best match a question's words, else the top of Do now. */
  const sources = (question: string, accountIds?: string[]): ThreadRow[] => {
    const words = question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 4);
    const pool = fx.store
      .all('Thread')
      .filter(
        t =>
          (!accountIds || accountIds.includes(t.accountId)) &&
          !t.labels.some(l => /:(TRASH|SPAM)$/.test(l)),
      );
    const scored = pool
      .map(t => {
        const hay =
          `${t.subject} ${t.snippet} ${t.fromName} ${fx.bodies[`${t.id}.m1`] ?? ''}`.toLowerCase();
        return { t, score: words.filter(w => hay.includes(w)).length };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || b.t.lastDate - a.t.lastDate)
      .map(x => x.t);
    return (
      scored.length
        ? scored
        : pool
            .filter(t => t.rank.lane === 'do' && t.workflow.status === 'new')
            .sort((a, b) => a.rank.dueBand - b.rank.dueBand)
    ).slice(0, 2);
  };
  const cite = (t: ThreadRow, n: number): Citation => {
    const message = fx.store
      .all('Message')
      .filter(m => m.threadId === t.id)
      .sort((a, b) => b.date - a.date)[0];
    const body = message ? (fx.bodies[message.id] ?? '') : t.snippet;
    const quote = (
      body.replace(/^(hi|hello)[^\n]*\n/i, '').split(/(?<=[.?!])\s/)[0] ?? t.snippet
    ).slice(0, 200);
    return clean({
      kind: 'message',
      n,
      messageId: message?.id ?? `${t.id}.m1`,
      threadId: t.id,
      quote,
      fromName: t.fromName,
      date: t.lastDate,
      subject: t.subject,
    });
  };
  const setTurn = (conversationId: string, turnId: string, patch: (turn: AskTurn) => AskTurn) => {
    const c = fx.store.get('Conversation', conversationId);
    if (!c) return;
    fx.write({ kind: 'Conversation' }, tx =>
      tx.put('Conversation', {
        ...c,
        updatedAt: fx.now,
        turns: c.turns.map(t => (t.id === turnId ? patch(t) : t)),
      }),
    );
  };

  return {
    'Ai/request': ({ opId, kind, threadId, force }) => {
      const t = aiThread(threadId);
      need(kind === 'plan' ? 'plans' : 'summaries');
      const id = `job-${fx.id('n')}`;
      const m = model(kind === 'plan' ? 'plans' : 'summaries');
      if (!force && kind === 'summary' && t.summary.state === 'ready') {
        const skipped: AiJob = { id, kind, threadId, state: 'skipped', attempts: 0, model: m };
        const { receipt } = fx.write({ opId, kind: 'Ai/request', undoable: false }, tx =>
          tx.put('AiJob', skipped),
        );
        return { job: skipped, receipt };
      }
      const queued: AiJob = {
        id,
        kind,
        threadId,
        state: 'queued',
        attempts: 0,
        nextAt: fx.now,
        model: m,
      };
      const { receipt } = fx.write({ opId, kind: 'Ai/request', undoable: false }, tx => {
        tx.put('AiJob', queued);
        if (kind === 'summary')
          tx.put('Thread', { ...t, summary: { ...t.summary, state: 'pending' } });
      });
      const cancelRun = fx.clock.after(200, () => {
        job({ ...queued, state: 'running', attempts: 1 });
        fx.runs.set(
          id,
          fx.clock.after(800, () => {
            fx.runs.delete(id);
            const now = fx.store.get('Thread', threadId);
            fx.write({ kind: 'Ai/request' }, tx => {
              tx.put('AiJob', { ...queued, state: 'done', attempts: 1 });
              if (now && kind === 'summary')
                tx.put('Thread', {
                  ...now,
                  summary: clean({
                    ...now.summary,
                    state: 'ready',
                    text: now.summary.text ?? `${now.fromName}: ${now.snippet.slice(0, 90)}`,
                    provider: m.provider,
                    model: m.model,
                  }),
                });
              if (now && kind === 'classify')
                tx.put('Thread', { ...now, rank: { ...now.rank, rankedAt: fx.now } });
            });
          }),
        );
      });
      fx.runs.set(id, cancelRun);
      return { job: queued, receipt };
    },
    'Ai/jobs': ({ threadIds, states }) => ({
      list: fx.store
        .all('AiJob')
        .filter(
          j =>
            (!threadIds || (j.threadId && threadIds.includes(j.threadId))) &&
            (!states || states.includes(j.state as 'queued')),
        ),
    }),
    'Ai/polish': ({ html }) => {
      need('drafts');
      const polished = html.replace(/ {2,}/g, ' ').replace(/\bi\b/g, 'I');
      return { html: polished, changes: polished === html ? 0 : 1 };
    },
    'Ai/draft': ({ instruction, threadId }) => {
      need('drafts');
      const t = threadId ? aiThread(threadId) : undefined;
      const first = t?.fromName.split(' ')[0];
      const html = `${first ? `<p>Hi ${first},</p>` : ''}${plainHtml(`Thanks for your note. ${instruction.trim().replace(/\.?$/, '.')}`)}<p>Warmly,<br>Alex</p>`;
      return clean({
        html,
        subject: t ? undefined : instruction.trim().split(/\s+/).slice(0, 6).join(' '),
      });
    },
    'Ai/transcribe': ({ blobId }, cx) => {
      need('voice');
      ownBlob(fx, cx.caller, blobId, 'This recording is no longer available.');
      return {
        text: fx.transcripts.shift() ?? 'This is a stand-in transcription from the fixture engine.',
      };
    },
    'Ai/cancel': ({ requestId }) => {
      const ids = requestId
        ? [requestId]
        : [...fx.runs.keys()].filter(id => id.startsWith('ask-') || id.startsWith('job-'));
      let cancelled = false;
      for (const id of ids) {
        const stop = fx.runs.get(id);
        if (stop) {
          stop();
          fx.runs.delete(id);
          cancelled = true;
        }
      }
      return { cancelled };
    },
    'Ai/followup': ({ threadId }) => {
      const f = fx.store.get('Followup', threadId);
      if (!f) return {};
      const { id: _, ...suggestion } = f;
      return { suggestion };
    },
    'Ai/dismissFollowup': ({ opId, threadId }) =>
      fx.write({ opId, kind: 'Ai/dismissFollowup', targets: [threadId] }, tx =>
        tx.del('Followup', threadId),
      ).receipt,
    'Ai/providers': () => {
      const providers = must(fx.store, 'Settings', 'settings').ai.providers;
      return {
        list: aiProviders(meta().keys).map(p => {
          const address = providers[p.id]?.address || p.address;
          // `local` follows the address, not the provider id (FR-5).
          return clean({ ...p, address, local: !!address && loopback(address) });
        }),
      };
    },
    'Ai/models': ({ provider }) => ({ list: curatedModels[provider] ?? [], live: false }),
    'Ai/status': () => ({
      features: (['ask', 'summaries', 'drafts', 'plans', 'voice'] as const).map(feature =>
        clean({
          feature,
          ready: ready(feature),
          model: model(feature),
          reasonCode: ready(feature) ? undefined : 'ai.missingKey',
        }),
      ),
    }),
    'Ai/usage': () => {
      const m = meta(),
        cap = must(fx.store, 'Settings', 'settings').ai.dailyCap;
      return clean({
        day: localDay(fx.now, fx.zone),
        backgroundTokens: m.usage.backgroundTokens,
        cap: cap.enabled ? cap.tokens : undefined,
        pausedUntil:
          m.usage.pausedUntil && m.usage.pausedUntil > fx.now ? m.usage.pausedUntil : undefined,
        byModel: m.usage.backgroundTokens
          ? [
              {
                model: model('summaries'),
                lane: 'background',
                requests: Math.ceil(m.usage.backgroundTokens / 1_500),
                tokensIn: Math.round(m.usage.backgroundTokens * 0.8),
                tokensOut: Math.round(m.usage.backgroundTokens * 0.2),
              },
            ]
          : [],
      });
    },
    'Ai/setKey': ({ provider }) => {
      const entry = { keySource: 'keychain' as const };
      fx.write({ kind: 'Ai/setKey' }, tx =>
        tx.put('Meta', { ...meta(), keys: { ...meta().keys, [provider]: entry } }),
      );
      return entry;
    },
    'Ai/removeKey': ({ provider }) => {
      if (meta().keys[provider]?.keySource === 'env')
        fail('unsupported', 'This key comes from the backend environment. Remove it there.');
      fx.write({ kind: 'Ai/removeKey' }, tx =>
        tx.put('Meta', { ...meta(), keys: { ...meta().keys, [provider]: { keySource: 'none' } } }),
      );
      return { keySource: 'none' };
    },
    'Ai/testKey': ({ provider }) =>
      (meta().keys[provider]?.keySource ?? 'none') === 'none'
        ? { ok: false, reasonCode: 'ai.missingKey', message: 'Add a key first.' }
        : { ok: true, ms: 140 },
    'Ai/test': ({ model: m }) => {
      if (aiProviders(meta().keys).find(p => p.id === m.provider)?.status !== 'ready')
        fail('notConfigured', 'This provider is not set up yet.', { reasonCode: 'ai.missingKey' });
      return {
        ms: 320,
        tools: (curatedModels[m.provider] ?? []).find(x => x.id === m.model)?.tools ?? true,
      };
    },

    'Ask/run': ({ question, conversationId, scope, context }, cx) => {
      need('ask');
      const runId = `ask-${fx.id('n')}`,
        turnId = fx.id('turn');
      const id = conversationId ? conv(conversationId).id : fx.id('conv');
      const prev = fx.store.get('Conversation', id);
      const allowed = aiAccounts();
      const accountIds = (scope?.accountIds ?? [...allowed]).filter(id => allowed.has(id));
      const excluded = fx.store
        .all('Account')
        .filter(a => !a.aiAllowed)
        .map(a => a.id);
      const found = sources(question, accountIds);
      const script = fx.askScripts.shift();
      const failure = fx.aiFailures.get('ask');
      fx.aiFailures.delete('ask');
      const failAt = script?.failAt ?? (failure ? 'step' : undefined);
      const problem = clean({
        reasonCode: 'ai.failed',
        message: 'Ask could not finish. Try again.',
        ...failure,
        ...script?.problem,
      });
      const citations = script?.citations ?? found.map((t, i) => cite(t, i + 1));
      // Paragraphs without `[n]` markers; each chip's place is a `cites` offset (FR-30).
      const blocks: Block[] =
        script?.blocks ??
        (found.length
          ? found.map((t, i) => {
              const said = (t.summary.text ?? t.subject).replace(/[.\s]+$/, '');
              return { text: `${said}.`, cites: [{ at: said.length, n: i + 1 }] };
            })
          : [{ text: 'I could not find anything about that in your mail.' }]);
      const context_ = context?.threadId ? fx.store.get('Thread', context.threadId) : undefined;
      const target = context_ && allowed.has(context_.accountId) ? context_ : undefined;
      const proposals: Proposal[] =
        script?.proposals ??
        (target && /\b(reply|answer|respond|write back)\b/i.test(question)
          ? [
              {
                kind: 'reply',
                id: `${turnId}-p1`,
                consequence: 'Creates a draft reply. Nothing is sent.',
                state: 'open',
                draft: {
                  accountId: target.accountId,
                  mode: 'reply',
                  threadId: target.id,
                  to: target.participants
                    .filter(p => !p.me && p.address)
                    .map(p => clean({ address: p.address!, name: p.name })),
                  subject: `Re: ${target.subject}`,
                  html: `<p>Hi ${target.fromName.split(' ')[0]},</p><p>Thanks for this. I will get back to you shortly.</p>`,
                },
              },
            ]
          : []);
      const m = model('ask');
      const turn: AskTurn = clean({
        id: turnId,
        question,
        citations: [],
        noSource: false,
        proposals: [],
        steps: [],
        model: m,
        excludedAccountIds: excluded.length ? excluded : undefined,
        createdAt: fx.now,
      });
      const conversation: Conversation = {
        id,
        rev: prev?.rev ?? 0,
        title: prev?.title ?? question.slice(0, 80).replace(/[\r\n]+/g, ' '),
        updatedAt: fx.now,
        turns: [...(prev?.turns ?? []), turn],
      };
      fx.write({ kind: 'Ask/run' }, tx => tx.put('Conversation', conversation));
      const step = { id: 'search', text: 'Searching your mail' };
      const progress = (frame: Record<string, unknown>) =>
        fx.emit(
          { frame: 'progress', runId, source: 'ask', turnId, ...frame } as never,
          cx.sessionId,
        );
      const finish = (patch: Partial<AskTurn>) => {
        fx.runs.delete(runId);
        setTurn(id, turnId, t => ({ ...t, ...patch }));
        progress({ kind: 'done' });
      };
      const fails = (stepState: 'running' | 'done', shown: Block[]) => () => {
        progress({ kind: 'step', step: { ...step, state: 'error' } });
        progress({ kind: 'error', problem });
        finish({
          ...(shown.length ? { answer: { blocks: shown } } : {}),
          problem,
          steps: [{ ...step, state: stepState === 'running' ? 'error' : 'done' }],
        });
      };
      const timeline: [number, () => void][] = [
        [100, () => progress({ kind: 'step', step: { ...step, state: 'running' } })],
      ];
      if (failAt === 'step') timeline.push([400, fails('running', [])]);
      else {
        timeline.push([
          400,
          () => progress({ kind: 'step', step: { ...step, state: 'done', count: found.length } }),
        ]);
        // Each paragraph streams, then its chips at their offsets in the text streamed so far.
        let streamed = 0;
        blocks.forEach((b, i) => {
          const sep = i ? '\n\n' : '';
          const base = streamed + sep.length;
          streamed = base + b.text.length;
          timeline.push([
            550 + 150 * i,
            () => {
              progress({ kind: 'text', delta: `${sep}${b.text}` });
              for (const c of b.cites ?? []) {
                const citation = citations.find(x => x.n === c.n);
                if (citation) progress({ kind: 'citation', citation, at: base + c.at });
              }
            },
          ]);
          if (failAt === 'text' && i === 0) timeline.push([560, fails('done', [b])]);
        });
        const end = 550 + 150 * blocks.length;
        const placed = new Set(blocks.flatMap(b => (b.cites ?? []).map(c => c.n)));
        timeline.push(
          [
            end,
            () => {
              // Chips and cards appear as each becomes known, before the turn is stored.
              for (const citation of citations)
                if (!placed.has(citation.n)) progress({ kind: 'citation', citation });
              for (const proposal of proposals) progress({ kind: 'proposal', proposal });
            },
          ],
          [
            end + 100,
            () =>
              finish({
                answer: { blocks },
                citations,
                noSource: !found.length && !script?.citations?.length,
                proposals,
                steps: [{ ...step, state: 'done', count: found.length }],
              }),
          ],
        );
      }
      const cancels = timeline.map(([ms, fn]) => fx.clock.after(ms, fn));
      fx.runs.set(runId, () => {
        cancels.forEach(c => c());
        setTurn(id, turnId, t => ({
          ...t,
          answer: { blocks: blocks.slice(0, 1) },
          citations: citations.slice(0, 1),
          stopped: true,
          steps: [{ ...step, state: 'done', count: found.length }],
        }));
        progress({ kind: 'done' });
      });
      return { runId, conversationId: id };
    },
    'Ask/cancel': ({ runId }) => {
      const stop = fx.runs.get(runId);
      if (!stop) return { cancelled: false };
      fx.runs.delete(runId);
      stop();
      return { cancelled: true };
    },
    'Ask/decide': ({ opId, conversationId, turnId, proposalId, accept }, cx) => {
      const c = conv(conversationId);
      const turn =
        c.turns.find(t => t.id === turnId) ??
        fail('notFound', 'This answer is no longer available.');
      const proposal =
        turn.proposals.find(p => p.id === proposalId) ??
        fail('notFound', 'This suggestion is no longer available.');
      if (proposal.state !== 'open') fail('conflict', 'This suggestion was already answered.');
      let draftId: string | undefined, eventId: string | undefined;
      // An event that invites anyone but the owner sends invitations, so accepting it needs `send` (FR-4).
      const cal =
        accept && proposal.kind === 'addEvent'
          ? (proposal.calendarId && fx.store.get('Calendar', proposal.calendarId)) ||
            fx.store.all('Calendar').find(x => x.primary) ||
            fail('notFound', 'Connect a calendar first.')
          : undefined;
      const owner = cal ? fx.store.get('Account', cal.accountId) : undefined;
      const guests =
        proposal.kind === 'addEvent' && owner
          ? (proposal.event.attendees ?? []).filter(
              a => a.address.toLowerCase() !== owner.address.toLowerCase(),
            )
          : [];
      if (guests.length) requireScope(cx.caller, 'send');
      const { receipt } = fx.write(
        {
          opId,
          kind: 'Ask/decide',
          provider: accept && proposal.kind !== 'reply',
          ...(guests.length ? { scope: 'send', undoUntil: fx.now + 10_000 } : {}),
        },
        tx => {
          if (accept && proposal.kind === 'reply') {
            const accountId =
              proposal.draft.accountId ??
              fx.store.all('Account')[0]?.id ??
              fail('notFound', 'Connect an account first.');
            draftId = `${accountId}:draft-${fx.id('n')}`;
            tx.put('Draft', {
              mode: 'reply',
              to: [],
              cc: [],
              bcc: [],
              subject: '',
              html: '',
              attachments: [],
              signature: true,
              ...proposal.draft,
              accountId,
              id: draftId,
              rev: 0,
              revision: 1,
              updatedAt: fx.now,
              origin: 'local',
              sync: 'localOnly',
            });
          }
          if (accept && proposal.kind === 'addEvent' && cal && owner) {
            const self = {
              address: owner.address,
              name: owner.name,
              response: 'accepted',
              organizer: true,
              self: true,
            };
            eventId = `${cal.accountId}:ev-${fx.id('n')}`;
            tx.put(
              'Event',
              clean({
                id: eventId,
                rev: 0,
                accountId: cal.accountId,
                calendarId: cal.id,
                recurring: false,
                exception: false,
                title: proposal.event.title,
                start: proposal.event.start,
                end: proposal.event.end,
                allDay: proposal.event.allDay,
                location: proposal.event.location,
                organizer: guests.length ? self : undefined,
                attendees: guests.length
                  ? [
                      self,
                      ...guests.map(a =>
                        clean({
                          address: a.address.toLowerCase(),
                          name: a.name,
                          response: 'needsAction',
                          organizer: false,
                          self: false,
                        }),
                      ),
                    ]
                  : [],
                status: 'confirmed',
                can: { edit: true, move: true, delete: true, rsvp: false, editGuests: true },
                sync: 'pending',
              }),
            );
          }
          if (accept && proposal.kind === 'triage')
            actOn(fx, tx, proposal.threadIds, proposal.action);
          tx.put('Conversation', {
            ...c,
            updatedAt: fx.now,
            turns: c.turns.map(t =>
              t.id !== turnId
                ? t
                : {
                    ...t,
                    proposals: t.proposals.map(p =>
                      p.id === proposalId ? { ...p, state: accept ? 'accepted' : 'dismissed' } : p,
                    ),
                  },
            ),
          });
        },
      );
      return clean({ receipt, draftId, eventId });
    },
    'Ask/suggestions': () => ({
      list: [
        'What needs my reply today?',
        'What is on my calendar this week?',
        'Summarize the invoice from Drew',
      ],
    }),
    'Conversation/get': ({ ids }) => getRows(fx.store, 'Conversation', ids),
    'Conversation/destroy': ({ opId, id }) => {
      conv(id);
      return fx.write({ opId, kind: 'Conversation/destroy' }, tx => tx.del('Conversation', id))
        .receipt;
    },

    'Consent/get': () => {
      const { id: _, ...c } = must(fx.store, 'Consent', 'background');
      return c;
    },
    'Consent/grant': ({ version, provider, model: m }) => {
      const c = must(fx.store, 'Consent', 'background');
      if (version !== c.currentVersion)
        fail('stateMismatch', 'The consent text changed. Read it again before agreeing.');
      const next = {
        ...c,
        granted: true,
        version,
        needsReconsent: false,
        provider,
        model: m,
        grantedAt: fx.now,
      };
      fx.write({ kind: 'Consent/grant' }, tx => tx.put('Consent', next));
      const { id: _, ...out } = next;
      return out;
    },
    'Consent/revoke': () => {
      const {
        grantedAt: _,
        provider: __,
        model: ___,
        ...c
      } = must(fx.store, 'Consent', 'background');
      const next = { ...c, granted: false };
      fx.write({ kind: 'Consent/revoke' }, tx => tx.put('Consent', next));
      const { id: ____, ...out } = next;
      return out;
    },
  } satisfies Part;
}

/** Midnight after `now` in the engine zone: when a spent daily AI budget resumes. */
export const nextMidnight = (fx: Fixture) =>
  atLocal(addDays(localDay(fx.now, fx.zone), 1), 0, 0, fx.zone);
