import type { UpdateInfo, UpdateStatus } from '@aplos/contract/legacy/types';

/** The part of electron-updater's AppUpdater this app uses; tests pass a fake. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateEnvironment {
  platform: string;
  packaged: boolean;
  /** Development opt-in (APLOS_UPDATE_DEV=1): check against dev-app-update.yml. */
  devFeed: boolean;
  /** The running .app bundle. */
  bundlePath: string;
  /** Developer ID team of the running bundle; undefined when unsigned or ad-hoc signed. */
  teamId: () => string | undefined;
}

/** Why updates are off here, or undefined when they can run. */
export function disabledReason(env: UpdateEnvironment): string | undefined {
  if (env.platform !== 'darwin') return 'Automatic updates are only available on macOS.';
  if (!env.packaged) return env.devFeed ? undefined : 'Updates are off in development builds.';
  if (/^\/Volumes\/|\/AppTranslocation\//.test(env.bundlePath))
    return 'Move Aplos Mail to your Applications folder to get updates.';
  if (!env.teamId())
    return 'This build is not signed with a Developer ID, so macOS would refuse an update. Download new versions from GitHub.';
  return undefined;
}

/** TeamIdentifier from `codesign --display --verbose=2` output (it writes to stderr). */
export function teamIdentifier(output: string): string | undefined {
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim();
  return team && team !== 'not set' ? team : undefined;
}

/** First line of an updater error, short enough for a settings row. electron-updater errors can include whole HTTP responses. */
function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line =
    raw
      .split('\n')
      .find(part => part.trim())
      ?.trim() || 'The update check failed.';
  return line.length > 160 ? line.slice(0, 157) + '…' : line;
}

export const firstCheckMs = 60_000;
export const checkIntervalMs = 6 * 60 * 60_000;

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clear: handle => {
    clearTimeout(handle as NodeJS.Timeout);
    clearInterval(handle as NodeJS.Timeout);
  },
};

/**
 * Checks a minute after launch and every six hours, downloads silently and reports through `emit`.
 * Never installs on its own: `restart()` is the only way an update is applied.
 */
export class UpdateController {
  private status: UpdateStatus;
  private lastCheck?: string;
  private dismissedVersion?: string;
  private pending?: Promise<UpdateInfo>;
  private handles: unknown[] = [];
  private readonly updater?: Updater;
  private readonly timers: Timers;
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      currentVersion: string;
      /** Set when updates cannot run here; the updater is then never touched. */
      disabled?: string;
      /** Created only when updates are enabled, so disabled builds never load electron-updater. */
      updater?: () => Updater;
      emit: (info: UpdateInfo) => void;
      log: (message: string) => void;
      timers?: Timers;
      now?: () => Date;
    },
  ) {
    this.timers = options.timers ?? realTimers;
    this.now = options.now ?? (() => new Date());
    if (options.disabled || !options.updater) {
      this.status = {
        state: 'disabled',
        reason: options.disabled || 'Updates are not configured.',
      };
      options.log(`updates disabled: ${this.status.reason}`);
      return;
    }
    this.status = { state: 'idle' };
    const updater = (this.updater = options.updater());
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.on('checking-for-update', () => {
      if (this.status.state !== 'downloading' && this.status.state !== 'ready')
        this.set({ state: 'checking' });
    });
    updater.on('update-not-available', () => {
      this.checked();
      if (this.status.state !== 'ready') this.set({ state: 'current' });
    });
    updater.on('update-available', (info: { version: string }) => {
      this.checked();
      this.set({ state: 'downloading', version: info.version });
    });
    updater.on('download-progress', (progress: { percent: number }) => {
      if (this.status.state !== 'downloading') return;
      const percent = Math.floor(progress.percent);
      if (percent !== this.status.percent) this.set({ ...this.status, percent });
    });
    updater.on('update-downloaded', (info: { version: string }) => {
      options.log(`update ${info.version} downloaded`);
      this.set({ state: 'ready', version: info.version });
    });
    updater.on('error', (error: unknown) => this.fail(error));
  }

  info(): UpdateInfo {
    const status = this.status;
    return {
      currentVersion: this.options.currentVersion,
      status,
      lastCheck: this.lastCheck,
      dismissed: status.state === 'ready' && status.version === this.dismissedVersion,
    };
  }

  start() {
    if (!this.updater) return;
    this.handles.push(
      this.timers.setTimeout(() => void this.check(), firstCheckMs),
      this.timers.setInterval(() => void this.check(), checkIntervalMs),
    );
  }

  stop() {
    for (const handle of this.handles.splice(0)) this.timers.clear(handle);
  }

  /** `manual` (menu or Settings) also brings back a ready notice the owner put off with Later. */
  check(manual = false): Promise<UpdateInfo> {
    if (manual) this.dismissedVersion = undefined;
    if (!this.updater) return Promise.resolve(this.info());
    if (this.pending) return this.pending;
    // A downloaded update is kept; a later check can still find a newer one.
    if (this.status.state !== 'ready' && this.status.state !== 'downloading')
      this.set({ state: 'checking' });
    this.pending = this.updater
      .checkForUpdates()
      .then(
        () => {
          /* outcome arrives through events */
        },
        error => this.fail(error),
      )
      .then(() => {
        this.pending = undefined;
        if (this.status.state === 'checking') {
          this.checked();
          this.set({ state: 'current' });
        }
        return this.info();
      });
    return this.pending;
  }

  later() {
    if (this.status.state === 'ready') {
      this.dismissedVersion = this.status.version;
      this.emit();
    }
  }

  /** Applies the downloaded update and relaunches. Returns false when nothing is ready. */
  install(): boolean {
    if (!this.updater || this.status.state !== 'ready') return false;
    this.options.log(`installing update ${this.status.version}`);
    this.updater.quitAndInstall(false, true);
    return true;
  }

  get ready() {
    return this.status.state === 'ready';
  }

  private checked() {
    this.lastCheck = this.now().toISOString();
  }
  private fail(error: unknown) {
    const message = shortError(error);
    this.options.log(`update check failed: ${message}`);
    this.checked();
    // A failure after the download finished (e.g. a later check offline) must not hide the ready update.
    if (this.status.state !== 'ready') this.set({ state: 'error', message });
  }
  private set(status: UpdateStatus) {
    this.status = status;
    this.emit();
  }
  private emit() {
    this.options.emit(this.info());
  }
}
