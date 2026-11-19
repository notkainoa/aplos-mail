import type { IsoDateTime, TagColor } from './shared';
import type { ErrorLineKind } from './list';

/* ───────────────────────── status ───────────────────────── */

/** One account's sync state in ARCH §6.4's vocabulary, plus the demo account (DESIGN §7.1 status table). */
export type SyncStatus =
  | {
      /** "Starting…", only after 150 ms. */
      kind: 'starting';
    }
  | {
      /** "Updating your mailbox…": main says the engine is backing up and migrating the database (may take minutes). */
      kind: 'updating';
    }
  | {
      /** "Syncing…", only after 150 ms. */
      kind: 'syncing';
      /** First window still reading: "Reading your newest mail · 24 of 50" (mockup empty.html first-mail; see README open question). */
      firstWindow?: { read: number; of: number };
    }
  | {
      /** Nothing shown; "Synced 2 min ago" on hover. */
      kind: 'ok';
      /** Last successful sync, for the hover line. */
      lastSyncedAt?: IsoDateTime;
      /** Token expiry; within 24 hours shows "Gmail will ask you to reconnect tomorrow at 9:00 AM." with Reconnect now. */
      reconnectBy?: IsoDateTime;
    }
  | {
      /** "Importing 214 of 500" with a neutral track. */
      kind: 'backfilling';
      /** Imported so far. */
      done: number;
      /** Total to import. */
      of: number;
    }
  | {
      /** Throttle: "Google asked us to slow down. Resuming at 2:14 PM." with Retry now. Daily limit: "Google's daily limit is reached. Resuming tomorrow." */
      kind: 'paused';
      /** Why it paused. */
      reason: 'throttle' | 'dailyLimit';
      /** When it resumes, if known. */
      resumeAt?: IsoDateTime;
    }
  | {
      /** "Google needs you to sign in again." with Reconnect. */
      kind: 'needsReauth';
    }
  | {
      /** "Aplos needs permission to read your Gmail." with Reconnect. */
      kind: 'needsPermission';
    }
  | {
      /** "Your organization has blocked Aplos. Ask your administrator." */
      kind: 'needsAdmin';
    }
  | {
      /** "Google sign-in isn't set up in this build." with Copy diagnostics. */
      kind: 'misconfigured';
    }
  | {
      /** "Offline · 2 changes waiting"; drains automatically. */
      kind: 'offline';
      /** Queued local changes. */
      changesWaiting: number;
    }
  | {
      /** "Sync hit a problem." with View details. */
      kind: 'error';
    }
  | {
      /** "Demo mail · Remove in Settings", one line that opens Settings → Accounts. */
      kind: 'demo';
    };

/** The account a progress row belongs to. */
export interface SyncAccount {
  /** Address; also the progress bar's label "<address> sync" (DESIGN §7.12 Accessibility). */
  address: string;
  /** Account color dot. */
  color: TagColor;
}

/** Verbs the status slot offers; Reconnect opens the ReconnectSheet. */
export type StatusAction =
  'reconnect' | 'retry' | 'copyDiagnostics' | 'viewDetails' | 'openAccounts';

/**
 * The sidebar footer's sync state, the only place sync status lives in the main window; two short lines of about 28
 * characters with an inline Button size 'sm'; never a banner (DESIGN §6 StatusSlot, §7.1). Mockups: errors.html
 * (reconnect, quota, offline), empty.html (first-mail), demo.html, shell.js STATUS. Plain + refines: ui-foundation; used by ui-shell.
 * Priority (proposed, pending DESIGN): the shell passes the single most severe account state (needsAdmin, misconfigured,
 * needsReauth, needsPermission, error, paused, offline, backfilling, syncing, starting, ok), and `account` with it.
 */
export interface StatusSlotProps {
  /** The state to show; the component writes DESIGN §7.1's copy. A healthy `ok` with `lastSyncedAt` shows nothing and puts "Synced 2 min ago" in the element's `title` (hover only). */
  status: SyncStatus;
  /** The account the state is about. Named in the copy only when `multipleAccounts`; always the "<address> sync" label of the importing track. */
  account?: SyncAccount;
  /** Two or more accounts are connected, so the copy names the account. */
  multipleAccounts?: boolean;
  /** The current time, compared with `reconnectBy` and `lastSyncedAt`. Default: the real clock; the harness and tests pass a fixed one. */
  now?: IsoDateTime;
  /** The offered action was chosen, with the account it is for (Reconnect opens ReconnectSheet for that address). */
  onAction: (action: StatusAction, account?: SyncAccount) => void;
}

