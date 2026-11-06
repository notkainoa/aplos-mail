/**
 * What Settings needs from outside itself, as plain interfaces, so this lane compiles and runs before its neighbours
 * land. The container fills them from `renderer/data` (`api`, the hooks) and the shell; the preview and the tests
 * fill them with stand-ins.
 *
 * REQUESTS (also in the lane report):
 * - ui-shell: a real save path for the report — `Diagnostics/export` plus main's save dialog (`File/save`) — is in
 *   the contract but not on `DataApi`, so `diagnosticsCopy` is the only way out today and the dialog says so.
 * - ui-onboard: `renderReconnect` is `<ReconnectFlow accountId mode onClose>` and `showWelcome` is
 *   `renderer/onboarding/showWelcome`; both are supplied by whoever mounts Settings.
 */
import type { ReactNode } from 'react';
import type { Account, Consent, Session, Settings, SettingsPatch } from '../../data';
import type {
  AiModelInfo,
  AiUsageInfo,
  BundleInfo,
  ClientEntry,
  ListenerInfo,
  QueueEntry,
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
  readonly queue?: readonly QueueEntry[];
  /** The diagnostics preview, once asked for. */
  readonly bundle?: BundleInfo;
}

/** The contract calls Settings makes, each by the contract method's own shape. */
export interface SettingsApiPort {
  settingsSet(patch: SettingsPatch): Promise<void>;
  accountSet(
    accountId: string,
    patch: { colorTag?: string; aiAllowed?: boolean; notifications?: boolean; name?: string },
  ): Promise<void>;
  accountDisconnect(accountId: string): Promise<void>;
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
  diagnosticsPreview(): Promise<BundleInfo>;
  /** Copies the report to the clipboard (there is no save-to-file port yet). */
  diagnosticsCopy(): Promise<void>;
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
}

/** Shell facilities Settings uses; all optional so a test needs none. */
export interface SettingsHost {
  /** A quiet toast ("Done is now L"). Settings never mounts a ToastStack. */
  toast?(message: string): void;
  /** Puts a local change on the shared undo stack (Z). */
  pushUndo?(entry: { label: string; undo(): void | Promise<void> }): void;
  /** The reconnect flow, mounted by ui-onboard (`ReconnectFlow`). */
  renderReconnect?(accountId: string, mode: 'reconnect' | 'grant', onClose: () => void): ReactNode;
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
  retry(): void;
  dismiss(): void;
}
