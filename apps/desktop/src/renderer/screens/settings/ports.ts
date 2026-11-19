/**
 * What Settings needs from outside itself, as plain interfaces, so this lane compiles and runs before its neighbours
 * land. The container fills them from `renderer/data` (`api`, the hooks) and the shell; the preview and the tests
 * fill them with stand-ins.
 *
 * REQUESTS (also in the lane report):
 * - ui-onboard: `renderReconnect` is `<ReconnectFlow accountId mode onClose>` and `showWelcome` is
 *   `renderer/onboarding/showWelcome`; both are supplied by whoever mounts Settings.
 */
import type { ReactNode } from 'react';
import type { Account, Calendar, Consent, Session, Settings, SettingsPatch } from '../../data';
import type {
  AiModelInfo,
  AiUsageInfo,
  BundleInfo,
  ClientEntry,
  ListenerInfo,
  QueueEntry,
  ToolKind,
  ToolScope,
  WorkflowInfo,
} from './settings.model';
import type { AiProvider } from '../../data';

/** Everything Settings reads. Values the engine has not answered yet are undefined, and the screen says so quietly. */
export interface SettingsData {
  readonly settings: Settings;
  readonly accounts: readonly Account[];
  readonly session: Session;
  readonly consent: Consent | undefined;
  /** The one renderer clock, epoch ms (harness-frozen in tests). */
  readonly now: number;
  readonly providers?: readonly AiProvider[];
  /** Models by provider id, loaded as a provider is looked at. */
  readonly models?: Readonly<Record<string, readonly AiModelInfo[]>>;
  readonly usage?: AiUsageInfo;
  readonly listener?: ListenerInfo;
  readonly clients?: readonly ClientEntry[];
  /** Device sync, loaded with the General section. */
  readonly workflow?: WorkflowInfo;
  readonly queue?: readonly QueueEntry[];
  /** The diagnostics preview, once asked for. */
  readonly bundle?: BundleInfo;
  /** Verbose logging as the engine last said: `until` is when it switches itself off. Read when Help opens, and set when the owner flips the switch. */
  readonly verbose?: { readonly until?: number };
  /** `Calendar/get`'s list, loaded while the accounts or calendar section is open; undefined until it answers. */
  readonly calendars?: readonly Calendar[];
}

/** What a save dialog answered: the owner either picked a place or closed it. */
export interface SaveResult {
  readonly canceled: boolean;
}

/** The contract calls Settings makes, each by the contract method's own shape. */
export interface SettingsApiPort {
  settingsSet(patch: SettingsPatch): Promise<void>;
  accountSet(
    accountId: string,
    patch: { colorTag?: string; aiAllowed?: boolean; notifications?: boolean; name?: string },
  ): Promise<void>;
  /** `Account/disconnect`; `signInKept` when the account is gone but its stored sign-in is not yet. */
  accountDisconnect(accountId: string): Promise<{ signInKept: boolean }>;
  accountLease(accountId: string | undefined, pin: boolean): Promise<void>;
  demoLoad(): Promise<void>;
  demoReset(): Promise<void>;
  demoRemove(): Promise<void>;
  aiModels(provider: string): Promise<readonly AiModelInfo[]>;
  /** Write-only. Resolves with nothing: the key is never echoed back. */
  aiSetKey(provider: string, key: string): Promise<void>;
  aiRemoveKey(provider: string): Promise<void>;
  aiTestKey(provider: string): Promise<{ ok: boolean; ms?: number; reasonCode?: string }>;
  consentGrant(input: { version: number; provider: string; model: string }): Promise<void>;
  consentRevoke(): Promise<void>;
  listenerSet(enabled: boolean): Promise<void>;
  clientsRevoke(id: string): Promise<void>;
  /** `Clients/grant`: the new tool, with `tokenPath` (where its key file is). The key itself never crosses the contract. */
  clientsGrant(input: {
    name: string;
    kind: ToolKind;
    scopes: readonly ToolScope[];
  }): Promise<ClientEntry>;
  /** `Workflow/status`: whether device sync exists yet, and whether it is on. */
  workflowStatus(): Promise<WorkflowInfo>;
  diagnosticsPreview(): Promise<BundleInfo>;
  /** Copies the report to the clipboard. */
  diagnosticsCopy(): Promise<void>;
  /** `Diagnostics/export`, then main's save dialog (`File/save`); `canceled` when the owner closed the dialog. */
  diagnosticsSave(): Promise<SaveResult>;
  /** `Diagnostics/verbose {on}`: the answer carries when it switches itself off. */
  verboseSet(on: boolean): Promise<{ until?: number }>;
  /** `Diagnostics/verbose` with no `on`: a query that answers the current switch-off time and changes nothing. */
  verboseGet(): Promise<{ until?: number }>;
  /** `Data/export`, then main's save dialog (`File/save`). */
  dataExport(): Promise<SaveResult>;
  queueRetry(id: string): Promise<void>;
  queueDiscard(id: string): Promise<void>;
  /** Reads for the sections that need them; each is asked for only when its section is open. */
  aiProviders(): Promise<readonly AiProvider[]>;
  aiUsage(): Promise<AiUsageInfo>;
  listenerGet(): Promise<ListenerInfo>;
  clientsList(): Promise<readonly ClientEntry[]>;
  queueList(): Promise<readonly QueueEntry[]>;
  /** Re-reads the provider table after a key changed. */
  loadProviders?(): Promise<void>;
  /** `Calendar/get`'s list, asked for while the accounts or calendar section is open. */
  calendarsGet?(): Promise<readonly Calendar[]>;
}

/** Shell facilities Settings uses; all optional so a test needs none. */
export interface SettingsHost {
  /** A quiet toast ("Done is now L"). Settings never mounts a ToastStack. */
  toast?(message: string): void;
  /** Puts a local change on the shared undo stack (Z). */
  pushUndo?(entry: { label: string; undo(): void | Promise<void> }): void;
  /** The reconnect flow, mounted by ui-onboard (`ReconnectFlow`). 'enableEditing' is Settings → Calendar's ask for the events scope. */
  renderReconnect?(
    accountId: string,
    mode: 'reconnect' | 'grant' | 'enableEditing',
    onClose: () => void,
  ): ReactNode;
  /** "Add an account" inline, ui-onboard's account component. */
  renderAddAccount?(onClose: () => void): ReactNode;
  /** Opens the onboarding window beside the mail window, changing nothing (`showWelcome`). */
  showWelcome?(): void;
  /** The shortcut sheet (`app.shortcuts`). */
  openShortcuts?(): void;
  /** The shell's polite live region (DESIGN 11.3). */
  announce?(message: string): void;
}

/** Where a failed write goes: one inline line with Retry, the control back at its old value. */
export interface WriteFailure {
  readonly op: string;
  /** A whole sentence in place of "Couldn't <op>.", for a failure whose outcome could not be confirmed. */
  readonly line?: string;
  /** Absent when a second try could repeat a write that may already have landed: then the line draws no Retry. */
  retry?(): void;
  dismiss(): void;
}
