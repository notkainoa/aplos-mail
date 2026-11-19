/** Provider types the legacy contract shares with the legacy engine (moved from the engine's provider.ts in Phase 0 step 1, so the contract never imports the engine). */

export type ProviderKind = 'google' | 'microsoft' | 'imap' | 'jmap';

/** What a host supports, so the engine and UI only offer what works. */
export interface ProviderCapabilities {
  /** A thread can carry several labels at once (Gmail). Otherwise each message lives in one folder. */
  labels: boolean;
  /** The host has an importance marker that Aplos can set. */
  importance: boolean;
  /** Extra sending addresses come from the host. */
  aliases: boolean;
  /** Signatures come from the host. */
  signatures: boolean;
  /** Calendar read and write through the same account. */
  calendar: boolean;
  /** The host can search mail Aplos has not downloaded. */
  serverSearch: boolean;
}

/** Non-secret server settings for IMAP/SMTP accounts. */
export interface ServerSettings {
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** Login name when it differs from the email address. */
  username?: string;
  /** CalDAV base URL for calendars on the same credentials (iCloud, Fastmail). */
  caldav?: string;
}

/** Presets fill in server settings and help text; `generic` uses what the user typed. */
export type AccountPreset =
  'gmail' | 'outlook' | 'icloud' | 'yahoo' | 'aol' | 'fastmail' | 'generic';
