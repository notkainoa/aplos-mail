/**
 * Structural copies of the contract/engine legacy types the main process annotates with. Declared locally so
 * `src/main` does not import the legacy modules for types alone; the legacy declaration stays the source of truth
 * for behaviour (TypeScript is structural — identical shapes are interchangeable at the boundary).
 */

// ---- contract/legacy/provider-types ----
export type ProviderKind = 'google' | 'microsoft' | 'imap' | 'jmap';
export interface ProviderCapabilities {
  labels: boolean;
  importance: boolean;
  aliases: boolean;
  signatures: boolean;
  calendar: boolean;
  serverSearch: boolean;
}
export interface ServerSettings {
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  username?: string;
  caldav?: string;
}
export type AccountPreset =
  'gmail' | 'outlook' | 'icloud' | 'yahoo' | 'aol' | 'fastmail' | 'generic';

// ---- contract/legacy/types ----
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
  aiSummary?: boolean;
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
  resendConfirmed?: boolean;
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
  etag?: string;
  scheduling?: boolean;
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
  hiddenCalendars: string[];
  askModel: string;
  summaryModel: string;
  draftModel: string;
  planModel: string;
  voiceModel: string;
  askCustomUrl: string;
  askOllamaUrl: string;
  askLmStudioUrl: string;
}
export interface AskStep {
  id: string;
  tool: string;
  label: string;
  count?: number;
  status: 'running' | 'done' | 'error';
}
export interface AskTriage {
  action: 'done' | 'later' | 'bookmark';
  threadIds: string[];
  reason?: string;
}
export interface AskMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: string[];
  proposal?: Partial<Draft>;
  event?: Partial<CalendarEvent>;
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
  epoch?: string;
  rev?: number;
  threadCount?: number;
}
export type UpdateStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current' }
  | { state: 'downloading'; version: string; percent?: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };
export interface UpdateInfo {
  currentVersion: string;
  status: UpdateStatus;
  lastCheck?: string;
  dismissed?: boolean;
}
export type Listener = (event: { type: string; payload?: unknown }) => void;
export interface Bridge {
  invoke<T = unknown>(method: string, payload?: unknown): Promise<T>;
  subscribe(listener: Listener): () => void;
}

// ---- contract/legacy/ask ----
export type AskProviderId =
  | 'groq'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'opencode-go'
  | 'ollama'
  | 'lmstudio'
  | 'custom';
export type AskServerId = 'ollama' | 'lmstudio' | 'custom';
export interface AskModelInfo {
  id: string;
  label: string;
  description?: string;
}

// ---- engine/legacy/agent ----
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
      raw?: unknown;
    }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  session?: string;
  json?: boolean;
}
export interface ChatTurn {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: { prompt: number; completion: number };
  raw?: unknown;
}
export interface ChatOptions {
  signal?: AbortSignal;
  onText?: (text: string) => void;
}
export type Chat = (request: ChatRequest, options: ChatOptions) => Promise<ChatTurn>;

// ---- engine/legacy/ports ----
export interface ChatProvider {
  readonly available: boolean;
  chat: Chat;
  models?(signal?: AbortSignal): Promise<AskModelInfo[]>;
  check?(signal?: AbortSignal): Promise<void>;
  status?(signal?: AbortSignal): Promise<{ running: boolean; version?: string }>;
  transcribe?(
    audio: string,
    mimeType: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ text: string }>;
  voiceModels?(signal?: AbortSignal): Promise<AskModelInfo[]>;
}
export type AiKeySource = 'saved' | 'environment';
export interface AiKeyInfo {
  source?: AiKeySource;
  last4?: string;
}
export interface AiKeyStore {
  readonly secure: boolean;
  readonly error?: string;
  info(provider: AskProviderId): AiKeyInfo;
  set(provider: AskProviderId, key: string): Promise<void>;
  delete(provider: AskProviderId): Promise<void>;
}
export interface MemoryStage {
  run<T>(fn: () => T): T;
  writes(): MemoryWrite[] | undefined;
  committed(): void;
  discard(): void;
}

// ---- engine/legacy/provider ----
export interface ThreadFlags {
  id: string;
  unread: boolean;
  bookmarked: boolean;
  status: 'new' | 'done' | 'trash' | 'spam';
  labels?: string[];
}
export interface SyncResult {
  threads: Thread[];
  flags: ThreadFlags[];
  removed: string[];
  cursor?: string;
  reset: boolean;
}
export interface SyncContext {
  has(threadId: string): boolean;
}
export interface ConnectRequest {
  provider: ProviderKind;
  email?: string;
  name?: string;
  secret?: string;
  preset?: AccountPreset;
  server?: ServerSettings;
  sessionUrl?: string;
}
export type RemoteThread = Pick<Thread, 'remoteId' | 'status' | 'labels'>;
export interface CalendarInfo {
  id: string;
  name: string;
  accountId: string;
  primary?: boolean;
  color?: string;
}
export interface AppDataRecord {
  id: string;
  data: string;
}
export interface ProviderMemory {
  get(accountId: string, key: string): string | undefined;
  set(accountId: string, key: string, value: string | undefined): void;
  clear(accountId: string): void;
}
export interface ProviderEnvironment<Cipher = Uint8Array> {
  dataDir: string;
  encrypt?: (value: string) => Cipher;
  decrypt?: (value: Cipher) => string;
  openExternal?: (url: string) => Promise<unknown>;
  fetch?: typeof fetch;
  memory?: ProviderMemory;
}
export interface MailProvider {
  readonly kind: ProviderKind;
  readonly available: boolean;
  readonly unavailableReason?: string;
  capabilities(account?: Account): ProviderCapabilities;
  connect(request: ConnectRequest): Promise<Account>;
  disconnect(accountId: string): Promise<void>;
  sync(account: Account, cursor: string | undefined, context: SyncContext): Promise<SyncResult>;
  search(account: Account, query: string): Promise<Thread[]>;
  updateThread(account: Account, thread: RemoteThread, patch: Partial<Thread>): Promise<void>;
  findSent(
    account: Account,
    messageId: string,
  ): Promise<{ id: string; threadId: string } | undefined>;
  send(
    account: Account,
    draft: Draft,
    thread?: Thread,
  ): Promise<{ id?: string; threadId?: string }>;
  attachment(account: Account, thread: Thread, attachment: Attachment): Promise<Attachment>;
  getSendAs?(account: Account): Promise<NonNullable<Account['sendAs']>>;
  listCalendars?(account: Account): Promise<CalendarInfo[]>;
  listEvents?(account: Account): Promise<CalendarEvent[]>;
  saveEvent?(account: Account, event: CalendarEvent): Promise<CalendarEvent>;
  deleteEvent?(account: Account, event: CalendarEvent): Promise<void>;
  readAppData?(account: Account): Promise<AppDataRecord[]>;
  writeAppData?(account: Account, data: string, replaces: string[]): Promise<void>;
  close(): void | Promise<void>;
}

// ---- engine/legacy/sql ----
export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;
export interface SqlStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

// ---- engine/legacy/store ----
export interface MemoryWrite {
  accountId: string;
  key: string;
  value: string | undefined;
}
