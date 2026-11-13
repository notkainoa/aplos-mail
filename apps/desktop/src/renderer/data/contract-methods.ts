/**
 * The mapping from each `api` method to the contract method it calls, and what the hooks read from the contract.
 * `index.ts` re-exports everything here.
 */

import type { DesktopMethodName, MethodName } from './contract-shapes';
import type { DataApi } from './data-api';

/** Dotted name of every `api` method, for example `thread.act`. */
export type ApiMethodName = {
  [G in keyof DataApi]: `${G & string}.${keyof DataApi[G] & string}`;
}[keyof DataApi];

/** The contract method an `api` method calls: `thread.act` → `Thread/act`. Never when the contract has no such method, so a renamed or removed method fails the typecheck. */
export type ContractMethodOf<N extends ApiMethodName> = N extends `${infer G}.${infer V}`
  ? `${Capitalize<G>}/${V}` extends MethodName
    ? `${Capitalize<G>}/${V}`
    : never
  : never;

/** How a method reaches the engine: a plain call, a call wrapped by the optimistic overlay, a call that returns an id and streams frames, or a desktop method served by main. */
export type ContractCallKind = 'call' | 'overlay' | 'stream' | 'native';

/** One row of the mapping table: `api` method → contract method. */
export interface ContractMethodRef<N extends ApiMethodName = ApiMethodName> {
  /** The contract method, `Type/verb`; checked against the registry at compile time. */
  readonly method: ContractMethodOf<N>;
  /** How it is called; `native` exactly when the contract's host is main (`DesktopMethodName`). */
  readonly kind: ContractMethodOf<N> extends DesktopMethodName
    ? 'native'
    : Exclude<ContractCallKind, 'native'>;
  /** The GAPS.md rows (`packages/contract/GAPS.md`) that settled what this surface asked of the method; empty when it asked nothing. */
  readonly gaps: readonly string[];
  /** What the data layer adds or relies on. */
  readonly notes: string;
}

