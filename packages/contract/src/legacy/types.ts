import type {
  AccountPreset,
  ProviderCapabilities,
  ProviderKind,
  ServerSettings,
} from './provider-types';
export type View =
  | 'home'
  | 'later'
  | 'all'
  | 'drafts'
  | 'sent'
  | 'needs-reply'
  | 'awaiting-reply'
  | 'trash'
  | 'spam'
  | 'low'
  | 'calendar'
  | 'settings';
export interface SendAs {
  email: string;
  name: string;
  signature: string;
  isDefault: boolean;
}
export interface Account {
  id: string;
  name: string;
  email: string;
  color: string;
  provider: 'demo' | ProviderKind;
  connected: boolean;
  error?: string;
  calendarConnected?: boolean;
  sendAs?: SendAs[];
  preset?: AccountPreset;
  server?: ServerSettings;
  capabilities?: ProviderCapabilities;
}
export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  data?: string;
  contentId?: string;
  remoteId?: string;
  messageId?: string;
}
export interface Message {
  id: string;
  from: string;
  fromName: string;
  to: string[];
  cc?: string[];
  date: string;
  text: string;
  html?: string;
  quoted?: string;
  attachments: Attachment[];
  sent?: boolean;
  internetId?: string;
  references?: string;
}
/** The one next step AI suggests for a thread, shown as its primary action (Space). Presets only; never generated code.
 * link/attachment must point at something already in the thread; reply carries the instruction offered for an AI draft. */
export interface SuggestedAction {
  kind: 'link' | 'attachment' | 'reply' | 'calendar' | 'read';
  label: string;
  url?: string;
  attachmentId?: string;
  prompt?: string;
}
export interface Thread {
  id: string;
  accountId: string;
  subject: string;
  summary: string;
  messages: Message[];
  date: string;
  unread: boolean;
  status: 'new' | 'done' | 'later' | 'trash' | 'spam';
  importance: 'important' | 'low';
  bookmarked: boolean;
  replyStatus: 'none' | 'needs-reply' | 'awaiting-reply';
  dueDate?: string;
  reminderAt?: string;
  reminderFired?: boolean;
  todo?: string;
  hiddenFromHome?: boolean;
  remoteId?: string;
  labels?: string[];
  action?: SuggestedAction;
  /** Groq wrote `summary`; otherwise it may be the provider's snippet. */ aiSummary?: boolean;
}
export interface Draft {
  id: string;
  accountId: string;
  fromEmail?: string;
  signatureSource?: 'custom' | 'account';
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  attachments: Attachment[];
  threadId?: string;
  mode: 'new' | 'reply' | 'reply-all' | 'forward';
  updatedAt: string;
  signature: boolean;
  pendingSendAt?: string;
  sendError?: string;
  revision: number;
  messageId?: string;
  sendAttemptAt?: string;
  /** The user chose to send again although an earlier attempt may have been delivered. */ resendConfirmed?: boolean;
}
export interface CalendarEvent {
  id: string;
  accountId: string;
  threadId?: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  guests: string[];
  remoteId?: string;
  url?: string;
  /** Host version this copy was read at; saves fail rather than overwrite a newer one. */ etag?: string;
  /** The host emails attendees about changes (a meeting), so Aplos leaves it read-only. */ scheduling?: boolean;
}
/** One calendar inside an account. `color` is the host's colour when it has one. */
export interface CalendarInfo {
  id: string;
  name: string;
  accountId: string;
  /** The calendar `'primary'` stands for. */ primary?: boolean;
  color?: string;
}
export interface Settings {
  theme: 'light' | 'dark' | 'system';
  zen: boolean;
  sidebar: boolean;
  sidebarStyle: 'normal' | 'minimized';
  triageDirection: 'done-right' | 'done-left';
  swipe: boolean;
  doneAction: 'archive' | 'read' | 'unread';
  laterAction: 'archive' | 'read' | 'unread';
  lowAction: 'archive' | 'read' | 'unread';
  defaultReply: 'reply' | 'reply-all';
  signature: string;
  signatureMode: 'always' | 'new' | 'never';
  footer: boolean;
  autoPolish: boolean;
  undoSeconds: number;
  sendSound: boolean;
  autoCalendar: boolean;
  gmailEvents: boolean;
  notifications: boolean;
  accountNotifications: Record<string, boolean>;
  microphone: string;
  launchAtLogin: boolean;
  remoteImages: boolean;
  onboardingDone: boolean;
  /** Calendars left out of the Calendar page, as `calendarKey` values. */ hiddenCalendars: string[];
  /** The model each AI feature uses, as `provider:model` (see `aiFeatures` in shared/ask). */ askModel: string;
  summaryModel: string;
  draftModel: string;
  planModel: string;
  voiceModel: string;
  /** Address of a custom OpenAI-compatible server for Ask, e.g. http://localhost:11434/v1. */ askCustomUrl: string;
  /** Ollama's and LM Studio's addresses; empty uses their default local port. */ askOllamaUrl: string;
  askLmStudioUrl: string;
}
/** One tool Ask ran while answering, shown as a compact line. */
export interface AskStep {
  id: string;
  tool: string;
  label: string;
  count?: number;
  status: 'running' | 'done' | 'error';
}
/** Triage Ask prepared for listed threads; applied only when the user confirms. */
export interface AskTriage {
  action: 'done' | 'later' | 'bookmark';
  threadIds: string[];
  reason?: string;
}
/** `content` may carry citation markers `[^n]`, pointing at `citations[n-1]`. */
export interface AskMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: string[];
  proposal?: Partial<Draft>;
  /** A calendar event Ask prepared; saved only when the user confirms. */ event?: Partial<CalendarEvent>;
  triage?: AskTriage;
  steps?: AskStep[];
  model?: string;
}
export interface Conversation {
  id: string;
  title: string;
  messages: AskMessage[];
  updatedAt: string;
}
export interface AppState {
  version: 1;
  accounts: Account[];
  threads: Thread[];
  drafts: Draft[];
  events: CalendarEvent[];
  conversations: Conversation[];
  settings: Settings;
  selectedAccountId: string;
  sync: { busy: boolean; lastSync?: string; error?: string; pending?: number };
  blockedSenders: string[];
  /** Engine run and commit count of this copy; not saved. */ epoch?: string;
  rev?: number;
  /** Total threads when this copy holds only the newest ones. */ threadCount?: number;
}
export interface Capabilities {
  groq: boolean;
  google: boolean;
  microsoft: boolean;
  desktop: boolean;
  version: string;
  googleUnavailable?: string;
  microsoftUnavailable?: string;
}
/** In-app update state, from the main process (`update.status`, `update` events). */
export type UpdateStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current' }
  | { state: 'downloading'; version: string; percent?: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };
/** `dismissed`: the owner chose Later for the ready update; the notice stays hidden until a manual check or the next launch. */
export interface UpdateInfo {
  currentVersion: string;
  status: UpdateStatus;
  lastCheck?: string;
  dismissed?: boolean;
}
export type Listener = (event: { type: string; payload?: unknown }) => void;
export interface Bridge {
  invoke<T = unknown>(method: string, payload?: unknown): Promise<T>;
  /** `options.only` names the event types this listener wants; it hears only those, live, and never takes the events held for the app's first plain subscribe. */
  subscribe(listener: Listener, options?: { only?: readonly string[] }): () => void;
}
declare global {
  interface Window {
    aplos?: Bridge;
  }
}
