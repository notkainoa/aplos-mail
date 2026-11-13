/**
 * Every Settings row as a palette entry (DESIGN 7.10 "Every setting is searchable from ⌘K"; plan 30 U7 acceptance 2).
 * This manifest is the one list of rows: the sections render their rows through `Row` with an anchor from here, and the
 * tests check both directions (a rendered row has an entry; an entry is rendered by some state). It registers at
 * module load, so the rows are in the palette's Settings group while Settings is closed. Choosing one returns the
 * route "settings/<section>#<row>"; the screen scrolls to the row and focuses its control.
 */
import { registerSetting, settingId, type SettingEntry, type SettingSection } from '../../commands';
import { rowAvailable } from './availability';

export interface RowSpec {
  readonly section: SettingSection;
  /** The row's anchor: letters, digits, "-" or "_", starting with a letter. */
  readonly anchor: string;
  /** The label as the row shows it. */
  readonly label: string;
  readonly keywords?: readonly string[];
}

const row = (
  section: SettingSection,
  anchor: string,
  label: string,
  keywords: readonly string[] = [],
): RowSpec => ({ section, anchor, label, keywords });

export const SETTING_ROWS: readonly RowSpec[] = [
  // General
  row('general', 'theme', 'Theme', ['appearance', 'light', 'dark', 'system', 'color']),
  row('general', 'density', 'Density', [
    'row height',
    'compact',
    'roomy',
    'comfortable',
    'spacing',
  ]),
  row('general', 'keyHints', 'Show all key hints', ['shortcuts', 'keycaps', 'keys']),
  row('general', 'swipeDirection', 'Swipe direction', ['arrows', 'done', 'later', 'triage']),
  row('general', 'sidebarMinimised', 'Minimized sidebar', ['hide sidebar', 'menu']),
  row('general', 'openAtLogin', 'Open Aplos when you log in', ['login', 'startup', 'launch']),
  row('general', 'menuBar', 'Keep Aplos in the menu bar', [
    'background',
    'resident',
    'close window',
  ]),
  row('general', 'allowTools', 'Allow tools on this Mac', [
    'listener',
    'scripts',
    'mcp',
    'cli',
    'assistants',
  ]),
  row('general', 'tools', 'Connected tools', ['revoke', 'clients', 'permissions']),
  row('general', 'addTool', 'Add a tool', ['grant', 'allow', 'cli', 'mcp', 'key', 'token']),
  row('general', 'deviceSync', 'Device sync', ['workflow', 'macs', 'pairing', 'code']),
  // Mail
  row('mail', 'undoSend', 'Undo send', ['delay', 'unsend', 'seconds']),
  row('mail', 'followUp', 'Follow up', ['nudge', 'no reply', 'days']),
  row('mail', 'remoteImages', 'Remote images', ['block', 'tracking', 'load images']),
  row('mail', 'imageAllowList', 'Senders whose images load', ['allow list', 'trusted senders']),
  row('mail', 'retention', 'Message text kept', ['retention', 'storage', 'disk', 'delete old']),
  row('mail', 'defaultReply', 'Reply button', ['reply all']),
  // Calendar
  row('calendar', 'weekStart', 'Week starts on', ['monday', 'sunday', 'first day']),
  row('calendar', 'autoAddPlans', 'Add plans automatically', ['events from mail', 'proposals']),
  row('calendar', 'gmailEvents', 'Events from Gmail', ['flights', 'bookings', 'reservations']),
  row('calendar', 'calendarPermission', 'Calendar permission', ['reconnect', 'google calendar']),
  // AI
  row('ai', 'ask', 'Ask provider and model', ['groq', 'model', 'ai']),
  row('ai', 'summaries', 'Summaries provider and model', ['groq', 'model', 'ai']),
  row('ai', 'drafts', 'Drafts provider and model', ['groq', 'model', 'ai']),
  row('ai', 'plans', 'Plans provider and model', ['groq', 'model', 'ai']),
  row('ai', 'voice', 'Voice provider and model', ['dictation', 'speech', 'whisper', 'transcribe']),
  row('ai', 'provider-groq', 'Groq key', ['api key', 'groq_api_key', 'default']),
  row('ai', 'provider-openai', 'OpenAI key', ['api key', 'openai_api_key', 'chatgpt']),
  row('ai', 'provider-anthropic', 'Claude key', ['api key', 'anthropic', 'anthropic_api_key']),
  row('ai', 'provider-gemini', 'Gemini key', ['api key', 'gemini_api_key', 'google']),
  row('ai', 'provider-openrouter', 'OpenRouter key', ['api key', 'openrouter_api_key']),
  row('ai', 'provider-opencode-go', 'OpenCode Go key', ['api key', 'opencode_api_key']),
  row('ai', 'geminiPaid', 'Gemini paid plan', ['free tier', 'trains', 'paid key']),
  row('ai', 'server-ollama', 'Ollama address', ['local', 'localhost', 'server']),
  row('ai', 'server-lmstudio', 'LM Studio address', ['local', 'localhost', 'server']),
  row('ai', 'server-custom', 'Custom server address', ['openai compatible', 'url', 'server']),
  row('ai', 'howMailIsUsed', 'How your mail is used', ['privacy', 'what is sent', 'data']),
  row('ai', 'accountMail', 'Mail for AI on your accounts', [
    'account',
    'allow',
    'existing accounts',
  ]),
  row('ai', 'background', 'Summarize in the background', ['consent', 'automatic summaries']),
  row('ai', 'dailyCap', 'Daily limit', ['cap', 'tokens', 'budget', 'pause']),
  // Notifications
  row('notifications', 'enabled', 'Show notifications', ['banners', 'alerts']),
  row('notifications', 'reminders', 'Reminders', ['later', 'due']),
  row('notifications', 'perAccount', 'Notify for each account', ['accounts', 'mute']),
  row('notifications', 'reconnectReminder', 'Remind me before Gmail asks to reconnect', [
    'weekly',
    'sign in',
  ]),
  // Accounts
  row('accounts', 'accountsList', 'Accounts', [
    'connected',
    'google',
    'gmail',
    'reconnect',
    'sign in',
    'remove',
    'demo',
    'sample',
    'reset demo',
    'remove demo',
  ]),
  row('accounts', 'addAccount', 'Add an account', ['connect', 'google', 'gmail']),
  row('accounts', 'accountAi', 'Use this account’s mail for AI', [
    'privacy',
    'exclude',
    'provider',
  ]),
  row('accounts', 'accountColour', 'Account color', ['swatch', 'tag', 'color']),
  row('accounts', 'lease', 'Where it syncs', [
    'syncs on this mac',
    'syncs on another mac',
    'primary mac',
    'use this mac',
    'device',
    'lease',
  ]),
  // Keyboard
  row('keyboard', 'singleKeys', 'Single-key shortcuts', ['letters', 'wcag', 'accessibility']),
  row('keyboard', 'holdMs', 'Hold time', ['dictation', 'tap', 'hold', 'milliseconds']),
  row('keyboard', 'shortcuts', 'Change a shortcut', [
    'remap',
    'rebind',
    'keys',
    'binding',
    'reset all shortcuts',
    'defaults',
  ]),
  // Help & about
  row('help', 'version', 'About Aplos Mail', ['version', 'build', 'update', 'macos']),
  row('help', 'shortcutSheet', 'See every shortcut', ['cheat sheet', 'keys', 'help']),
  row('help', 'showWelcome', 'Show welcome', ['onboarding', 'setup', 'intro']),
  row('help', 'demoLoad', 'Load demo mail', ['sample', 'try']),
  row('help', 'diagnostics', 'Export diagnostics', ['report', 'logs', 'support']),
  row('help', 'verboseLogging', 'Verbose logging', ['log', 'debug', 'headers', 'support']),
  row('help', 'exportData', 'Export my data', ['download', 'backup', 'save', 'json', 'privacy']),
  row('help', 'queue', 'Queue inspector', ['pending', 'retry', 'discard', 'failed', 'outbox']),
  row('help', 'devDetails', 'Developer details', ['model names', 'scores', 'debug']),
];