/** The mapping from `api` method to contract method, checked complete and correct at compile time. */
export const CONTRACT_METHODS = {
  'thread.act': {
    method: 'Thread/act',
    kind: 'overlay',
    gaps: ['F9-1', 'F9-2', 'F9-3'],
    notes:
      'overlay applied before return; opId minted; ids or a thread-row selector {spec, section?, atState}; joins the undo stack; also the Retry of an engine-rejected write (a fresh call under a new opId)',
  },
  'thread.why': { method: 'Thread/why', kind: 'call', gaps: ['F9-4'], notes: '' },
  'thread.open': {
    method: 'Thread/open',
    kind: 'call',
    gaps: [],
    notes: 'once per reader open; a partial row completes as a row change',
  },
  'operation.undo': {
    method: 'Operation/undo',
    kind: 'overlay',
    gaps: ['F9-7'],
    notes: 'undoOpId minted; the receipt is the inverse operation',
  },
  'operation.retry': {
    method: 'Operation/retry',
    kind: 'call',
    gaps: [],
    notes:
      'provider-side failures after a receipt only (Operation.state failed): same opId, Receipt, no overlay; OperationView.retry calls it when remote is failed',
  },
  'submission.set': {
    method: 'Submission/set',
    kind: 'call',
    gaps: ['F9-8', 'F9-9'],
    notes: 'opId minted; one SubmissionAction per intent; Submission.queuedAt drives the drain bar',
  },
  'draft.set': {
    method: 'Draft/set',
    kind: 'call',
    gaps: ['F9-10', 'F9-40'],
    notes: 'opId minted; compare-and-set on baseRevision',
  },
  'draft.destroy': { method: 'Draft/destroy', kind: 'call', gaps: [], notes: 'opId minted' },
  'draft.resolve': {
    method: 'Draft/resolve',
    kind: 'call',
    gaps: ['F9-11'],
    notes: 'opId minted; the Draft/changed frame sets Draft.conflict',
  },
  'messageBody.get': { method: 'MessageBody/get', kind: 'call', gaps: [], notes: '' },
  'messageBody.prefetch': {
    method: 'MessageBody/prefetch',
    kind: 'call',
    gaps: ['F9-12'],
    notes: 'usePrefetchIntent applies the delays and cancels with {cancel: true}',
  },
  'mail.frame': { method: 'Mail/frame', kind: 'call', gaps: ['F9-13'], notes: '' },
  'mail.release': { method: 'Mail/release', kind: 'call', gaps: [], notes: '' },
  'mail.toggleQuotes': { method: 'Mail/toggleQuotes', kind: 'call', gaps: ['F9-13'], notes: '' },
  'mail.allowImages': {
    method: 'Mail/allowImages',
    kind: 'call',
    gaps: ['F9-14'],
    notes: 'opId minted',
  },
  'attachment.get': { method: 'Attachment/get', kind: 'call', gaps: [], notes: 'then blob.get' },
  'blob.put': {
    method: 'Blob/put',
    kind: 'call',
    gaps: ['F9-15', 'F9-22'],
    notes: 'transferable Uint8Array, never base64',
  },
  'blob.get': { method: 'Blob/get', kind: 'call', gaps: [], notes: '' },
  'blob.release': {
    method: 'Blob/release',
    kind: 'call',
    gaps: [],
    notes: 'the window frees its own export blob once its file is saved',
  },
  'sync.request': { method: 'Sync/request', kind: 'call', gaps: ['F9-16'], notes: '' },
  'account.connect': {
    method: 'Account/connect',
    kind: 'stream',
    gaps: ['F9-17'],
    notes: 'connectId, then connect frames',
  },
  'account.reconnect': {
    method: 'Account/reconnect',
    kind: 'stream',
    gaps: ['F9-17'],
    notes: 'connectId, then connect frames',
  },
  'account.grantPermissions': {
    method: 'Account/grantPermissions',
    kind: 'stream',
    gaps: [],
    notes: "the reconnect sheet's 'grant' mode; connectId, then connect frames",
  },
  'account.cancelConnect': {
    method: 'Account/cancelConnect',
    kind: 'call',
    gaps: ['F9-17'],
    notes: '',
  },
  'account.set': { method: 'Account/set', kind: 'call', gaps: ['F9-18'], notes: 'opId minted' },
  'setup.begin': { method: 'Setup/begin', kind: 'call', gaps: [], notes: '' },
  'setup.end': { method: 'Setup/end', kind: 'call', gaps: [], notes: 'idempotent' },
  'setup.retry': { method: 'Setup/retry', kind: 'call', gaps: ['F9-19'], notes: '' },
  'demo.load': { method: 'Demo/load', kind: 'call', gaps: [], notes: '' },
  'demo.reset': { method: 'Demo/reset', kind: 'call', gaps: [], notes: '' },
  'demo.remove': { method: 'Demo/remove', kind: 'call', gaps: [], notes: '' },
  'settings.get': { method: 'Settings/get', kind: 'call', gaps: ['F9-41'], notes: '' },
  'settings.set': {
    method: 'Settings/set',
    kind: 'call',
    gaps: ['F9-41', 'F9-42'],
    notes: 'opId minted; object-valued fields replaced whole',
  },
  'ask.run': {
    method: 'Ask/run',
    kind: 'stream',
    gaps: ['F9-20'],
    notes: 'runId, then progress frames; the turn lands in the Conversation',
  },
  'ask.cancel': { method: 'Ask/cancel', kind: 'call', gaps: [], notes: '' },
  'search.remote': {
    method: 'Search/remote',
    kind: 'stream',
    gaps: [],
    notes:
      "opId minted; runId, then progress frames with source 'search'; results join the open search window with the same query",
  },
  'ai.request': {
    method: 'Ai/request',
    kind: 'call',
    gaps: ['F9-21'],
    notes: 'opId minted; kind summary re-summarizes',
  },
  'ai.draft': { method: 'Ai/draft', kind: 'call', gaps: ['F9-21'], notes: 'requestId minted' },
  'ai.polish': {
    method: 'Ai/polish',
    kind: 'call',
    gaps: ['F9-21'],
    notes: 'requestId minted; html plus a change count (change ranges rejected)',
  },
  'ai.transcribe': {
    method: 'Ai/transcribe',
    kind: 'call',
    gaps: ['F9-22'],
    notes: 'requestId minted; audio from blob.put',
  },
  'ai.followup': { method: 'Ai/followup', kind: 'call', gaps: ['F9-5'], notes: '' },
  'ai.dismissFollowup': {
    method: 'Ai/dismissFollowup',
    kind: 'call',
    gaps: [],
    notes: 'opId minted',
  },
  'ai.cancel': {
    method: 'Ai/cancel',
    kind: 'call',
    gaps: [],
    notes: 'the requestId of ai.draft, ai.polish or ai.transcribe; absent cancels all',
  },
  'unsubscribe.run': {
    method: 'Unsubscribe/run',
    kind: 'call',
    gaps: ['F9-6'],
    notes: 'opId minted',
  },
  'consent.get': { method: 'Consent/get', kind: 'call', gaps: ['F9-23', 'F9-43'], notes: '' },
  'consent.grant': { method: 'Consent/grant', kind: 'call', gaps: ['F9-23'], notes: '' },
  'consent.revoke': { method: 'Consent/revoke', kind: 'call', gaps: ['F9-23'], notes: '' },
  'engine.restart': { method: 'Engine/restart', kind: 'native', gaps: ['F9-24'], notes: '' },
  'diagnostics.preview': {
    method: 'Diagnostics/preview',
    kind: 'call',
    gaps: ['F9-26'],
    notes: 'the renderer formats the bundle',
  },
  'diagnostics.copy': {
    method: 'Diagnostics/copy',
    kind: 'native',
    gaps: ['F9-25'],
    notes: '',
  },
  'diagnostics.export': {
    method: 'Diagnostics/export',
    kind: 'call',
    gaps: [],
    notes: 'a file blob; then file.save',
  },
  'diagnostics.verbose': {
    method: 'Diagnostics/verbose',
    kind: 'call',
    gaps: [],
    notes: 'a plain call; the answer carries the time it switches itself off',
  },
  'contact.suggest': {
    method: 'Contact/suggest',
    kind: 'call',
    gaps: [],
    notes: 'a query over local data; no provider call',
  },
  'data.export': {
    method: 'Data/export',
    kind: 'call',
    gaps: [],
    notes: 'UI-only method; a file blob, then file.save; no credentials',
  },
  'workflow.status': {
    method: 'Workflow/status',
    kind: 'call',
    gaps: [],
    notes: 'device sync is not available yet',
  },
  'workflow.enable': {
    method: 'Workflow/enable',
    kind: 'call',
    gaps: [],
    notes: 'a secret method; answers unavailable until device sync exists',
  },
  'workflow.code': {
    method: 'Workflow/code',
    kind: 'call',
    gaps: [],
    notes: 'a secret method; answers unavailable until device sync exists',
  },
  'workflow.disable': { method: 'Workflow/disable', kind: 'call', gaps: [], notes: '' },
  'file.save': {
    method: 'File/save',
    kind: 'native',
    gaps: [],
    notes: 'main shows the save dialog and writes the blob; the stand-in answers canceled',
  },
  'account.discover': {
    method: 'Account/discover',
    kind: 'call',
    gaps: [],
    notes: '',
  },
  'account.disconnect': {
    method: 'Account/disconnect',
    kind: 'call',
    gaps: [],
    notes:
      'opId minted; joins operations, not undoable (receipt.undoable false); a refusal rethrows the engine error and marks the operation failed',
  },
  'account.lease': {
    method: 'Account/lease',
    kind: 'call',
    gaps: [],
    notes: 'a plain call ({leases}, not a receipt); every account when accountId is absent',
  },
  'ai.providers': {
    method: 'Ai/providers',
    kind: 'call',
    gaps: [],
    notes: 'never the key',
  },
  'ai.models': {
    method: 'Ai/models',
    kind: 'call',
    gaps: [],
    notes: 'live says whether a local server was asked',
  },
  'ai.status': {
    method: 'Ai/status',
    kind: 'call',
    gaps: [],
    notes: '',
  },
  'ai.usage': {
    method: 'Ai/usage',
    kind: 'call',
    gaps: [],
    notes: '',
  },
  'ai.setKey': {
    method: 'Ai/setKey',
    kind: 'call',
    gaps: [],
    notes:
      'secret: a plain call so the layer keeps none of the key (no operation, no undo entry); never logged or echoed',
  },
  'ai.removeKey': {
    method: 'Ai/removeKey',
    kind: 'call',
    gaps: [],
    notes: 'a plain call like setKey; refused for a key from the backend environment',
  },
  'ai.testKey': {
    method: 'Ai/testKey',
    kind: 'call',
    gaps: [],
    notes: 'a plain call ({ok, ms?}, not a receipt); no mail is sent',
  },
  'ask.decide': {
    method: 'Ask/decide',
    kind: 'call',
    gaps: [],
    notes: 'opId minted; receipt joins operations and the undo stack unless undoable is false',
  },
  'ask.suggestions': {
    method: 'Ask/suggestions',
    kind: 'call',
    gaps: [],
    notes: '',
  },
  'conversation.destroy': {
    method: 'Conversation/destroy',
    kind: 'call',
    gaps: [],
    notes: 'opId minted; receipt joins operations and the undo stack',
  },
  'event.set': {
    method: 'Event/set',
    kind: 'call',
    gaps: [],
    notes:
      'opId minted; receipt joins operations and the undo stack; undoUntil is the hold before guests are told',
  },
  'event.hide': {
    method: 'Event/hide',
    kind: 'call',
    gaps: [],
    notes:
      'opId minted; receipt joins operations and the undo stack; Aplos-side only, never written to the provider',
  },
  'event.rsvp': {
    method: 'Event/rsvp',
    kind: 'call',
    gaps: [],
    notes: 'opId minted; receipt joins operations and the undo stack',
  },
  'calendar.get': {
    method: 'Calendar/get',
    kind: 'call',
    gaps: [],
    notes: '',
  },
  'calendar.set': {
    method: 'Calendar/set',
    kind: 'call',
    gaps: [],
    notes: 'opId minted; receipt joins operations and the undo stack',
  },
  'plan.confirm': {
    method: 'Plan/confirm',
    kind: 'call',
    gaps: [],
    notes: 'opId minted; receipt joins operations and the undo stack',
  },
  'plan.dismiss': {
    method: 'Plan/dismiss',
    kind: 'call',
    gaps: [],
    notes: 'opId minted; receipt joins operations and the undo stack',
  },
  'listener.get': {
    method: 'Listener/get',
    kind: 'call',
    gaps: [],
    notes: 'UI-only method',
  },
  'listener.set': {
    method: 'Listener/set',
    kind: 'call',
    gaps: [],
    notes: 'UI-only method; a plain call (its output is the ListenerState, not a receipt)',
  },
  'clients.list': {
    method: 'Clients/list',
    kind: 'call',
    gaps: [],
    notes: 'UI-only method',
  },
  'clients.grant': {
    method: 'Clients/grant',
    kind: 'call',
    gaps: [],
    notes:
      'UI-only method; a plain call ({client}, not a receipt); the token never crosses the contract',
  },
  'clients.revoke': {
    method: 'Clients/revoke',
    kind: 'call',
    gaps: [],
    notes: 'UI-only method; a plain call (Ok, not a receipt)',
  },
  'clients.audit': {
    method: 'Clients/audit',
    kind: 'call',
    gaps: [],
    notes: 'UI-only method',
  },
  'queue.list': {
    method: 'Queue/list',
    kind: 'call',
    gaps: [],
    notes: 'content-free',
  },
  'queue.retry': {
    method: 'Queue/retry',
    kind: 'call',
    gaps: [],
    notes: 'a plain call (Ok, not a receipt); the inspector re-lists',
  },
  'queue.discard': {
    method: 'Queue/discard',
    kind: 'call',
    gaps: [],
    notes: 'a plain call (Ok, not a receipt); the inspector re-lists',
  },
  'window.openOnboarding': {
    method: 'Window/openOnboarding',
    kind: 'native',
    gaps: [],
    notes: 'main opens the window; the stand-in answers ok and records nothing',
  },
  'window.finishOnboarding': {
    method: 'Window/finishOnboarding',
    kind: 'native',
    gaps: [],
    notes: 'main also ends the setup session itself on any close',
  },
  'window.closeReady': {
    method: 'Window/closeReady',
    kind: 'native',
    gaps: [],
    notes: "answers main's prepare-close once unsaved work is saved; main then closes the window",
  },
  'window.closeCancel': {
    method: 'Window/closeCancel',
    kind: 'native',
    gaps: [],
    notes: 'tells main the close failed, so it re-enables the window',
  },
  'system.login': {
    method: 'System/login',
    kind: 'native',
    gaps: [],
    notes: '',
  },
  'system.defaultMail': {
    method: 'System/defaultMail',
    kind: 'native',
    gaps: [],
    notes: '',
  },
  'system.microphone': {
    method: 'System/microphone',
    kind: 'native',
    gaps: [],
    notes: 'check: true reads without the macOS prompt',
  },
  'system.notifications': {
    method: 'System/notifications',
    kind: 'native',
    gaps: [],
    notes: '',
  },
  'system.openSettings': {
    method: 'System/openSettings',
    kind: 'native',
    gaps: [],
    notes: '',
  },
  'shell.open': {
    method: 'Shell/open',
    kind: 'native',
    gaps: [],
    notes: 'main opens it through its external() gate: http, https or mailto, no credentials',
  },
  'notification.test': {
    method: 'Notification/test',
    kind: 'native',
    gaps: [],
    notes: '',
  },
} as const satisfies { readonly [N in ApiMethodName]: ContractMethodRef<N> };

