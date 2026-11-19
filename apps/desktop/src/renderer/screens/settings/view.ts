/**
 * Settings' own transient state: what is open, being typed or being tested. It is controlled from outside (the
 * container holds it, the preview starts it somewhere), so every state of the screen can be drawn on purpose.
 * It never holds a key: the add-key field keeps its text in its own component and hands it over once.
 */
import type { ProviderId, ProviderStatus } from '../../ui/props';
import type { LocalId, RemovalDiscards } from './settings.model';
import type { Recording } from './keyboard.model';

/** A question that has to be answered before something destructive runs. Cancel is the default. */
export type Confirmation =
  | {
      readonly kind: 'removeAccount';
      readonly accountId: string;
      readonly address: string;
      /** Failed sends and calendar changes the removal deletes; absent when the queue could not be read. */
      readonly discards?: RemovalDiscards;
    }
  | { readonly kind: 'removeDemo' }
  | { readonly kind: 'removeKey'; readonly provider: ProviderId }
  | { readonly kind: 'discardQueueItem'; readonly id: string; readonly label: string }
  | { readonly kind: 'revokeClient'; readonly id: string; readonly name: string }
  /** Allow pressed with 'admin' ticked: the draft and its answer wait in the controller, not here. */
  | { readonly kind: 'grantAdmin'; readonly name: string };

export interface SettingsView {
  /** A running or finished provider test, by provider; it overrides the status the engine reports. */
  readonly testing: Partial<Record<ProviderId, ProviderStatus>>;
  /** The add-key dialog is open for this provider. */
  readonly addKey: { readonly provider: ProviderId; readonly mode: 'add' | 'replace' } | null;
  readonly confirm: Confirmation | null;
  readonly recording: Recording | null;
  /** "How your mail is used" is open. */
  readonly howOpen: boolean;
  /** The consent card for background summaries is open. */
  readonly consentCard: boolean;
  /** The reconnect flow is open for this account. */
  readonly reconnect: {
    readonly accountId: string;
    readonly mode: 'reconnect' | 'grant' | 'enableEditing';
  } | null;
  readonly addAccount: boolean;
  /** The diagnostics preview dialog is open. */
  readonly diagnostics: boolean;
  /** The report was just copied; the dialog says "Copied." until it is closed. */
  readonly diagnosticsCopied: boolean;
  /** The report was just saved to a file; the dialog says "Saved." until it is closed. */
  readonly diagnosticsSaved: boolean;
  /** "Export my data" just saved a file; its row says so until Settings is left. */
  readonly dataExported: boolean;
  /** The Add a tool dialog is open. The key file's path is the dialog's own state and never lives here. */
  readonly addTool: boolean;
  /** Help shows the queue inspector instead of its rows. */
  readonly queue: boolean;
  /** Local server addresses as typed, before they are saved. */
  readonly addressDraft: Partial<Record<LocalId, string>>;
  /** The engine's sentence when an address was refused. */
  readonly addressError: Partial<Record<LocalId, string>>;
  /** Work in flight, by key ("demo", "lease:<id>", "diagnostics"). */
  readonly busy: Readonly<Record<string, boolean>>;
}

export const INITIAL_VIEW: SettingsView = {
  testing: {},
  addKey: null,
  confirm: null,
  recording: null,
  howOpen: false,
  consentCard: false,
  reconnect: null,
  addAccount: false,
  diagnostics: false,
  diagnosticsCopied: false,
  diagnosticsSaved: false,
  dataExported: false,
  addTool: false,
  queue: false,
  addressDraft: {},
  addressError: {},
  busy: {},
};