/** Anchors drawn only in some states (per account, a missing permission, a key, the demo, a listed provider). */
const CONDITIONAL: readonly string[] = [
  'accounts/accountAi',
  'accounts/accountColour',
  'accounts/lease',
  'notifications/perAccount',
  'ai/geminiPaid',
  'ai/accountMail',
  'help/demoLoad',
  // The placeholder rows behind SHOW_UNBUILT_ROWS: not drawn, so not offered, until their capability is on.
  'general/allowTools',
  'general/addTool',
  'general/tools',
  'help/queue',
];

/** True for rows whose anchor is conditional, including the per-provider rows (`provider-*`, `server-*`). */
export function isConditional(spec: Pick<RowSpec, 'section' | 'anchor'>): boolean {
  return (
    CONDITIONAL.includes(`${spec.section}/${spec.anchor}`) ||
    (spec.section === 'ai' &&
      (spec.anchor.startsWith('provider-') || spec.anchor.startsWith('server-')))
  );
}

/** The palette entry for a row. A conditional row carries a live `available`, so it is not offered when not drawn. */
export function entryFor(spec: RowSpec): SettingEntry {
  return {
    id: settingId(spec.section, spec.anchor),
    label: spec.label,
    section: spec.section,
    rowAnchor: spec.anchor,
    keywords: spec.keywords,
    ...(isConditional(spec) ? { available: () => rowAvailable(spec.section, spec.anchor) } : {}),
  };
}

/** Registers every row; re-registering is a no-op, so hot reload is safe. Returns one function that removes them all. */
export function registerSettingRows(
  register: (entry: SettingEntry) => () => void = registerSetting,
): () => void {
  const removers = SETTING_ROWS.map(spec => register(entryFor(spec)));
  return () => removers.forEach(remove => remove());
}

registerSettingRows();

/** Looks a row up by section and anchor (a row component asks for its label and palette id). */
export function rowSpec(section: SettingSection, anchor: string): RowSpec | undefined {
  return SETTING_ROWS.find(r => r.section === section && r.anchor === anchor);
}