/** The weekly Gmail reconnect sheet (`--elev-dialog`): opens the provider in the browser with the address filled in, "Waiting for Google in your browser…" with Cancel; closes with a "Reconnected" toast; nothing resyncs (DESIGN §6 ReconnectSheet, §7.1). Onboarding's inline waiting step is not this sheet: it is an OnboardingStep with ProgressSegments 'waiting'. Mockups: settings-accounts.html (reconnect). Plain + refines: ui-foundation; used by ui-shell, ui-settings. */
export interface ReconnectSheetProps {
  /** Whether it is shown. */
  open: boolean;
  /** The account address (`login_hint`). */
  address: string;
  /** Whose sign-in page; names it in the copy. Default 'google'; 'microsoft' for round 2. */
  provider?: 'google' | 'microsoft';
  /** 'waiting' for the browser, or 'failed' with a reason and Try again. */
  state: 'waiting' | 'failed';
  /** Plain reason when failed. */
  reason?: string;
  /** Cancel (Esc). */
  onCancel: () => void;
  /** Try again after a failure. */
  onRetry: () => void;
  /** 'reconnect' (default) = the weekly reconnect copy; 'grant' = a missing permission ("Aplos needs permission to read your Gmail", `needsPermission`); 'enableEditing' = the calendar-write ask ("Aplos will ask Google for permission to change events"), the shell's `openSheet('reconnect', {mode})`. */
  mode?: 'reconnect' | 'grant' | 'enableEditing';
}

/** State of one first-sync checkpoint (DESIGN §7.12): done `--ink-2`, paused `--dusk`, failed `--stamp`; 'current' carries the `status` motion; 'partial' = a capped pass. */
export type SegmentState = 'pending' | 'current' | 'done' | 'paused' | 'partial' | 'failed';

/** One engine checkpoint; the component writes the checklist copy ("Found about 214 recent emails", "Reading your newest mail · 24 of 50", "Sorted 12 of 40. The rest continue in the background."). */
export type SyncCheckpoint =
  | {
      /** Connect. */
      step: 'connect';
      /** State. */
      state: SegmentState;
    }
  | {
      /** Find recent mail; a count only as "about N" when the provider estimates, else an indeterminate bar. */
      step: 'find';
      /** State. */
      state: SegmentState;
      /** Provider's estimate, if any. */
      estimate?: number;
    }
  | {
      /** Read your newest mail: n of the first window, never the mailbox total. */
      step: 'read';
      /** State. */
      state: SegmentState;
      /** Read so far. */
      read: number;
      /** Size of the first window (about 50). */
      of: number;
    }
  | {
      /** Sort what matters; omitted with no AI provider. */
      step: 'sort';
      /** State. */
      state: SegmentState;
      /** Summaries done. */
      sorted: number;
      /** Summaries planned (at most 40). */
      of: number;
    };

/** Checkpoint progress for first sync, "Account connected" and "Importing N of M"; neutral colours; never a fake percentage (DESIGN §6 ProgressSegments, §7.12). Mockups: onboarding-sync.html (progress, paused, ready, partial, failed), onboarding-drill.html, onboarding-accounts.html (waiting), shell.js (importing). Plain + refines: ui-foundation; used by ui-onboard, ui-shell. */
export type ProgressSegmentsProps =
  | {
      /** One account's segments plus its checklist. */
      variant: 'checkpoints';
      /** The account. */
      account: SyncAccount;
      /** Checkpoints in order: connect, find, read, sort (sort omitted with no AI). */
      checkpoints: readonly SyncCheckpoint[];
      /** Paused until, for "Paused until 2:14 PM". */
      pausedUntil?: IsoDateTime;
      /** What failed, rendered as an ErrorLine (placement 'checklist'): 'reason' for a plain engine sentence, 'sortFailed' for an AI failure. */
      failure?: ErrorLineKind;
      /** The account was skipped or isn't connected: "Not connected · Try again", never an endless "Waiting" (DESIGN §7.12). */
      notConnected?: boolean;
      /** "Not connected · Try again" or Try again after a failure. */
      onRetry?: () => void;
      /** "Open Settings" after an AI failure (sortFailed). */
      onOpenSettings?: () => void;
      /** Only the segments and status, no checklist (the drill keeps progress visible this way). */
      compact?: boolean;
      /** How many accounts are connected. The account's colour dot shows only with two or more (DESIGN decision 16); omitted means one, so no dot. */
      accountCount?: number;
      /** 'polite' (default) keeps this part's own visually hidden role="status" for phase changes; 'off' drops it (the phase text stays, without a role) so a parent that shows several accounts can own ONE live region. That wrapper must be `<div aria-live="polite" aria-atomic="false">`, not a bare role="status" (which implies aria-atomic="true" and would re-read every account whenever one changes). */
      live?: 'polite' | 'off';
    }
  | {
      /** The status slot's "Importing N of M" track. */
      variant: 'importing';
      /** The account. */
      account: SyncAccount;
      /** Imported so far. */
      done: number;
      /** Total to import. */
      of: number;
    }
  | {
      /** An indeterminate neutral track with no count, e.g. waiting for OAuth in the browser (onboarding-accounts.html waiting `.wait-track`). */
      variant: 'waiting';
      /** Accessible name of the progressbar, e.g. "Waiting for sign-in". */
      label: string;
    }
  | {
      /** The drawn 40 px check (static under reduced motion). */
      variant: 'ready';
      /** 'ready' = "Your mail is ready"; 'connected' = "Account connected". */
      label: 'ready' | 'connected';
      /** 'polite' (default) keeps this part's own visually hidden role="status" for phase changes; 'off' drops it (the phase text stays, without a role) so a parent that shows several accounts can own ONE live region. That wrapper must be `<div aria-live="polite" aria-atomic="false">`, not a bare role="status" (which implies aria-atomic="true" and would re-read every account whenever one changes). */
      live?: 'polite' | 'off';
      /** Per-account results; the component writes "Newest 50 read · sorted 40 of 40" (sort omitted with no AI). */
      accounts?: readonly (SyncAccount & { read: number; sorted?: { done: number; of: number } })[];
    }
  | {
      /** Plain labelled segments with no checklist copy, for progress the other variants don't name (gap list O16, U10). */
      variant: 'segments';
      /** Segments in order. */
      segments: readonly ProgressSegment[];
      /** Accessible name of the progressbar, e.g. "jordan@gmail.com sync" (DESIGN §7.12). */
      label: string;
      /** 'polite' (default) keeps this part's own visually hidden role="status" for phase changes; 'off' drops it (the phase text stays, without a role) so a parent that shows several accounts can own ONE live region. That wrapper must be `<div aria-live="polite" aria-atomic="false">`, not a bare role="status" (which implies aria-atomic="true" and would re-read every account whenever one changes). */
      live?: 'polite' | 'off';
    };

