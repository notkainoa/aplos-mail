// The v1 desktop table on the real-engine path (main/engine-real.ts): which of main's handlers answers which contract
// method, and how a handler's answer becomes the contract's output. Electron-free, so node:test runs it.

/** The v1 desktop methods main answers through its existing handlers, by their handler name (a legacy dotted name or the v1 name itself). */
export const legacyNames: Readonly<Record<string, string>> = {
  'App/info': 'app.info',
  'Window/thread': 'window.thread',
  'Window/closeReady': 'window.closeReady',
  'Window/closeCancel': 'window.closeCancel',
  'Window/claim': 'window.claim',
  'Window/release': 'window.release',
  'Window/openOnboarding': 'Window/openOnboarding',
  'Window/finishOnboarding': 'Window/finishOnboarding',
  'Shell/open': 'shell.open',
  'Notification/test': 'notification.test',
  'Update/status': 'update.status',
  'Update/check': 'update.check',
  'Update/later': 'update.later',
  'Update/restart': 'update.restart',
  'System/openSettings': 'System/openSettings',
  'System/login': 'System/login',
  'System/notifications': 'System/notifications',
  'System/defaultMail': 'system.defaultMail',
  'System/microphone': 'system.microphone',
};

const ok = { ok: true } as const;

/** What a handler's answer becomes under the v1 contract: most answer `{ ok: true }`, `Window/claim` `{ claimed }`, `Update/*` a numeric `lastCheck`. */
export function v1Result(method: string, result: unknown): unknown {
  if (method === 'Window/claim') return { claimed: result === true };
  if (method.startsWith('Update/') && result && typeof result === 'object') {
    // Today's updater reports `lastCheck` as an ISO string; the contract's `UpdateInfo` wants epoch milliseconds.
    const info = result as { lastCheck?: unknown };
    if (typeof info.lastCheck === 'string') {
      const at = Date.parse(info.lastCheck);
      const { lastCheck: _drop, ...rest } = info;
      void _drop;
      return Number.isFinite(at) ? { ...rest, lastCheck: at } : rest;
    }
  }
  return result === true ? ok : result;
}

/** A file name from a caller: its last path part, control characters gone, `.` and `..` refused, never empty. */
export function fileNameOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 255) throw new Error('Invalid file name.');
  const last = raw.split(/[\\/]/).pop() ?? '';
  // Control characters (below space) become underscores.
  const clean = [...last].map(char => (char.charCodeAt(0) < 32 ? '_' : char)).join('');
  return clean === '' || clean === '.' || clean === '..' ? 'attachment' : clean;
}

/** File types a downloaded attachment may be opened in their app without saving it first. */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.eml',
  '.ics',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.rtf',
  '.mp3',
  '.mp4',
  '.wav',
  '.mov',
]);

/** The lower-cased extension of a file name, with its dot; empty for none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}
