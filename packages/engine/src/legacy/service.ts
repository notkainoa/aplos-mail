import type {
  Account,
  AppState,
  Attachment,
  CalendarEvent,
  CalendarInfo,
  Conversation,
  Draft,
  Listener,
  Settings,
  Thread,
} from '@aplos/contract/legacy/types';
import { createDemo, defaultSettings, demoCalendars } from './demo';
import { hasRealSummary } from '@aplos/contract/legacy/summary';
import { applySync } from './merge';
import { olderInboxDuplicates } from './duplicates';
import { createGate } from './gate';
import { ftsQuery, type OpChanges, type QueuedOp, type SaveExtras, type StoreDiff } from './store';
import { threadOrder, type StateChanges, type ThreadPage } from '@aplos/contract/legacy/live';
import { checkDomain, discoverAccount } from './discover';
import type {
  AccountPreset,
  ConnectRequest,
  MailProvider,
  ProviderKind,
  ServerSettings,
  SyncResult,
} from './provider';
import type { EngineOptions, MemoryStage } from './ports';
import { runAgent } from './agent';
import { createAskSession, type AskProgress } from './ask';
import { localNow } from './proposals';
import {
  aiFeature,
  aiFeatures,
  askProvider,
  askProviders,
  askServerSetting,
  isAskServer,
  parseFeatureModel,
  voiceProviders,
  type AiFeature,
  type AskProviderId,
  type AskServerId,
} from '@aplos/contract/legacy/ask';
import { chatJson, createWriter } from './writer';

// The alphabet/padding has already been validated before this size calculation.
const base64Bytes = (value: string) => Math.floor((value.replace(/=+$/, '').length * 3) / 4);

/** Sending addresses and calendars change rarely, so automatic syncs refresh them at most this often. */
const EXTRAS_INTERVAL_MS = 10 * 60_000;
/** Automatic syncs share Done, Later and todos with other devices at most this often, unless something changed here. */
const WORKFLOW_INTERVAL_MS = 5 * 60_000;
const WORKFLOW_KEYS = [
  'status',
  'replyStatus',
  'dueDate',
  'reminderAt',
  'reminderFired',
  'todo',
  'hiddenFromHome',
] as const;
/** First retry delay for a queued change the host rejected or could not be reached for; doubles up to 15 minutes. */
const OP_RETRY_MS = 30_000,
  OP_RETRY_MAX_MS = 15 * 60_000;
const UNCONFIRMED =
  'Sending was interrupted and Aplos could not confirm that your mail provider received this message. Check Sent mail before sending it again.';
const PROVIDERS: readonly ProviderKind[] = ['google', 'microsoft', 'imap', 'jmap'];
const PRESETS: readonly AccountPreset[] = [
  'gmail',
  'outlook',
  'icloud',
  'yahoo',
  'aol',
  'fastmail',
  'generic',
];
const unconfirmed = () => Object.assign(new Error(UNCONFIRMED), { unconfirmed: true });
const UNRESOLVED =
  'An earlier attempt to send this message may have been delivered, but it is not in Sent mail yet. Check Sent mail, or choose Send anyway to send it again.';
const unresolved = () => Object.assign(new Error(UNRESOLVED), { unconfirmed: true });
/** A sync whose provider index was replaced by a concurrent change; its result is dropped and fetched again. */
class StaleSync extends Error {}
const uncertain = (error: unknown) => (error as { uncertain?: unknown })?.uncertain === true;
const errorStatus = (error: unknown) => (error as { status?: unknown })?.status;
const clone = <T>(v: T): T => structuredClone(v);
const text = (v: unknown, max = 100_000): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid text or text is too long.');
  return v;
};
function object(v: unknown): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an object.');
  return v as Record<string, any>;
}
function date(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)))
    throw new Error('Enter a valid date.');
  return new Date(v).toISOString();
}
function dateOnly(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const source = text(v, 100),
    day = source.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  )
    throw new Error('Enter a valid due date.');
  return day;
}
function enumValue<const T extends string>(v: unknown, values: readonly T[]): T {
  if (!values.includes(v as T)) throw new Error('Invalid option.');
  return v as T;
}
const stripHTML = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const escapeHTML = (value: string) =>
  value.replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
function senderIdentity(draft: Draft, account: Account) {
  const email = draft.fromEmail ? safeEmail(draft.fromEmail) : account.email;
  const alias = account.sendAs?.find(item => item.email.toLowerCase() === email.toLowerCase());
  if (email.toLowerCase() !== account.email.toLowerCase() && !alias)
    throw new Error('Choose an authorized sending address for this account.');
  return { email, name: alias?.name || account.name, signature: alias?.signature || '' };
}
function outboundHTML(draft: Draft, settings: Settings, account: Account) {
  let html = draft.html;
  const include =
    draft.signature &&
    settings.signatureMode !== 'never' &&
    (settings.signatureMode === 'always' || draft.mode === 'new' || draft.mode === 'forward');
  if (include) {
    const signature =
      draft.signatureSource === 'account'
        ? senderIdentity(draft, account).signature
        : escapeHTML(settings.signature).replace(/\r?\n/g, '<br>');
    if (signature.trim()) html += `<div data-aplos-signature="true"><br>${signature}</div>`;
  }
  if (settings.footer) html += '<p data-aplos-footer="true">Sent with Aplos Mail</p>';
  return html;
}
const addresses = (value: string) =>
  value
    .split(/[,;]+/)
    .map(a => a.trim())
    .filter(Boolean);