/** One segment of ProgressSegments' 'segments' variant (DESIGN §7.12: neutral colours, never a fake percentage). */
export interface ProgressSegment {
  /** Segment name for assistive tech and the tooltip, e.g. "Read your newest mail". */
  label: string;
  /** State; 'current' carries the `status` motion. */
  state: SegmentState;
  /** The current segment's real fraction, 0–1, when the engine reports a count ("24 of 50" → 0.48); omit for an indeterminate segment. */
  value?: number;
}

/** The whole-pane fatal error: sans `display` "Aplos can't reach its mail engine." + "Your mail is safe on this Mac." (DESIGN §6 FatalScreen, §7.15; plan 30 §4.5 #3). Mockups: fatal.html. Plain + refines: ui-foundation; used by ui-shell. */
export interface FatalScreenProps {
  /**
   * 'unreachable' = Restart engine · Copy diagnostics; 'parked' = the parked engine, Try again · Export diagnostics;
   * 'damaged' = the damaged mail database (plan 10 Decision 6): what is only on this Mac, then Export report · Restore
   * backup · Rebuild from Google, from `damaged`.
   */
  kind: 'unreachable' | 'parked' | 'damaged';
  /** `kind: 'damaged'` only. Absent while main is still reading the damaged file. */
  damaged?: DamagedDatabase;
  /** Restart in progress: the button reads "Restarting…" and is disabled. */
  restarting: boolean;
  /** Restart engine / Try again (Return). */
  onRestart: () => void;
  /** Copy or export the content-free diagnostics. */
  onDiagnostics: () => void;
}

/** The damaged-database screen's facts and its three ways out (FatalScreen `kind: 'damaged'`). */
export interface DamagedDatabase {
  /** What exists only on this Mac; null where the damaged file would not say. */
  localOnly: {
    drafts: number | null;
    scheduled: number | null;
    workflow: number | null;
    changes: number | null;
  };
  /** The newest pre-migration backup, when there is one. */
  backup?: { at: number };
  /** An action in flight: its button reads as working and the others wait. */
  busy?: 'export' | 'restore' | 'rebuild';
  /** Restore and Rebuild ask once, naming what they cannot bring back. */
  confirm?: 'restore' | 'rebuild';
  onExport: () => void;
  onRestore: () => void;
  onRebuild: () => void;
  onCancel: () => void;
}

/** A quiet indicator that appears only after 150 ms; never for local reads (DESIGN §5 rule 12, §6 Spinner). Mockups: onboarding-sync.html, onboarding-drill.html. Plain + refines: ui-foundation. */
export interface SpinnerProps {
  /** Accessible name, e.g. "Searching Google". */
  label: string;
  /** 12 px for 12 px lines and chips, 16 px elsewhere. Default 'md'. */
  size?: 'sm' | 'md';
}