/** What the hooks read from the contract, with the GAPS.md rows that settled each ask. */
export const CONTRACT_HOOK_NEEDS = {
  useView:
    'View/watch {spec, holdIds?, anchor?, limit?} -> WindowBody {windowId, state, rowType, ids, position, total, changed?, sections, held?, error?}; View/move, View/unwatch; window and reset frames; T/get for unknown or changed ids (F9-27, F9-28, F9-29, F9-30, F9-44)',
  useHome:
    'home window sections do, fromLater, update, low (count and senders, no ids), follow; the lowSenders window total for "and N more" (F9-30, F9-39)',
  useRow:
    'Thread/get, Message/get, Draft/get, Submission/get, Event/get, Plan/get, Conversation/get, SenderGroup/get, Account/get {ids}, Operation/get {opIds} -> {list, notFound}; state frames per type',
  useRowState: 'as useRow; ids in notFound and destroyed rows report notFound',
  useOperation:
    'Receipt {opId, appliedState, undoUntil?, undoable?}; operation frames carry the Operation (F9-27, F9-32)',
  useHold:
    'View/hold {windowId, ids} (repeating it is the activity ping), View/release {windowId, ids?}; never a re-watch (F9-31)',
  usePrefetchIntent: 'MessageBody/prefetch {threadIds, cancel?} (F9-12)',
  useMessageBody: 'MessageBody/get',
  useSession: 'Session/get; state frames for type Session (F9-33)',
  useConnection:
    'host event parked {reasonCode, message, canRetry, at}; desktop event engine {state, reasonCode?, message?, canRetry?, at} from main when the engine cannot answer (F9-34)',
  useAccounts:
    'Account/get; Account.health {status, reasonCode?, reconnectBy?, lastSyncAt?}, demo, baselineDoneAt, pendingChanges, colorTag (F9-35)',
  useAccountsLoaded: 'as useAccounts; true once Account/get has answered',
  useStatus: 'as useAccounts; copy from health.reasonCode, never provider text (F9-35, F9-38)',
  useCounts:
    'Counts/get {all, accounts, folders}; CountsBlock.handledToday; state frames for type Counts; hiding from baselineDoneAt (F9-36)',
  useAgenda:
    'events window {kind: events, from, to, calendarIds?, includeDeclined?} (62 days at most) and Event/get (F9-37)',
  useSetupStatus: 'Setup/status; state frames for type Setup',
  useSettings: 'Settings/get; state frames for type Settings; Settings.ui (F9-41, UI-1 to UI-13)',
  useConsent: 'Consent/get; state frames for type Consent (F9-23, F9-43)',
  useFrames:
    'progress {runId, source, kind, step?, delta?, turnId?, citation?, proposal?, problem?} (F9-20), connect {connectId, mode, state, accountId?, reasonCode?} (F9-17) and the host clock event; a live run replays from its start (renderer-side, U8)',
  useNow: 'Session.now and the host clock event (E3); Date.now() otherwise',
  useUndoTop:
    'none beyond Operation/undo and Receipt.undoable; local entries never reach the engine (U7)',
} as const;