function safeEmail(value: unknown): string {
  const email = text(value, 320).toLowerCase().trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
    throw new Error('Enter a valid email address.');
  return email;
}
function validRecipients(value: string) {
  for (const addr of addresses(value)) {
    const match = addr.match(/<([^<>]+)>$/);
    safeEmail(match ? match[1] : addr);
    if (/[\r\n]/.test(addr)) throw new Error('Invalid email address.');
  }
}
function threadPatch(raw: unknown): Partial<Thread> {
  const source = object(raw),
    patch: Partial<Thread> = {};
  if ('status' in source)
    patch.status = enumValue(source.status, ['new', 'done', 'later', 'trash', 'spam']);
  if ('importance' in source) patch.importance = enumValue(source.importance, ['important', 'low']);
  if ('replyStatus' in source)
    patch.replyStatus = enumValue(source.replyStatus, ['none', 'needs-reply', 'awaiting-reply']);
  for (const key of ['unread', 'bookmarked', 'hiddenFromHome', 'reminderFired'] as const) {
    if (key in source) {
      if (typeof source[key] !== 'boolean') throw new Error('Invalid checkbox value.');
      patch[key] = source[key];
    }
  }
  if ('dueDate' in source) patch.dueDate = dateOnly(source.dueDate);
  if ('reminderAt' in source) patch.reminderAt = date(source.reminderAt);
  if ('reminderAt' in source) patch.reminderFired = false;
  if ('todo' in source)
    patch.todo =
      source.todo === null || source.todo === undefined ? undefined : text(source.todo, 2_000);
  return patch;
}
function settingsPatch(raw: unknown): Partial<Settings> {
  const source = object(raw),
    patch: Partial<Settings> = {};
  const choices: Partial<Record<keyof Settings, readonly string[]>> = {
    theme: ['light', 'dark', 'system'],
    sidebarStyle: ['normal', 'minimized'],
    triageDirection: ['done-right', 'done-left'],
    doneAction: ['archive', 'read', 'unread'],
    laterAction: ['archive', 'read', 'unread'],
    lowAction: ['archive', 'read', 'unread'],
    defaultReply: ['reply', 'reply-all'],
    signatureMode: ['always', 'new', 'never'],
  };
  for (const key of Object.keys(defaultSettings) as (keyof Settings)[]) {
    if (!(key in source)) continue;
    const val = source[key];
    if (choices[key]) (patch as any)[key] = enumValue(val, choices[key]!);
    else if (typeof defaultSettings[key] === 'boolean') {
      if (typeof val !== 'boolean') throw new Error(`Invalid ${key} setting.`);
      (patch as any)[key] = val;
    } else if (key === 'undoSeconds') {
      if (!Number.isInteger(val) || val < 0 || val > 60)
        throw new Error('Undo send must be between 0 and 60 seconds.');
      patch.undoSeconds = val;
    } else if (key === 'accountNotifications') {
      const entries = object(val);
      if (Object.values(entries).some(v => typeof v !== 'boolean'))
        throw new Error('Invalid notification preferences.');
      patch.accountNotifications = Object.fromEntries(
        Object.entries(entries).map(([k, v]) => [text(k, 200), v]),
      );
    } else if (key === 'hiddenCalendars') {
      if (!Array.isArray(val) || val.length > 1_000) throw new Error('Invalid hidden calendars.');
      patch.hiddenCalendars = [...new Set(val.map(item => text(item, 1_400)))];
    } else if (key === 'askCustomUrl' || key === 'askOllamaUrl' || key === 'askLmStudioUrl') {
      const value = text(val, 500).trim();
      if (value) {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new Error('Enter the server address, e.g. http://localhost:11434/v1.');
        }
        if (!/^https?:$/.test(url.protocol) || url.username || url.password)
          throw new Error('Use an http or https address without a password in it.');
      }
      patch[key] = value;
    } else if (aiFeatures.some(f => f.setting === key)) {
      const feature = aiFeatures.find(f => f.setting === key)!,
        ref = parseFeatureModel(feature.id, val);
      if (!ref)
        throw new Error(
          feature.id === 'ask'
            ? 'Choose an Ask model.'
            : feature.id === 'voice'
              ? 'Choose a Voice model on Groq or ChatGPT.'
              : `Choose a model for ${feature.label.toLowerCase()}.`,
        );
      patch[feature.setting] = `${ref.provider}:${ref.model}`;
    } else (patch as any)[key] = text(val, key === 'signature' ? 20_000 : 1_000);
  }
  return patch;
}
function attachments(raw: unknown, randomUUID: () => string): Attachment[] {
  if (!Array.isArray(raw) || raw.length > 30) throw new Error('Attach at most 30 files.');
  let total = 0;
  return raw.map(item => {
    const a = object(item),
      data = a.data === undefined ? undefined : text(a.data, 35_000_000);
    if (data && !/^[a-zA-Z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid attachment data.');
    const size = data ? base64Bytes(data) : Number(a.size);
    if (!Number.isFinite(size) || size < 0) throw new Error('Invalid attachment size.');
    total += size;
    if (total > 25 * 1024 * 1024) throw new Error('Attachments must total less than 25 MB.');
    return {
      id: text(a.id || randomUUID(), 200),
      name: text(a.name, 500).replace(/[\r\n]/g, ''),
      type: text(a.type || 'application/octet-stream', 200),
      size,
      data,
      ...(a.contentId ? { contentId: text(a.contentId, 200) } : {}),
      ...(a.remoteId ? { remoteId: text(a.remoteId, 1000) } : {}),
      ...(a.messageId ? { messageId: text(a.messageId, 1000) } : {}),
    };
  });
}

/** Server addresses are settings, not secrets: a password embedded in the URL is refused. */
function webAddress(value: unknown): URL {
  let url: URL;
  try {
    url = new URL(text(value, 2000).trim());
  } catch {
    throw new Error('Enter a valid server address.');
  }
  if (url.username || url.password)
    throw new Error('Enter the password in the password field, not in the server address.');
  return url;
}
function serverSettings(raw: unknown): ServerSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  const source = object(raw);
  const endpoint = (value: unknown) => {
    const e = object(value),
      host = text(e.host, 253).trim().toLowerCase(),
      port = Number(e.port);
    if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.'))
      throw new Error('Enter a valid server name.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a valid port.');
    if (typeof e.secure !== 'boolean') throw new Error('Choose whether the connection uses TLS.');
    return { host, port, secure: e.secure };
  };
  const result: ServerSettings = { imap: endpoint(source.imap), smtp: endpoint(source.smtp) };
  if (source.username) result.username = text(source.username, 320).trim();
  if (source.caldav) {
    const url = webAddress(source.caldav);
    if (url.protocol !== 'https:') throw new Error('Calendar servers must use HTTPS.');
    result.caldav = url.href;
  }
  return result;
}
function connectRequest(p: Record<string, any>): ConnectRequest {
  const provider = enumValue(p.provider ?? 'google', PROVIDERS);
  const request: ConnectRequest = { provider };
  if (p.email !== undefined && p.email !== '') request.email = safeEmail(p.email);
  if (p.name)
    request.name = text(p.name, 200)
      .replace(/[\r\n]/g, ' ')
      .trim();
  if (p.secret !== undefined && p.secret !== '') {
    const secret = text(p.secret, 4000);
    if (/[\r\n]/.test(secret)) throw new Error('Passwords and tokens cannot contain line breaks.');
    request.secret = secret;
  }
  if (p.preset !== undefined) request.preset = enumValue(p.preset, PRESETS);
  const server = serverSettings(p.server);
  if (server) request.server = server;
  if (p.sessionUrl) {
    const url = webAddress(p.sessionUrl);
    if (url.protocol !== 'https:') throw new Error('The JMAP session URL must use HTTPS.');
    request.sessionUrl = url.href;
  }
  return request;
}
/** Older saves used Gmail-specific field names. */
function migrateLegacy(state: AppState) {
  for (const t of state.threads) {
    const legacy = t as Thread & { gmailId?: string };
    if (legacy.gmailId && !t.remoteId) t.remoteId = legacy.gmailId;
    delete legacy.gmailId;
    for (const m of t.messages)
      for (const a of m.attachments) {
        const old = a as Attachment & { gmailAttachmentId?: string };
        if (old.gmailAttachmentId && !a.remoteId) a.remoteId = old.gmailAttachmentId;
        delete old.gmailAttachmentId;
      }
  }
  for (const e of state.events) {
    const legacy = e as CalendarEvent & { googleId?: string };
    if (legacy.googleId && !e.remoteId) e.remoteId = legacy.googleId;
    delete legacy.googleId;
  }
  for (const d of state.drafts) {
    if ((d.signatureSource as string) === 'gmail') d.signatureSource = 'account';
    for (const a of d.attachments) {
      const old = a as Attachment & { gmailAttachmentId?: string };
      if (old.gmailAttachmentId && !a.remoteId) a.remoteId = old.gmailAttachmentId;
      delete old.gmailAttachmentId;
    }
  }
}

export async function createEngineService(options: EngineOptions) {
  const randomUUID = options.randomUUID;
  const now = options.now || (() => new Date());
  const symbols = options.symbols ?? (async () => ({}));
  const store = options.store;
  let state = store.read() || createDemo(now());
  // Feature models a stored state has never had; Summaries, Drafts and Plans then follow GROQ_MODEL if the host set it.
  const unsetModels = new Set(
    aiFeatures.filter(f => !(f.setting in (state.settings ?? {}))).map(f => f.id),
  );
  state.settings = { ...clone(defaultSettings), ...state.settings };
  // Split view and the top bar layout were removed; drop their old settings from stored state.
  delete (state.settings as Settings & { openMode?: unknown }).openMode;
  delete (state.settings as Settings & { layout?: unknown }).layout;
  // Feature models are `provider:model`; a bare Groq ID from an earlier build keeps working, anything unreadable falls back.
  for (const f of aiFeatures) {
    const seeded =
      options.groqModel && unsetModels.has(f.id) && f.id !== 'ask' && f.id !== 'voice'
        ? parseFeatureModel(f.id, `groq:${options.groqModel}`)
        : undefined;
    const ref = seeded ?? parseFeatureModel(f.id, state.settings[f.setting]);
    state.settings[f.setting] = ref ? `${ref.provider}:${ref.model}` : f.fallback;
  }
  state.sync = { ...state.sync, busy: false };
  for (const thread of state.threads) if (thread.dueDate) thread.dueDate = dateOnly(thread.dueDate);
  migrateLegacy(state);
  const { groq, staged, providers, workflow, workflowError } = options;
  const brokenProviders = options.brokenProviders ?? new Map<ProviderKind, string>();
  const workflowAt = new Map<string, number>();
  /** Record edited threads (as they are after the edit) for device sync, saved with the edit itself. */
  const noteWorkflow = (after: Thread[], patch?: Partial<Thread>): MemoryStage | undefined => {
    if (!workflow?.enabled || !after.length || (patch && !WORKFLOW_KEYS.some(key => key in patch)))
      return;
    const stage = staged.stage();
    stage.run(() => workflow!.noteEdits(after));
    return stage;
  };
  /** Bumped when an account is connected or removed, so a sync that started before is not applied after. */
  const generations = new Map<string, number>();
  const bumpGeneration = (id: string) => generations.set(id, (generations.get(id) ?? 0) + 1);
  const live = (id: string, generation: number) =>
    (generations.get(id) ?? 0) === generation && state.accounts.some(a => a.id === id);
  /** The mail host behind an account, or nothing for local demo accounts. */
  const hostOf = (a: Pick<Account, 'provider'> | undefined): MailProvider | undefined =>
    a && a.provider !== 'demo' ? providers[a.provider] : undefined;
  function host(a: Account): MailProvider {
    const provider = hostOf(a);
    if (!provider) throw new Error('This account type is not available in this version of Aplos.');
    return provider;
  }
  const listeners = new Set<Listener>(),
    timers = new Map<string, ReturnType<typeof setTimeout>>(),
    requests = new Map<string, AbortController>(),
    sending = new Set<string>();
  const jobs = new Set<Promise<void>>();
  const undo: Array<Thread[]> = [];
  const gate = createGate({ now: () => now().getTime() }),
    extrasAt = new Map<string, number>();
  let syncing: Promise<void> | undefined;
  let closed = false;
  /** Windows follow commits by number; a new epoch after a restart tells them to reload. */
  const epoch = randomUUID();
  let rev = 0;
  state.epoch = epoch;
  state.rev = rev;
  const emit = (type: string, payload?: unknown) => {
    for (const listener of listeners) {
      try {
        listener({ type, payload: clone(payload) });
      } catch {
        /* A closed renderer must not interrupt persistence. */
      }
    }
  };
  let queue: QueuedOp[] = store.ops();
  /**
   * Threads changed locally while an account's sync is in flight. Its response was read before those
   * changes reached the host, so it must not overwrite them even after their queued ops have flushed.
   */
  const touched = new Map<string, Set<string>>();
  interface CommitExtras {
    stage?: MemoryStage;
    cursor?: SaveExtras['cursor'];
  }
  function commit(next: AppState, ops?: OpChanges, extras?: CommitExtras) {
    const memory = extras?.stage?.writes();
    if (extras?.stage && !memory) {
      extras.stage.discard();
      throw new StaleSync('Mail changed while syncing.');
    }
    let nextQueue = queue;
    if (ops) {
      const removed = new Set(ops.remove ?? []),
        put = new Map((ops.put ?? []).map(op => [op.id, op]));
      nextQueue = [
        ...queue.filter(op => !removed.has(op.id)).map(op => put.get(op.id) ?? op),
        ...[...put.values()].filter(op => !queue.some(old => old.id === op.id)),
      ];
    }
    for (const op of ops?.put ?? []) touched.get(op.accountId)?.add(op.threadId);
    const pending = nextQueue.length || undefined;
    if (next.sync.pending !== pending) next.sync = { ...next.sync, pending };
    let diff: StoreDiff;
    try {
      diff = store.write(next, ops, { memory, cursor: extras?.cursor });
    } catch (error) {
      extras?.stage?.discard();
      throw error;
    }
    extras?.stage?.committed();
    state = next;
    queue = nextQueue;
    state.epoch = epoch;
    state.rev = rev;
    publish(diff);
  }
  /** Tell windows what the save changed, rather than resending the whole mailbox. */
  function publish(diff: StoreDiff) {
    if (!diff.threads.length && !diff.removed.length && !diff.changed.length) return;
    state.rev = ++rev;
    const changes: StateChanges = { epoch, rev };
    if (diff.threads.length || diff.removed.length) {
      const ids = new Set(diff.threads);
      changes.threads = { put: state.threads.filter(t => ids.has(t.id)), remove: diff.removed };
    }
    for (const key of diff.changed)
      (changes as unknown as Record<string, unknown>)[key] = state[key];
    emit('changes', changes);
  }
  function change(fn: (next: AppState) => void, ops?: OpChanges, extras?: CommitExtras) {
    const next = clone(state);
    fn(next);
    commit(next, ops, extras);
  }
  /** Queue bookkeeping only touches `sync.pending`, so it skips the full-state clone. */
  const changeQueue = (ops: OpChanges) => commit({ ...state, sync: { ...state.sync } }, ops);
  function account(id: string): Account {
    const result = state.accounts.find(a => a.id === id);
    if (!result) throw new Error('Account not found.');
    return clone(result);
  }
  function thread(id: string): Thread {
    const result = state.threads.find(t => t.id === id);
    if (!result) throw new Error('Message not found.');
    return clone(result);
  }
  function draft(id: string): Draft {
    const result = state.drafts.find(d => d.id === id);
    if (!result) throw new Error('Draft not found.');
    return clone(result);
  }
  function stopSend(id: string) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  }
  function checkReminders() {
    const due = state.threads.filter(
      t =>
        t.status === 'later' &&
        t.reminderAt &&
        !t.reminderFired &&
        Date.parse(t.reminderAt) <= now().getTime(),
    );
    if (!due.length) return;
    // The host must see the thread back in the inbox too, or the next sync would file it away again.
    const ops = due
      .map(t =>
        queued(t, {
          status: 'new',
          unread: true,
          labels: t.labels && !t.labels.includes('INBOX') ? [...t.labels, 'INBOX'] : t.labels,
        }),
      )
      .filter((op): op is QueuedOp => !!op);
    const fire = (t: Thread) => {
      t.status = 'new';
      t.hiddenFromHome = false;
      t.reminderFired = true;
      t.unread = true;
      if (t.labels && !t.labels.includes('INBOX')) t.labels = [...t.labels, 'INBOX'];
    };
    const stage = noteWorkflow(
      due.map(t => {
        const after = clone(t);
        fire(after);
        return after;
      }),
    );
    change(
      s => {
        for (const t of s.threads) if (due.some(d => d.id === t.id)) fire(t);
      },
      { put: ops },
      { stage },
    );
    for (const t of due) emit('reminder', { threadId: t.id, title: t.subject });
    if (ops.length) kick();
  }
  /** The provider change for a local thread edit, or nothing for local-only (demo) mail. */
  function queued(t: Thread, patch: Partial<Thread>): QueuedOp | undefined {
    const a = state.accounts.find(x => x.id === t.accountId);
    // Real accounts queue even while their adapter is missing, so nothing is lost until it returns.
    if (!a || a.provider === 'demo' || !t.remoteId) return;
    const at = now().toISOString();
    return {
      id: randomUUID(),
      accountId: a.id,
      threadId: t.id,
      remoteId: t.remoteId,
      fromStatus: t.status,
      ...(t.labels ? { fromLabels: t.labels } : {}),
      patch,
      createdAt: at,
      attempts: 0,
      nextAt: at,
    };
  }
  const defaults = new Map<string, string>();
  async function defaultCalendar(a: Account, provider: MailProvider): Promise<string | undefined> {
    if (defaults.has(a.id)) return defaults.get(a.id);
    try {
      const id = (await provider.listCalendars?.(a))?.find(c => c.primary)?.id;
      if (id) defaults.set(a.id, id);
      return id;
    } catch {
      return undefined;
    }
  }
  let flushing: Promise<void> | undefined;
  /**
   * Send queued changes in order. One account's failure holds back only that account's later changes,
   * so a thread never receives an older change after a newer one.
   */
  function flush(force = false): Promise<void> {
    if (flushing) return flushing;
    const run = (async () => {
      for (let progressed = true; progressed && !closed;) {
        progressed = false;
        const held = new Set<string>();
        for (const op of [...queue]) {
          if (closed) break;
          if (held.has(op.accountId)) continue;
          const a = state.accounts.find(x => x.id === op.accountId);
          const provider = hostOf(a);
          if (!a || a.provider === 'demo') {
            changeQueue({ remove: [op.id] });
            continue;
          }
          if (!provider || !a.connected || (!force && Date.parse(op.nextAt) > now().getTime())) {
            held.add(op.accountId);
            continue;
          }
          try {
            await provider.updateThread(
              a,
              { remoteId: op.remoteId, status: op.fromStatus, labels: op.fromLabels },
              op.patch,
            );
            if (queue.some(o => o.id === op.id)) changeQueue({ remove: [op.id] });
            progressed = true;
          } catch (error) {
            // Disconnect may have discarded this change while the host was answering; it must not come back.
            if (!queue.some(o => o.id === op.id)) continue;
            // The thread is gone at the host; there is nothing left to change.
            if (errorStatus(error) === 404) {
              changeQueue({ remove: [op.id] });
              continue;
            }
            const attempts = op.attempts + 1,
              delay = Math.min(OP_RETRY_MAX_MS, OP_RETRY_MS * 2 ** (attempts - 1));
            changeQueue({
              put: [
                {
                  ...op,
                  attempts,
                  nextAt: new Date(now().getTime() + delay).toISOString(),
                  error:
                    error instanceof Error ? error.message : 'The mail host could not be updated.',
                },
              ],
            });
            held.add(op.accountId);
          }
        }
        force = false;
      }
    })();
    flushing = run.finally(() => {
      flushing = undefined;
    });
    return flushing;
  }
  function kick() {
    const job = flush().catch(() => {
      emit('error', {
        message: 'Queued changes could not be saved. Check free space and folder permissions.',
      });
    });
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  }
  function sendError(id: string, error: unknown) {
    const message = error instanceof Error ? error.message : 'Sending failed. Please try again.';
    // An attempt whose outcome is unknown keeps its marker and Message-ID, so every retry checks Sent first.
    const unresolved = (error as { unconfirmed?: unknown })?.unconfirmed === true;
    if (state.drafts.some(d => d.id === id))
      change(s => {
        const d = s.drafts.find(d => d.id === id)!;
        delete d.pendingSendAt;
        if (!unresolved) delete d.sendAttemptAt;
        d.sendError = message;
      });
  }
  async function confirmSent(a: Account, messageId: string | undefined) {
    let found: { id: string; threadId: string } | undefined;
    if (messageId)
      try {
        found = await host(a).findSent(a, messageId);
      } catch {
        /* Unknown is treated like not found: never resend blindly. */
      }
    if (!found) throw unconfirmed();
    return found;
  }
  function finishSend(
    id: string,
    d: Draft,
    a: Account,
    sender: { email: string; name: string },
    remote?: { threadId?: string },
  ) {
    const sentAt = now().toISOString();
    change(s => {
      s.drafts = s.drafts.filter(item => item.id !== id);
      const message = {
        id: randomUUID(),
        from: sender.email,
        fromName: sender.name,
        to: addresses(d.to),
        cc: addresses(d.cc),
        date: sentAt,
        text: stripHTML(d.html),
        html: d.html,
        attachments: d.attachments,
        sent: true,
        ...(d.messageId ? { internetId: d.messageId } : {}),
      };
      const existing = d.threadId ? s.threads.find(t => t.id === d.threadId) : undefined;
      if (existing) {
        existing.messages.push(message);
        existing.date = sentAt;
        existing.replyStatus = 'awaiting-reply';
        existing.status = 'done';
        existing.hiddenFromHome = false;
        existing.unread = false;
      } else
        s.threads.unshift({
          id: remote?.threadId ? `${a.id}:${remote.threadId}` : randomUUID(),
          ...(remote?.threadId ? { remoteId: remote.threadId } : {}),
          accountId: a.id,
          subject: d.subject,
          summary: stripHTML(d.html).slice(0, 240),
          messages: [message],
          date: sentAt,
          unread: false,
          status: 'done',
          importance: 'important',
          bookmarked: false,
          replyStatus: 'awaiting-reply',
        });
    });
    emit('sent', { draftId: id, playSound: state.settings.sendSound });
  }
  /** A send that was in flight when Aplos stopped: settle it from Sent mail, never by sending again. */
  async function recoverSend(id: string) {
    if (sending.has(id)) return;
    sending.add(id);
    try {
      const d = draft(id),
        a = state.accounts.find(x => x.id === d.accountId);
      if (!a || !hostOf(a)) throw unconfirmed();
      const remote = await confirmSent(a, d.messageId);
      let sender: { email: string; name: string };
      try {
        sender = senderIdentity(d, a);
      } catch {
        sender = { email: a.email, name: a.name };
      }
      finishSend(id, { ...d, html: outboundHTML(d, state.settings, a) }, a, sender, remote);
    } catch (error) {
      sendError(id, error);
    } finally {
      sending.delete(id);
    }
  }
  async function deliver(id: string) {
    stopSend(id);
    if (closed || sending.has(id)) return;
    const original = state.drafts.find(d => d.id === id);
    if (!original?.pendingSendAt) return;
    if (Date.parse(original.pendingSendAt) > now().getTime() + 20) {
      scheduleSend(original);
      return;
    }
    sending.add(id);
    try {
      const d = clone(original),
        a = account(d.accountId);
      if (!a.connected) throw new Error('Reconnect this account before sending.');
      const sender = senderIdentity(d, a);
      d.html = outboundHTML(d, state.settings, a);
      let sent: { threadId?: string } | undefined;
      if (a.provider !== 'demo') {
        const provider = host(a);
        // An earlier attempt with this Message-ID may have reached the host; check Sent before submitting again.
        if (d.sendAttemptAt && d.messageId) {
          let earlier: { id: string; threadId: string } | undefined;
          try {
            earlier = await provider.findSent(a, d.messageId);
          } catch {
            throw unconfirmed();
          }
          if (earlier) {
            finishSend(id, d, a, sender, earlier);
            return;
          }
          // Not finding it proves nothing: hosts deliver asynchronously and SMTP has no idempotency.
          if (!d.resendConfirmed) throw unresolved();
        }
        // Recorded before the request leaves, so a crash mid-send is settled from Sent mail instead of retried.
        change(s => {
          const item = s.drafts.find(item => item.id === id)!;
          item.sendAttemptAt = now().toISOString();
          delete item.resendConfirmed;
        });
        const original = d.threadId ? state.threads.find(t => t.id === d.threadId) : undefined;
        try {
          sent = await provider.send(a, d, original && clone(original));
        } catch (error) {
          if (!uncertain(error)) throw error;
          sent = await confirmSent(a, d.messageId);
        }
      }
      finishSend(id, d, a, sender, sent);
    } catch (error) {
      sendError(id, error);
    } finally {
      sending.delete(id);
    }
  }
  function scheduleSend(d: Draft) {
    stopSend(d.id);
    if (!d.pendingSendAt) return;
    const remaining = Math.max(0, Date.parse(d.pendingSendAt) - now().getTime());
    const timer = setTimeout(
      () => {
        const job = deliver(d.id).catch(() => {
          emit('error', {
            message:
              'The send result could not be saved. Check local storage before retrying this draft.',
          });
        });
        jobs.add(job);
        void job.finally(() => jobs.delete(job));
      },
      Math.min(remaining, 2_147_483_647),
    );
    (timer as unknown as { unref?: () => void }).unref?.();
    timers.set(d.id, timer);
  }
  /** Local full-text and operator search, plus the host's own search where it has one (offline-safe). */
  async function searchMail(query: string, accountId?: string): Promise<Thread[]> {
    const tokens = query.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const operators = new Set(['from', 'to', 'subject', 'has', 'is', 'in', 'after', 'before']);
    const free = tokens
      .map(token => token.replace(/"/g, ''))
      .filter(token => {
        const colon = token.indexOf(':');
        return colon <= 0 || !operators.has(token.slice(0, colon).toLowerCase());
      });
    // Words are matched by prefix through the full-text index; text without letters or digits falls back to a substring scan.
    const indexed =
      free.length && ftsQuery(free.join(' '))
        ? new Set(store.searchText(free.join(' '), accountId, 5_000))
        : undefined;
    const matches = state.threads.filter(
      t =>
        (!accountId || t.accountId === accountId) &&
        (!indexed || indexed.has(t.id)) &&
        tokens.every(token => {
          const value = token.replace(/"/g, '').toLowerCase(),
            colon = value.indexOf(':'),
            key = colon > 0 ? value.slice(0, colon) : '',
            term = colon > 0 ? value.slice(colon + 1) : value;
          if (key === 'from')
            return t.messages.some(m => `${m.from} ${m.fromName}`.toLowerCase().includes(term));
          if (key === 'to')
            return t.messages.some(m => m.to.some(to => to.toLowerCase().includes(term)));
          if (key === 'subject') return t.subject.toLowerCase().includes(term);
          if (key === 'has' && term === 'attachment')
            return t.messages.some(m => m.attachments.length > 0);
          if (key === 'is')
            return term === 'unread'
              ? t.unread
              : term === 'read'
                ? !t.unread
                : term === 'starred' || term === 'bookmarked'
                  ? t.bookmarked
                  : term === 'important'
                    ? t.importance === 'important'
                    : t.status === term;
          if (key === 'in')
            return term === 'inbox'
              ? t.status === 'new'
              : term === 'trash' || term === 'spam' || term === 'later' || term === 'done'
                ? t.status === term
                : term === 'sent'
                  ? t.messages.some(m => m.sent)
                  : false;
          if (key === 'after' || key === 'before') {
            const n = Date.parse(term);
            return (
              Number.isFinite(n) &&
              (key === 'after' ? Date.parse(t.date) > n : Date.parse(t.date) < n)
            );
          }
          if (indexed) return true;
          return [t.subject, t.summary, ...t.messages.map(m => `${m.from} ${m.fromName} ${m.text}`)]
            .join(' ')
            .toLowerCase()
            .includes(value);
        }),
    );
    const found = new Map(matches.map(t => [t.id, t]));
    const additions: Thread[] = [];
    for (const a of state.accounts.filter(a => a.connected && (!accountId || a.id === accountId))) {
      const provider = hostOf(a);
      if (!provider?.capabilities(a).serverSearch) continue;
      try {
        for (const t of await provider.search(a, query)) {
          if (!found.has(t.id))
            found.set(t.id, state.threads.find(local => local.id === t.id) || t);
          if (!state.threads.some(local => local.id === t.id)) additions.push(t);
        }
      } catch {
        /* Local results remain useful offline. */
      }
    }
    if (additions.length)
      change(s => {
        for (const t of additions)
          if (!s.threads.some(local => local.id === t.id)) s.threads.push(t);
      });
    return [...found.values()].sort((a, b) => b.date.localeCompare(a.date));
  }
  /** A server provider's address: the setting, or the app's default local port. */
  function serverUrl(id: AskServerId) {
    return state.settings[askServerSetting[id]] || askProvider(id).defaultAddress || '';
  }
  /** A provider's transport; a provider without its key says which variable to set. */
  function chatProvider(id: AskProviderId) {
    if (id === 'groq') return { available: groq.available, chat: groq.chat };
    if (isAskServer(id)) {
      const url = serverUrl(id);
      return url ? options.serverChat?.(id, url) : undefined;
    }
    return options.chats?.[id];
  }
  function askTransport(id: AskProviderId) {
    const transport = chatProvider(id),
      provider = askProvider(id);
    if (id === 'custom' && !state.settings.askCustomUrl)
      throw new Error('Add your server’s address in Settings → AI, or choose another model.');
    if (!transport?.available)
      throw new Error(
        `Add your ${provider.label} key in Settings → AI to use ${provider.label}, or choose another model.`,
      );
    return transport;
  }
  /** The model a feature uses, from Settings → AI. */
  function choice(feature: AiFeature) {
    return (
      parseFeatureModel(feature, state.settings[aiFeature(feature).setting]) ??
      parseFeatureModel(feature, aiFeature(feature).fallback)!
    );
  }
  /**
   * Whether a feature's provider can answer now, so background work (sorting new mail) skips quietly when it can't.
   * A local app (Ollama, LM Studio) counts only while it is running; otherwise every request would fail.
   */
  async function ready(feature: AiFeature) {
    const { provider } = choice(feature);
    if (provider === 'groq') return groq.available;
    if (provider === 'custom' && !state.settings.askCustomUrl) return false;
    const transport = chatProvider(provider);
    if (!transport?.available) return false;
    return transport.status
      ? (await transport.status().catch(() => ({ running: false }))).running
      : true;
  }
  /** Summaries, drafts and plans on the feature's provider. Groq keeps its own JSON-mode call. */
  function writer(feature: 'summary' | 'draft' | 'plan') {
    const { provider, model } = choice(feature);
    if (provider === 'groq')
      return {
        summarize: (t: Thread, signal?: AbortSignal) => groq.summarize(t, signal, model),
        polish: (html: string, instruction: string | undefined, signal?: AbortSignal) =>
          groq.polish(html, instruction, signal, model),
        draft: (
          instruction: string,
          t: Thread | undefined,
          d: Partial<Draft> | undefined,
          signal?: AbortSignal,
        ) => groq.draft(instruction, t, d, signal, model),
        extractEvents: (t: Thread, signal?: AbortSignal, context: { timeZone?: string } = {}) =>
          groq.extractEvents(t, signal, { ...context, model }),
      };
    return createWriter(
      chatJson(askTransport(provider).chat, model, askProvider(provider).label),
      askProvider(provider).label,
    );
  }
  function transcribe(audio: string, mimeType: string, signal?: AbortSignal) {
    const { provider, model } = choice('voice');
    if (provider === 'groq') return groq.transcribe(audio, mimeType, signal, model);
    const transport = askTransport(provider);
    if (!transport.transcribe)
      throw new Error(
        `${askProvider(provider).label} can’t turn speech into text. Choose a Groq or ChatGPT Voice model in Settings → AI.`,
      );
    return transport.transcribe(audio, mimeType, model, signal);
  }
  async function ai<T>(
    payload: Record<string, any>,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const id = payload.requestId ? text(payload.requestId, 200) : randomUUID();
    if (requests.has(id)) throw new Error('This AI request is already running.');
    const controller = new AbortController();
    requests.set(id, controller);
    emit('ai.start', { requestId: id });
    try {
      const result = await fn(controller.signal);
      if (controller.signal.aborted) throw new Error('AI request cancelled.');
      return result;
    } finally {
      requests.delete(id);
      emit('ai.end', { requestId: id });
    }
  }
  async function updateThreads(
    ids: string[],
    patch: Partial<Thread>,
    recordUndo = true,
    compact = false,
  ) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1_000)
      throw new Error('Choose one or more messages.');
    const before = [...new Set(ids)].map(id => thread(text(id, 300)));
    const updates = before.map(t => {
      const p = { ...patch };
      const action =
        patch.status === 'done'
          ? state.settings.doneAction
          : patch.status === 'later'
            ? state.settings.laterAction
            : patch.importance === 'low'
              ? state.settings.lowAction
              : undefined;
      if (action === 'read') p.unread = false;
      if (action === 'unread') p.unread = true;
      if (action === 'archive' && t.labels) p.labels = t.labels.filter(l => l !== 'INBOX');
      // Read/unread actions keep the thread where it is; an explicit label set stops hosts from inferring an archive.
      else if (action && t.labels) p.labels = [...t.labels];
      if (patch.status === 'new') {
        p.hiddenFromHome = false;
        if (t.labels && !t.labels.includes('INBOX')) p.labels = [...t.labels, 'INBOX'];
      }
      return { thread: t, patch: p };
    });
    for (const update of updates) account(update.thread.accountId);
    // Local first, in one transaction with the queued provider changes; the host catches up through the queue.
    const ops = updates.map(u => queued(u.thread, u.patch)).filter((op): op is QueuedOp => !!op);
    const stage = noteWorkflow(
      updates.map(u => ({ ...u.thread, ...u.patch })),
      patch,
    );
    const replacements = new Map(updates.map(u => [u.thread.id, { ...u.thread, ...u.patch }]));
    commit(
      { ...state, threads: state.threads.map(t => replacements.get(t.id) ?? t) },
      { put: ops },
      { stage },
    );
    if (recordUndo) {
      undo.push(before);
      if (undo.length > 50) undo.shift();
    }
    if (ops.length) kick();
    return compact ? { epoch, rev } : clone(state);
  }
  type SummaryRun = { input: Thread; work: Promise<Partial<Thread>> };
  /** Emails being summarized right now (the list shows them), with the thread each run was given. */
  const summarizing = new Map<string, SummaryRun>();
  /**
   * One summary per email at a time. A request for the same messages shares the running one (its failure too);
   * one that includes newer mail waits for it to finish, then summarizes the email as it is then. Returns the
   * thread that was summarized, so callers keep edits made since then.
   */
  async function tracked(
    threadId: string,
    work: (t: Thread) => Promise<Partial<Thread>>,
  ): Promise<{ input: Thread; result: Partial<Thread> }> {
    const latest = thread(threadId).messages.at(-1)?.id;
    for (let run = summarizing.get(threadId); run; run = summarizing.get(threadId)) {
      if (run.input.messages.at(-1)?.id === latest)
        return { input: run.input, result: await run.work };
      await run.work.catch(() => {});
    }
    const input = thread(threadId),
      run = { input, work: work(input) };
    summarizing.set(threadId, run);
    emit('ai.summarizing', { threadId, active: true });
    const done = () => {
      if (summarizing.get(threadId) === run) {
        summarizing.delete(threadId);
        emit('ai.summarizing', { threadId, active: false });
      }
    };
    run.work.then(done, done);
    return { input, result: await run.work };
  }
  /** Threads in `refresh` already have the user's triage; only their summary and reply state follow new mail. Threads in `summaryOnly` (Spam) take just the summary. */
  async function classifyIncoming(
    fresh: Thread[],
    a: Account,
    refresh: Set<string> = new Set(),
    summaryOnly: Set<string> = new Set(),
  ): Promise<string[]> {
    if (!fresh.length) return [];
    // Summaries and plans can run on different providers, so each is checked on its own.
    const summaries = await ready('summary'),
      plans = state.settings.autoCalendar && !!a.calendarConnected && (await ready('plan'));
    if (!summaries && !plans) return [];
    let cursor = 0,
      classificationFailures = 0,
      calendarFailures = 0,
      cancelled = false;
    try {
      await ai({ requestId: `sync-ai-${a.id}` }, async signal => {
        // Bound concurrency while keeping a first sync responsive for larger mailboxes.
        await Promise.all(
          Array.from({ length: Math.min(3, fresh.length) }, async () => {
            while (cursor < fresh.length && !signal.aborted) {
              const candidate = fresh[cursor++];
              if (!state.threads.some(t => t.id === candidate.id)) continue;
              const before = thread(candidate.id);
              if (summaries)
                try {
                  // A reader request for the same messages is shared; edits it already made win, as below.
                  const { input: base, result } = await tracked(candidate.id, t =>
                    writer('summary').summarize(t, signal),
                  );
                  if (signal.aborted) break;
                  const classified = threadPatch({
                    importance: result.importance || base.importance,
                    replyStatus: result.replyStatus || base.replyStatus,
                    todo: result.todo,
                    dueDate: result.dueDate,
                  });
                  if (typeof result.summary === 'string')
                    classified.summary = result.summary.slice(0, 10_000);
                  // The suggested action follows the latest mail, like the summary; writer.ts already validated it against the thread.
                  classified.action = result.action;
                  change(s => {
                    const current = s.threads.find(t => t.id === candidate.id);
                    if (!current) return;
                    for (const key of summaryOnly.has(candidate.id)
                      ? (['summary'] as const)
                      : refresh.has(candidate.id)
                        ? (['replyStatus', 'summary', 'action'] as const)
                        : ([
                            'importance',
                            'replyStatus',
                            'todo',
                            'dueDate',
                            'summary',
                            'action',
                          ] as const)) {
                      // An edit made while the model was running always wins over its response.
                      if (
                        JSON.stringify(current[key]) === JSON.stringify(base[key]) &&
                        key in classified
                      ) {
                        (current as any)[key] = classified[key];
                        if (key === 'summary') current.aiSummary = true;
                      }
                    }
                  });
                } catch {
                  if (signal.aborted) break;
                  classificationFailures++;
                }
              // Plans are never added from Spam.
              if (
                plans &&
                state.settings.autoCalendar &&
                !summaryOnly.has(candidate.id) &&
                !signal.aborted
              ) {
                try {
                  const extracted = await writer('plan').extractEvents(before, signal);
                  for (const event of extracted) {
                    if (signal.aborted || !state.settings.autoCalendar) break;
                    if (
                      !event.title ||
                      !event.start ||
                      !event.end ||
                      !Number.isFinite(Date.parse(event.start)) ||
                      Date.parse(event.end) <= Date.parse(event.start)
                    )
                      continue;
                    await invoke('calendar.save', {
                      event: {
                        ...event,
                        id: randomUUID(),
                        accountId: a.id,
                        threadId: before.id,
                        calendarId: event.calendarId || 'primary',
                      },
                    });
                  }
                } catch {
                  if (signal.aborted) break;
                  calendarFailures++;
                }
              }
            }
          }),
        );
        return undefined;
      });
    } catch {
      cancelled = true;
    }
    const warnings: string[] = [];
    if (classificationFailures)
      warnings.push(
        `Mail synced for ${a.email}, but AI could not classify ${classificationFailures} new thread${classificationFailures === 1 ? '' : 's'}. Use Summarize to retry.`,
      );
    if (calendarFailures)
      warnings.push(
        `Mail synced for ${a.email}, but automatic calendar extraction or saving failed for ${calendarFailures} thread${calendarFailures === 1 ? '' : 's'}. Review the message and retry.`,
      );
    if (cancelled)
      warnings.push(`Mail synced for ${a.email}; automatic AI processing was cancelled.`);
    for (const message of warnings) emit('error', { message });
    return warnings;
  }
  async function syncAccount(a: Account, manual: boolean, errors: string[]) {
    const changedDuring = new Set<string>();
    touched.set(a.id, changedDuring);
    try {
      // A result built on a provider index that changed underneath it is dropped and fetched again.
      for (let attempt = 0; ; attempt++) {
        try {
          await syncAccountOnce(a, manual, errors, changedDuring);
          break;
        } catch (error) {
          if (!(error instanceof StaleSync) || attempt >= 2) throw error;
        }
      }
    } finally {
      if (touched.get(a.id) === changedDuring) touched.delete(a.id);
    }
  }
  async function syncAccountOnce(
    a: Account,
    manual: boolean,
    errors: string[],
    changedDuring: Set<string>,
  ) {
    const generation = generations.get(a.id) ?? 0;
    const cursor = store.cursor(a.id),
      local = new Set(state.threads.filter(t => t.accountId === a.id).map(t => t.id));
    const provider = host(a),
      stage = staged.stage();
    let events: CalendarEvent[] | undefined, result: SyncResult;
    try {
      // Index writes made by the provider here are saved only together with the mail and cursor below.
      result = await stage.run(async () => {
        const result = await provider.sync(a, cursor, { has: id => local.has(id) });
        if (
          manual ||
          !cursor ||
          now().getTime() - (extrasAt.get(a.id) ?? 0) >= EXTRAS_INTERVAL_MS
        ) {
          try {
            a.sendAs = provider.getSendAs
              ? await provider.getSendAs(a)
              : a.sendAs?.length
                ? a.sendAs
                : [{ email: a.email, name: a.name, signature: '', isDefault: true }];
            delete a.error;
          } catch {
            const message =
              'Sending addresses and signatures are unavailable. Reconnect to grant settings access; the primary address is still available.';
            a.sendAs = [{ email: a.email, name: a.name, signature: '', isDefault: true }];
            a.error = message;
            errors.push(message);
            if (manual) emit('error', { message });
          }
          if (a.calendarConnected && provider.listEvents)
            try {
              events = await provider.listEvents(a);
            } catch {
              /* Mail sync remains available without Calendar permission. */
            }
          extrasAt.set(a.id, now().getTime());
        } else {
          const current = state.accounts.find(x => x.id === a.id);
          if (current?.error && !/sending addresses/i.test(current.error)) delete a.error;
          else if (current?.error) a.error = current.error;
        }
        return result;
      });
    } catch (error) {
      stage.discard();
      throw error;
    }
    // Disconnected (or reconnected) while the host was answering: this result belongs to the old account.
    if (!live(a.id, generation)) {
      stage.discard();
      return;
    }
    const since = Date.parse(state.sync.lastSync || now().toISOString());
    const protectedIds = new Set([
      ...queue.filter(op => op.accountId === a.id).map(op => op.threadId),
      ...changedDuring,
    ]);
    const s = clone(state);
    const duplicateOps: QueuedOp[] = [];
    const outcome = applySync(s, a.id, result, protectedIds);
    // A message sent without a host thread ID was kept as a local copy; drop it once the host's copy arrives.
    const arrived = new Set(
      result.threads
        .flatMap(t => t.messages.map(m => m.internetId))
        .filter((id): id is string => !!id),
    );
    if (arrived.size)
      s.threads = s.threads.filter(
        t =>
          t.accountId !== a.id ||
          !!t.remoteId ||
          !t.messages.every(m => m.sent && m.internetId && arrived.has(m.internetId)),
      );
    // Occurrences of a recurring event share the host's ID, so events are told apart by their own.
    if (events) {
      s.events = s.events.filter(e => e.accountId !== a.id || !e.remoteId);
      for (const event of events) if (!s.events.some(e => e.id === event.id)) s.events.push(event);
    }
    const acc = s.accounts.find(x => x.id === a.id);
    if (acc) {
      acc.sendAs = a.sendAs;
      acc.capabilities = provider.capabilities(acc);
      if (a.error) acc.error = a.error;
      else delete acc.error;
    }
    const older = olderInboxDuplicates(
      s.threads,
      a.id,
      new Set(outcome.arrivals.map(t => t.id)),
      protectedIds,
    );
    for (const t of older) {
      // Always archive an exact duplicate, independently of the user's Done/read mapping.
      const patch: Partial<Thread> = {
        status: 'done',
        labels: (t.labels ?? []).filter(l => l !== 'INBOX'),
      };
      const op = queued(t, patch);
      if (op) duplicateOps.push(op);
      Object.assign(t, patch);
    }
    if (older.length && workflow?.enabled) stage.run(() => workflow.noteEdits(older));
    // Incoming mail, duplicate archives, provider indexes and cursor survive a crash together.
    commit(
      s,
      { put: duplicateOps },
      { stage, cursor: { accountId: a.id, cursor: result.cursor, now: now() } },
    );
    if (duplicateOps.length) kick();
    const current = (t: Thread) => state.threads.find(x => x.id === t.id);
    const inbox = outcome.arrivals
      .map(current)
      .filter((t): t is Thread => !!t && t.status === 'new');
    // A first sync downloads existing mail; nothing in it is news.
    if (
      cursor &&
      state.settings.notifications &&
      state.settings.accountNotifications[a.id] !== false
    )
      for (const t of inbox.filter(t => t.unread && Date.parse(t.date) > since).slice(0, 3))
        emit('notification', {
          title: t.messages.at(-1)?.fromName || 'New mail',
          body: t.subject,
          threadId: t.id,
          accountId: a.id,
        });
    const added = new Set(outcome.added.map(t => t.id));
    const fresh = outcome.added.map(current).filter((t): t is Thread => !!t && t.status === 'new');
    const replies = inbox.filter(t => !added.has(t.id));
    // New Spam gets a summary too, so it can be judged without opening it; its triage fields stay untouched.
    const spam = outcome.added.map(current).filter((t): t is Thread => !!t && t.status === 'spam');
    await syncWorkflow(a, provider, manual, errors, generation);
    errors.push(
      ...(await classifyIncoming(
        [...fresh, ...replies, ...spam],
        a,
        new Set(replies.map(t => t.id)),
        new Set(spam.map(t => t.id)),
      )),
    );
  }
  /** Share Done, Later, todos and reminders with this account's other devices, then apply theirs. */
  async function syncWorkflow(
    a: Account,
    provider: MailProvider,
    manual: boolean,
    errors: string[],
    generation: number,
  ) {
    if (!workflow?.enabled || !provider.readAppData) return;
    if (
      !manual &&
      !workflow.hasEdits(a.id) &&
      now().getTime() - (workflowAt.get(a.id) ?? 0) < WORKFLOW_INTERVAL_MS
    )
      return;
    const stage = staged.stage();
    try {
      // What the round remembers (entries seen, edits published) is saved with the patches it implies.
      const patches = await stage.run(() => workflow!.round(a, provider, () => state.threads));
      if (!live(a.id, generation)) {
        stage.discard();
        return;
      }
      change(
        s => {
          for (const { threadId, patch } of patches) {
            const index = s.threads.findIndex(t => t.id === threadId);
            if (index >= 0) s.threads[index] = { ...s.threads[index], ...patch };
          }
        },
        undefined,
        { stage },
      );
      workflowAt.set(a.id, now().getTime());
    } catch (error) {
      stage.discard();
      // An edit landed during the round; the next sync redoes it with that edit included.
      if (error instanceof StaleSync) return;
      errors.push(
        `Done, Later and todos could not sync with your other devices for ${a.email}. ${error instanceof Error ? error.message : ''}`.trim(),
      );
    }
  }
  async function sync(accountId?: string, manual = true): Promise<AppState> {
    if (syncing) {
      await syncing.catch(() => {});
      return clone(state);
    }
    // Local changes go out before new state comes in, so the host already agrees with what the user did.
    if (queue.length) await flush(manual).catch(() => {});
    const accounts = (accountId ? [account(accountId)] : clone(state.accounts)).filter(
      a => hostOf(a) && a.connected && gate.ready(a.id, manual),
    );
    if (!manual && !accounts.length) return clone(state);
    const job = (async () => {
      // Background syncs stay quiet: no spinner, and errors surface on the account rather than as toasts.
      if (manual)
        change(s => {
          s.sync = { ...s.sync, busy: true, error: undefined };
        });
      const errors: string[] = [];
      try {
        for (const a of accounts) {
          try {
            await gate.run(a.id, () => syncAccount(a, manual, errors));
          } catch (error) {
            const reason =
              error instanceof Error && error.message
                ? error.message.trim().replace(/\.?$/, '.')
                : '';
            console.error(`sync ${a.email} failed:`, error);
            const message = `Could not sync ${a.email}. ${reason ? reason + ' ' : ''}Reconnect the account or try again.`;
            errors.push(message);
            if (state.accounts.some(x => x.id === a.id))
              change(s => {
                s.accounts.find(x => x.id === a.id)!.error = message;
              });
          }
        }
      } finally {
        if (!closed)
          change(s => {
            s.sync = {
              busy: false,
              lastSync: now().toISOString(),
              ...(errors.length ? { error: errors.join(' ') } : {}),
            };
          });
      }
      if (!closed) checkReminders();
    })();
    syncing = job;
    try {
      await job;
    } finally {
      syncing = undefined;
    }
    return clone(state);
  }
  async function invoke(method: string, raw: unknown = {}): Promise<any> {
    if (closed) throw new Error('The mailbox is closed.');
    const p = object(raw ?? {});
    switch (method) {
      case 'state.get': {
        checkReminders();
        // A window can start from the newest threads and read the rest in pages.
        const limit =
          p.threadLimit === undefined
            ? 0
            : Math.max(1, Math.min(100_000, Math.floor(Number(p.threadLimit)) || 1));
        if (!limit || state.threads.length <= limit) return clone(state);
        return {
          ...clone({ ...state, threads: [...state.threads].sort(threadOrder).slice(0, limit) }),
          threadCount: state.threads.length,
        };
      }
      case 'threads.page': {
        const before = object(p.before),
          date = text(before.date, 100),
          id = text(before.id, 1000),
          limit = Math.max(1, Math.min(5_000, Math.floor(Number(p.limit)) || 500));
        const older = [...state.threads]
          .sort(threadOrder)
          .filter(t => threadOrder(t, { date, id }) > 0);
        const threads = older.slice(0, limit),
          last = threads.at(-1);
        const page: ThreadPage = {
          epoch,
          rev,
          threads: clone(threads),
          ...(older.length > limit && last ? { next: { date: last.date, id: last.id } } : {}),
        };
        return page;
      }
      case 'symbols.render':
        return symbols(p.items, p.scale);
      case 'capabilities.get':
        return {
          groq: groq.available,
          google: !!providers.google?.available,
          microsoft: !!providers.microsoft?.available,
          desktop: !!options.desktop,
          version: options.appVersion ?? '',
          googleUnavailable: providers.google?.unavailableReason,
          microsoftUnavailable: providers.microsoft?.unavailableReason,
        };
      case 'settings.update':
        change(s => {
          s.settings = { ...s.settings, ...settingsPatch(p.patch) };
        });
        return clone(state);
      case 'account.select': {
        const id = text(p.id, 300);
        if (id !== 'all') account(id);
        change(s => {
          s.selectedAccountId = id;
        });
        return clone(state);
      }
      case 'account.connect': {
        const request = connectRequest(p),
          provider = providers[request.provider];
        if (!provider)
          throw new Error(
            brokenProviders.get(request.provider) ||
              'This account type is not available in this version of Aplos.',
          );
        if (!provider.available)
          throw new Error(provider.unavailableReason || 'This account type is not configured.');
        const a = await provider.connect(request);
        a.capabilities = provider.capabilities(a);
        bumpGeneration(a.id);
        change(s => {
          s.accounts = s.accounts.filter(old => old.id !== a.id);
          s.accounts.push(a);
          s.selectedAccountId = a.id;
          s.settings.onboardingDone = true;
        });
        return sync(a.id);
      }
      // The system resolver also sees internal names that public DNS-over-HTTPS cannot, so private targets are caught.
      case 'account.discover':
        return discoverAccount(safeEmail(p.email), {
          fetch: options.fetch,
          ...(options.lookup ? { lookup: options.lookup } : {}),
        });
      case 'domain.check': {
        const domain = text(p.domain, 320).trim();
        const provider =
          p.provider === undefined
            ? undefined
            : enumValue(p.provider, [...PROVIDERS, 'unknown'] as const);
        return checkDomain(domain, { fetch: options.fetch, provider });
      }
      case 'account.disconnect': {
        const a = account(text(p.id, 300));
        if (state.drafts.some(d => d.accountId === a.id && sending.has(d.id)))
          throw new Error('Wait for the message to finish sending.');
        bumpGeneration(a.id);
        await hostOf(a)?.disconnect(a.id);
        store.setCursor(a.id, undefined);
        staged.memory.clear(a.id);
        gate.forget(a.id);
        extrasAt.delete(a.id);
        defaults.delete(a.id);
        for (const d of state.drafts.filter(d => d.accountId === a.id)) stopSend(d.id);
        change(
          s => {
            s.accounts = s.accounts.filter(x => x.id !== a.id);
            s.threads = s.threads.filter(t => t.accountId !== a.id);
            s.drafts = s.drafts.filter(d => d.accountId !== a.id);
            s.events = s.events.filter(e => e.accountId !== a.id);
            if (s.selectedAccountId === a.id) s.selectedAccountId = 'all';
            delete s.settings.accountNotifications[a.id];
          },
          { remove: queue.filter(op => op.accountId === a.id).map(op => op.id) },
        );
        undo.length = 0;
        return clone(state);
      }
      case 'sync':
        return sync(p.accountId ? text(p.accountId, 300) : undefined, p.auto !== true);
      case 'demo.reset': {
        if (sending.size) throw new Error('Wait for sending to finish before resetting.');
        for (const d of state.drafts) stopSend(d.id);
        // Reset synthetic data without deleting real connected accounts or their mail.
        const fresh = createDemo(now());
        for (const a of state.accounts.filter(a => a.provider !== 'demo')) fresh.accounts.push(a);
        const live = new Set(fresh.accounts.filter(a => a.provider !== 'demo').map(a => a.id));
        fresh.threads.push(...state.threads.filter(t => live.has(t.accountId)));
        fresh.drafts.push(...state.drafts.filter(d => live.has(d.accountId)));
        fresh.events.push(...state.events.filter(e => live.has(e.accountId)));
        fresh.settings = clone(state.settings);
        commit(fresh);
        undo.length = 0;
        for (const d of state.drafts) scheduleSend(d);
        return clone(state);
      }
      case 'thread.update':
        return updateThreads(
          p.ids,
          threadPatch(p.patch),
          p.recordUndo !== false,
          p.compact === true,
        );
      case 'home.hide':
        return updateThreads(p.ids, { hiddenFromHome: true }, true, p.compact === true);
      case 'thread.undo': {
        const previous = undo.at(-1);
        if (!previous) throw new Error('There is nothing to undo.');
        const restores = previous.map(old => {
          const current = thread(old.id),
            patch: Partial<Thread> = {};
          account(current.accountId);
          for (const key of [
            'status',
            'unread',
            'importance',
            'bookmarked',
            'replyStatus',
            'dueDate',
            'reminderAt',
            'reminderFired',
            'todo',
            'hiddenFromHome',
            'labels',
          ] as const)
            (patch as any)[key] = old[key];
          return { current, patch };
        });
        const ops = restores
          .map(r => queued(r.current, r.patch))
          .filter((op): op is QueuedOp => !!op);
        const stage = noteWorkflow(restores.map(r => ({ ...r.current, ...r.patch })));
        const replacements = new Map(
          restores.map(r => [r.current.id, { ...r.current, ...r.patch }]),
        );
        commit(
          { ...state, threads: state.threads.map(t => replacements.get(t.id) ?? t) },
          { put: ops },
          { stage },
        );
        undo.pop();
        if (ops.length) kick();
        return p.compact === true ? { epoch, rev } : clone(state);
      }
      case 'search': {
        const query = text(p.query, 2000).trim(),
          accountId = p.accountId && p.accountId !== 'all' ? text(p.accountId, 300) : undefined;
        if (accountId) account(accountId);
        return clone(await searchMail(query, accountId));
      }
      case 'draft.save': {
        const d = object(p.draft),
          id = d.id ? text(d.id, 300) : randomUUID(),
          existing = state.drafts.find(item => item.id === id),
          a = account(text(d.accountId, 300));
        if (existing?.pendingSendAt) throw new Error('Undo send before editing this draft.');
        if (existing && Number(d.revision) < existing.revision)
          throw new Error('This draft changed in another window. Reopen it before editing.');
        const next: Draft = {
          id,
          accountId: d.accountId,
          to: text(d.to || '', 5000),
          cc: text(d.cc || '', 5000),
          bcc: text(d.bcc || '', 5000),
          subject: text(d.subject || '', 2000),
          html: text(d.html || '', 1_000_000),
          attachments: attachments(d.attachments || [], randomUUID),
          mode: enumValue(d.mode || 'new', ['new', 'reply', 'reply-all', 'forward']),
          signature: !!d.signature,
          updatedAt: now().toISOString(),
          revision: (existing?.revision || 0) + 1,
        };
        // An unconfirmed earlier attempt stays tied to its Message-ID across edits, so a retry checks Sent first.
        if (existing?.sendAttemptAt && existing.messageId) {
          next.messageId = existing.messageId;
          next.sendAttemptAt = existing.sendAttemptAt;
          if (existing.sendError) next.sendError = existing.sendError;
        }
        if (d.fromEmail !== undefined && d.fromEmail !== '')
          next.fromEmail = safeEmail(d.fromEmail);
        if (d.signatureSource !== undefined)
          next.signatureSource = enumValue(
            d.signatureSource === 'gmail' ? 'account' : d.signatureSource,
            ['custom', 'account'],
          );
        senderIdentity(next, a);
        if (d.threadId) {
          const t = thread(text(d.threadId, 300));
          if (t.accountId !== d.accountId) throw new Error('Replies must use the message account.');
          next.threadId = t.id;
        }
        change(s => {
          s.drafts = s.drafts.filter(item => item.id !== id);
          s.drafts.push(next);
        });
        return clone(next);
      }
      case 'draft.delete': {
        const d = draft(text(p.id, 300));
        if (sending.has(d.id)) throw new Error('This draft is sending.');
        stopSend(d.id);
        change(s => {
          s.drafts = s.drafts.filter(item => item.id !== d.id);
        });
        return clone(state);
      }
      case 'draft.send': {
        const d = draft(text(p.id, 300));
        if (d.pendingSendAt) return clone(state);
        if (!addresses(d.to).length) throw new Error('Add at least one recipient.');
        validRecipients(d.to);
        validRecipients(d.cc);
        validRecipients(d.bcc);
        if (!stripHTML(d.html) && !d.attachments.length)
          throw new Error('Write a message or add an attachment before sending.');
        const a = account(d.accountId);
        if (!a.connected) throw new Error('Reconnect this account before sending.');
        senderIdentity(d, a);
        const pendingSendAt = new Date(
          now().getTime() + state.settings.undoSeconds * 1000,
        ).toISOString();
        // A stable Message-ID lets an interrupted send be found in Sent mail instead of being sent twice.
        const messageId =
          d.messageId || `<${randomUUID()}@${senderIdentity(d, a).email.split('@')[1]}>`;
        const resend = p.resend === true && !!d.sendAttemptAt;
        change(s => {
          const current = s.drafts.find(item => item.id === d.id)!;
          current.pendingSendAt = pendingSendAt;
          current.messageId = messageId;
          delete current.sendError;
          if (resend) current.resendConfirmed = true;
        });
        scheduleSend({ ...d, pendingSendAt });
        return clone(state);
      }
      case 'draft.undoSend': {
        const d = draft(text(p.id, 300));
        if (sending.has(d.id)) throw new Error('Sending has started; the undo window has ended.');
        stopSend(d.id);
        change(s => {
          const current = s.drafts.find(item => item.id === d.id)!;
          delete current.pendingSendAt;
          delete current.sendError;
          delete current.resendConfirmed;
        });
        return clone(state);
      }
      case 'workflow.status':
        return {
          enabled: !!workflow?.enabled,
          available: !!workflow && options.secure,
          ...(workflowError ? { error: workflowError } : {}),
        };
      case 'workflow.enable': {
        if (!workflow) throw new Error(workflowError || 'Device sync is unavailable.');
        const code = await workflow.enable(p.code === undefined ? undefined : text(p.code, 200));
        workflowAt.clear();
        void sync(undefined, true).catch(() => {});
        return { code };
      }
      case 'workflow.code': {
        const code = workflow?.code();
        if (!code) throw new Error('Device sync is off.');
        return { code };
      }
      case 'workflow.disable':
        await workflow?.disable(state.accounts.map(a => a.id));
        workflowAt.clear();
        return { enabled: false };
      case 'ai.cancel': {
        for (const [id, controller] of requests)
          if (!p.requestId || p.requestId === id) controller.abort();
        return { cancelled: true };
      }
      case 'ai.summarizing':
        return [...summarizing.keys()];
      case 'ai.summarize': {
        const id = text(p.threadId, 300);
        // Background requests (on open, from the list) leave an email alone once it has a summary.
        if (p.onlyIfMissing === true && hasRealSummary(thread(id))) return thread(id);
        // Sync or another window may already be summarizing these messages; that run is shared.
        const { input: t, result } = await ai(p, signal =>
          tracked(id, input => writer('summary').summarize(input, signal)),
        );
        const patch = threadPatch(result);
        if (typeof result.summary === 'string') patch.summary = result.summary.slice(0, 10_000);
        patch.action = result.action;
        // The model only fills a to-do or due date that is empty, and judges importance and reply state only the first
        // time; after that they may be the owner's. Anything edited while the model was working wins, as in sync.
        const keys = [
          'summary',
          'action',
          ...(hasRealSummary(t) ? [] : (['importance', 'replyStatus'] as const)),
          ...(t.todo ? [] : (['todo'] as const)),
          ...(t.dueDate ? [] : (['dueDate'] as const)),
        ] as const;
        change(s => {
          const current = s.threads.find(item => item.id === t.id);
          if (!current) throw new Error('The message was removed.');
          for (const key of keys)
            if (key in patch && JSON.stringify(current[key]) === JSON.stringify(t[key])) {
              (current as any)[key] = patch[key];
              if (key === 'summary') current.aiSummary = true;
            }
        });
        return thread(t.id);
      }
      case 'ai.polish':
        return ai(p, signal =>
          writer('draft').polish(
            text(p.html, 1_000_000),
            p.instruction ? text(p.instruction, 10_000) : undefined,
            signal,
          ),
        );
      case 'ai.draft':
        return ai(p, signal =>
          writer('draft').draft(
            text(p.instruction, 20_000),
            p.threadId ? thread(text(p.threadId, 300)) : undefined,
            p.draft,
            signal,
          ),
        );
      case 'ai.ask': {
        const message = text(p.message, 20_000).trim();
        if (!message) throw new Error('Write a question first.');
        let conversation: Conversation | undefined = p.conversationId
          ? state.conversations.find(c => c.id === p.conversationId)
          : undefined;
        if (p.conversationId && !conversation) throw new Error('Conversation not found.');
        conversation = clone(
          conversation || {
            id: randomUUID(),
            title: message.slice(0, 70),
            messages: [],
            updatedAt: now().toISOString(),
          },
        );
        const earlier = [...conversation.messages];
        conversation.messages.push({ role: 'user', content: message });
        const selected = p.accountId && p.accountId !== 'all' ? text(p.accountId, 300) : undefined;
        if (selected) account(selected);
        let draft: Record<string, string> | undefined;
        if (p.draft !== undefined) {
          const rawDraft = object(p.draft);
          draft = {};
          for (const key of ['to', 'cc', 'bcc', 'subject', 'html'] as const)
            if (key in rawDraft)
              draft[key] = text(
                rawDraft[key],
                key === 'html' ? 40_000 : key === 'subject' ? 2_000 : 5_000,
              );
          if (draft.html !== undefined) draft.text = stripHTML(draft.html).slice(0, 20_000);
          delete draft.html;
        }
        // What the user is looking at, so "summarize this" and "reply to this" need no tool call.
        const where = p.context === undefined ? {} : object(p.context);
        const view = where.view === undefined ? undefined : text(where.view, 40),
          openId = where.threadId ? text(where.threadId, 300) : undefined;
        const selectedIds = Array.isArray(where.selectedIds)
          ? where.selectedIds.slice(0, 50).map((id: unknown) => text(id, 300))
          : undefined;
        const requestId = p.requestId ? text(p.requestId, 200) : randomUUID();
        const timeZone = p.timeZone ? text(p.timeZone, 100) : undefined;
        const inScope = (accountId: string) => !selected || accountId === selected;
        const session = createAskSession({
          threads: () => state.threads.filter(t => inScope(t.accountId)),
          accounts: state.accounts.filter(a => inScope(a.id)),
          ownAddresses: new Set(
            state.accounts
              .flatMap(a => [a.email, ...(a.sendAs ?? []).map(s => s.email)])
              .map(e => e.toLowerCase()),
          ),
          search: (query, accountId) => searchMail(query, accountId ?? selected),
          events: () => state.events.filter(e => inScope(e.accountId)),
          clock: localNow(timeZone, now()),
          view,
          threadId: openId,
          selectedIds,
          draft,
          userText: conversation.messages
            .filter(m => m.role === 'user')
            .map(m => m.content)
            .join('\n'),
        });
        const ask = choice('ask'),
          transport = askTransport(ask.provider);
        const model = `${ask.provider}:${ask.model}`;
        const progress = session.stream((event: AskProgress) =>
          emit('ai.progress', { requestId, ...event }),
        );
        const result = await ai({ ...p, requestId }, signal =>
          runAgent({
            chat: transport.chat,
            model: ask.model,
            session: conversation.id,
            signal,
            tools: session.tools,
            onEvent: progress.onEvent,
            // Groq's free tier counts every token per minute, so its requests stay smaller.
            budget: ask.provider === 'groq' ? 48_000 : 100_000,
            messages: [
              { role: 'system', content: session.system() },
              ...session.history(earlier),
              { role: 'user', content: message },
            ],
          }),
        ).finally(() => progress.close());
        // Token use per answer, for live checks against Groq's per-minute limits; the panel ignores it.
        emit('ai.progress', { requestId, type: 'usage', ...result.usage });
        const answer = session.finish(result, model, message);
        conversation.messages.push(answer);
        conversation.updatedAt = now().toISOString();
        change(s => {
          s.conversations = s.conversations.filter(c => c.id !== conversation!.id);
          s.conversations.push(conversation!);
        });
        return clone(conversation);
      }
      case 'ai.test': {
        // One tiny request asking the model to call a tool, so a pass means Ask's tools will work too. No mail is sent.
        const picked = parseFeatureModel('ask', p.model);
        if (!picked) throw new Error('Choose an Ask model.');
        const transport = askTransport(picked.provider),
          started = now().getTime();
        const turn = await ai(p, signal =>
          transport.chat(
            {
              model: picked.model,
              maxTokens: 1024,
              toolChoice: 'auto',
              tools: [
                {
                  name: 'ping',
                  description: 'Confirms that the connection works.',
                  parameters: { type: 'object', properties: {} },
                },
              ],
              messages: [
                {
                  role: 'system',
                  content: 'You are checking a connection. Call the ping tool once, then stop.',
                },
                { role: 'user', content: 'Check the connection.' },
              ],
            },
            { signal },
          ),
        );
        return {
          ms: now().getTime() - started,
          tools: turn.toolCalls.some(call => call.name === 'ping'),
        };
      }
      case 'ai.keys': {
        // Where each provider's key comes from and its last four characters; never the key itself.
        const keys = options.keys;
        return {
          secure: !!keys?.secure,
          ...(keys?.error ? { error: keys.error } : {}),
          providers: Object.fromEntries(
            askProviders.map(info => [info.id, keys?.info(info.id) ?? {}]),
          ),
        };
      }
      case 'ai.key.set':
      case 'ai.key.delete': {
        const keys = options.keys,
          id = enumValue(
            p.provider,
            askProviders.map(info => info.id),
          );
        if (!keys?.secure)
          throw new Error(
            keys?.error ??
              'Keys can only be saved in the Aplos Mail desktop app. Here, set the key in the backend environment instead.',
          );
        if (method === 'ai.key.set') await keys.set(id, text(p.key, 2_000));
        else await keys.delete(id);
        return keys.info(id);
      }
      case 'ai.key.test': {
        // One cheap request with the provider's current key (usually its model list). No mail is sent.
        const id = enumValue(
            p.provider,
            askProviders.map(info => info.id),
          ),
          info = askProvider(id);
        const transport = id === 'groq' ? groq : chatProvider(id);
        if (!transport)
          throw new Error(
            id === 'custom'
              ? 'Add your server’s address first.'
              : `${info.label} isn’t available in this version of Aplos.`,
          );
        if (!transport.available) throw new Error(`Add your ${info.label} key first.`);
        if (!transport.check) throw new Error(`${info.label} can’t be checked from here.`);
        const started = now().getTime();
        await ai(p, signal => transport.check!(signal));
        return { ms: now().getTime() - started };
      }
      case 'ai.models': {
        // What Settings can offer: each provider, whether it is set up, its tool-capable models and any speech models.
        return Promise.all(
          askProviders.map(async info => {
            const transport = info.id === 'groq' ? undefined : chatProvider(info.id);
            let available = info.id === 'groq' ? groq.available : !!transport?.available;
            // A local app counts as ready only while it is actually running.
            const status = transport?.status
              ? await transport
                  .status()
                  .catch((): { running: boolean; version?: string } => ({ running: false }))
              : undefined;
            if (status) available = status.running;
            let models = [...info.models],
              voiceModels = voiceProviders[info.id] ? [...voiceProviders[info.id]!] : undefined;
            if (transport?.models && available !== false)
              try {
                const live = await transport.models();
                if (live.length || isAskServer(info.id)) models = live;
              } catch {
                /* The curated list still works offline. */
              }
            if (transport?.voiceModels && available)
              try {
                const live = await transport.voiceModels();
                if (live.length) voiceModels = live;
              } catch {
                /* As above. */
              }
            return {
              id: info.id,
              label: info.label,
              env: info.env,
              description: info.description,
              keyOptional: !!info.keyOptional,
              available,
              models,
              ...(voiceModels ? { voiceModels } : {}),
              ...(isAskServer(info.id)
                ? { address: serverUrl(info.id), defaultAddress: info.defaultAddress ?? '' }
                : {}),
              ...(status
                ? {
                    running: status.running,
                    ...(status.version ? { version: status.version } : {}),
                  }
                : {}),
            };
          }),
        );
      }
      case 'ai.transcribe': {
        const audio = text(p.audio, 35_000_000);
        if (
          !audio ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(audio) ||
          base64Bytes(audio) > 25 * 1024 * 1024
        )
          throw new Error('Audio must be a base64 recording smaller than 25 MB.');
        return ai(p, signal => transcribe(audio, text(p.mimeType, 200), signal));
      }
      case 'conversation.delete':
        change(s => {
          s.conversations = s.conversations.filter(c => c.id !== p.id);
        });
        return clone(state);
      case 'calendar.list': {
        // Every account at once (the Calendar page) skips a host that cannot answer; one account reports its error.
        const every = !p.accountId || p.accountId === 'all',
          list: CalendarInfo[] = [];
        for (const a of state.accounts.filter(a => every || a.id === p.accountId)) {
          if (a.provider === 'demo') {
            const own = demoCalendars.filter(c => c.accountId === a.id);
            list.push(
              ...(own.length
                ? own
                : [{ id: `demo-${a.id}`, name: 'Calendar', accountId: a.id, primary: true }]
              ).map(c => ({ ...c })),
            );
          } else {
            const provider = hostOf(a);
            if (a.calendarConnected && provider?.listCalendars)
              try {
                list.push(...(await provider.listCalendars(a)));
              } catch (error) {
                if (!every) throw error;
              }
          }
        }
        return list;
      }
      case 'calendar.extract': {
        const t = thread(text(p.threadId, 300)),
          events = await ai(p, signal =>
            writer('plan').extractEvents(t, signal, {
              timeZone: p.timeZone ? text(p.timeZone, 100) : undefined,
            }),
          );
        const a = account(t.accountId),
          candidates = events.map(e => ({
            ...e,
            accountId: t.accountId,
            threadId: t.id,
            calendarId:
              e.calendarId ||
              (a.calendarConnected && hostOf(a)?.saveEvent ? 'primary' : `demo-${t.accountId}`),
          }));
        if (state.settings.autoCalendar)
          for (const e of candidates)
            await invoke('calendar.save', { event: { ...e, id: e.id || randomUUID() } });
        return candidates;
      }
      case 'calendar.save': {
        const e = object(p.event),
          a = account(text(e.accountId, 300)),
          start = e.allDay ? dateOnly(e.start) : date(e.start),
          end = e.allDay ? dateOnly(e.end) : date(e.end);
        if (!start || !end || Date.parse(end) <= Date.parse(start))
          throw new Error('An event must end after it starts.');
        const event: CalendarEvent = {
          id: e.id ? text(e.id, 300) : randomUUID(),
          accountId: a.id,
          calendarId: text(e.calendarId, 1000),
          title: text(e.title, 1000),
          start,
          end,
          allDay: !!e.allDay,
          location: text(e.location || '', 2000),
          description: text(e.description || '', 20_000),
          guests: Array.isArray(e.guests) ? e.guests.map(safeEmail) : [],
        };
        if (!event.title.trim()) throw new Error('Give the event a title.');
        if (e.threadId) {
          thread(text(e.threadId, 300));
          event.threadId = e.threadId;
        }
        const existing = state.events.find(item => item.id === event.id);
        if (existing && existing.accountId !== a.id)
          throw new Error('An event cannot move between accounts.');
        if (existing?.remoteId) event.remoteId = existing.remoteId;
        if (existing?.url) event.url = existing.url;
        if (existing?.etag) event.etag = existing.etag;
        if (existing?.scheduling) event.scheduling = true;
        const provider = hostOf(a),
          remoteCalendar =
            a.calendarConnected && provider?.saveEvent && !event.calendarId.startsWith('demo-');
        // Synced events carry the real calendar ID; the alias must resolve to it or duplicates go unnoticed.
        if (remoteCalendar && event.calendarId === 'primary')
          event.calendarId = (await defaultCalendar(a, provider!)) ?? 'primary';
        const duplicate = state.events.find(
          item =>
            item.id !== event.id &&
            item.accountId === a.id &&
            item.calendarId === event.calendarId &&
            item.title.toLowerCase() === event.title.toLowerCase() &&
            item.start === start,
        );
        if (duplicate) return clone(duplicate);
        const saved = remoteCalendar ? await provider!.saveEvent!(a, event) : event;
        change(s => {
          s.events = s.events.filter(item => item.id !== saved.id);
          s.events.push(saved);
        });
        return clone(saved);
      }
      case 'calendar.delete': {
        const event = state.events.find(e => e.id === p.id);
        if (!event) throw new Error('Event not found.');
        const a = account(event.accountId),
          provider = hostOf(a);
        if (event.remoteId && provider?.deleteEvent) await provider.deleteEvent(a, event);
        change(s => {
          s.events = s.events.filter(e => e.id !== event.id);
        });
        return clone(state);
      }
      case 'attachment.get': {
        const t = thread(text(p.threadId, 300));
        const attachment = t.messages
          .flatMap(m => m.attachments)
          .find(a => a.id === p.attachmentId);
        if (!attachment) throw new Error('Attachment not found.');
        const a = account(t.accountId);
        if (attachment.data) return clone(attachment);
        const provider = hostOf(a);
        if (!provider) throw new Error('This attachment is unavailable.');
        return provider.attachment(a, t, attachment);
      }
      case 'sender.block': {
        const email = safeEmail(p.email);
        const ids = state.threads
          .filter(t => t.messages.some(m => m.from.toLowerCase() === email))
          .map(t => t.id);
        if (ids.length) await updateThreads(ids, { status: 'spam' });
        change(s => {
          if (!s.blockedSenders.includes(email)) s.blockedSenders.push(email);
        });
        return clone(state);
      }
      case 'sender.unblock': {
        const email = safeEmail(p.email);
        change(s => {
          s.blockedSenders = s.blockedSenders.filter(item => item !== email);
        });
        return clone(state);
      }
      case 'thread.unsubscribe': {
        const t = thread(text(p.id, 300));
        // Only return an ordinary HTTPS link already present in a message. Never POST or send mail.
        for (const m of t.messages)
          for (const match of (m.html || '').matchAll(
            /<a\b[^>]*href=["'](https:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
          )) {
            if (/unsubscribe|manage preferences/i.test(match[2])) {
              try {
                const url = new URL(match[1].replace(/&amp;/g, '&'));
                if (url.protocol === 'https:' && !url.username && !url.password)
                  return {
                    url: url.href,
                    message: 'Review the sender’s unsubscribe page before confirming.',
                  };
              } catch {
                /* Skip malformed links. */
              }
            }
          }
        return { message: 'No unsubscribe link is available. You can block this sender instead.' };
      }
      case 'data.export':
        return JSON.stringify(state, null, 2);
      default:
        throw new Error(`Unknown action: ${method}`);
    }
  }
  store.write(state);
  checkReminders();
  for (const d of state.drafts) {
    if (!d.sendAttemptAt) {
      scheduleSend(d);
      continue;
    }
    const job = recoverSend(d.id).catch(() => {});
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  }
  if (queue.length) kick();
  const reminderTimer = setInterval(() => {
    try {
      if (!closed) checkReminders();
    } catch {
      emit('error', { message: 'Reminders could not be saved. Check folder permissions.' });
    }
  }, 30_000);
  (reminderTimer as unknown as { unref?: () => void }).unref?.();
  const autoSyncMs = options.autoSyncMs ?? 60_000;
  const syncTimer =
    autoSyncMs > 0
      ? setInterval(() => {
          if (!closed) void sync(undefined, false).catch(() => {});
        }, autoSyncMs)
      : undefined;
  (syncTimer as unknown as { unref?: () => void } | undefined)?.unref?.();
  return {
    invoke,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(reminderTimer);
      if (syncTimer) clearInterval(syncTimer);
      await syncing?.catch(() => {});
      await flushing?.catch(() => {});
      for (const id of timers.keys()) stopSend(id);
      for (const controller of requests.values()) controller.abort();
      await Promise.allSettled(jobs);
      await Promise.allSettled(Object.values(providers).map(async provider => provider?.close()));
      listeners.clear();
      store.close();
    },
  };
}
