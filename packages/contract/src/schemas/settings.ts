import * as z from 'zod/mini';
import { bool, choice, Count, Id, line, messages, SenderMatch, text, HttpAddress } from './common';

/**
 * Settings, one singleton (`Settings/get`, `Settings/set`). Sections replace today's flat `Settings`. `Settings/set`
 * takes a patch per section: the fields given replace those fields, and object- or record-valued fields (`dock`,
 * `keymap`, `palette`, `calendar`, `features`, `perAccount`) are replaced whole. Closed enums: the engine validates what it can honour.
 */

/**
 * One remapped key: a chord such as `meta+s` or `e`, and whether it fires on tap (default) or hold. The F9 command
 * registry parses and checks chords; the engine only stores them.
 */
export const KeyBinding = z.object({
  chord: line(100),
  phase: z.optional(choice(['tap', 'hold'])),
});

/**
 * The renderer's own preferences (plan 30 section 8.1 item 8; UI-core's freeze list). The engine stores them and attaches
 * no behaviour, except `Later/presets`, which reads `calendar.weekStart` for "This weekend" and "Next week". The default
 * of each field, for a new install and for the stand-in engine, is given in its comment.
 */
export const UiSettings = z.object({
  /** Default `system`. */
  theme: choice(['light', 'dark', 'system']),
  /** Default `default` (DESIGN 4.4). */
  density: choice(['compact', 'default', 'roomy']),
  /** Key hints in tooltips only, or always shown (a mode, so layout never moves on hover, DESIGN 5 rule 17). Default `tooltip`. */
  keyHints: choice(['tooltip', 'always']),
  /** Single-letter shortcuts; off means they are off, not moved to ⌘ (DESIGN 11.4, WCAG 2.1.4). Default true. */
  singleKeys: bool(),
  /** Tap versus hold threshold for every hold key, in ms (plan 30 decision 7). Default 250. */
  holdMs: z
    .int({ error: messages.number })
    .check(z.minimum(100, messages.number), z.maximum(2_000, messages.number)),
  /** The Ask dock: open (closed on first run, then remembered, DESIGN decision 9), its last tab, and its width in px (absent: the layout default). Default `{open: false, tab: 'ask'}`. */
  dock: z.object({
    open: bool(),
    tab: choice(['ask', 'today']),
    width: z.optional(z.int().check(z.minimum(240), z.maximum(1_200))),
  }),
  /** Command id → its keys, only for commands the owner remapped; a listed command loses all its default keys. Default `{}`. */
  keymap: z.record(line(200), z.array(KeyBinding).check(z.maxLength(8, messages.text))),
  /** The sidebar is the minimised ☰ menu button (DESIGN 4.6, the [ key). Default false. */
  sidebarMinimised: bool(),
  swipe: bool(),
  /** Which side Done is on for → / ← and swipes (today's `triageDirection`); `doneLeft` puts Later on →. Default `doneRight`. */
  swipeDirection: choice(['doneRight', 'doneLeft']),
  zen: bool(),
  sendSound: bool(),
  /** Model names, scores and other developer details on screen (DESIGN 9 rule 4). Default false. */
  devDetails: bool(),
  /** `all` or an account id: the account filter the window opens with (today's `account.select`). Default `all`. */
  lastAccount: line(1_000),
  /** The palette's recent command ids, newest first. Default `{recents: []}`. */
  palette: z.object({ recents: z.array(line(200)).check(z.maxLength(50, messages.text)) }),
  /** `weekStart` 0 Sunday to 6 Saturday; absent follows the macOS locale (UI-screens decision 15). Default `{}`. */
  calendar: z.object({
    weekStart: z.optional(
      z.int().check(z.minimum(0, messages.option), z.maximum(6, messages.option)),
    ),
  }),
});

const mailAction = choice(['archive', 'read', 'unread']);
export const MailSettings = z.object({
  undoSendSeconds: z
    .int({ error: 'Undo send must be between 0 and 60 seconds.' })
    .check(
      z.minimum(0, 'Undo send must be between 0 and 60 seconds.'),
      z.maximum(60, 'Undo send must be between 0 and 60 seconds.'),
    ),
  /** Days without a reply before a sent thread enters Follow up (ARCH 8.2; default 3). */
  followUpDays: z
    .int({ error: messages.number })
    .check(z.minimum(1, messages.number), z.maximum(60, messages.number)),
  remoteImages: choice(['block', 'allow']),
  /** Senders whose remote images load without asking: addresses or `@domain` (ARCH 10; plan 30 section 8.1 item 4). */
  imageAllowList: z.array(SenderMatch).check(z.maxLength(5_000, messages.text)),
  doneAction: mailAction,
  laterAction: mailAction,
  lowAction: mailAction,
  defaultReply: choice(['reply', 'replyAll']),
  signature: text(20_000),
  signatureMode: choice(['always', 'new', 'never']),
  footer: bool(),
  autoPolish: bool(),
});

export const NotificationSettings = z.object({
  enabled: bool(),
  /** Account id → notify; absent accounts notify. */
  perAccount: z.record(Id, bool()),
  reminders: bool(),
  /** A notification a day before a Google account's weekly reconnect is due (plan 20 PV5 item 6). Off by default. */
  reconnectReminder: bool(),
});

/** Resident mode (ARCH 2.2): stay in the menu bar when the last window closes, and open at login with no window. */
export const HostSettings = z.object({
  menuBar: bool(),
  openAtLogin: bool(),
  /** The microphone device id for dictation; `default` follows the system. */
  microphone: line(500),
});

/** Body retention (ARCH 3.6, Decision 6): metadata and search stay forever; bodies are kept this long, plus anything opened, starred or unread, under the cap. */
export const RetentionSettings = z.object({
  bodyDays: z
    .int({ error: messages.number })
    .check(z.minimum(7, messages.number), z.maximum(36_500, messages.number)),
  maxBodyBytes: Count,
});

export const CalendarSettings = z.object({
  /** Add plans the Plans model finds in mail without asking (today's `autoCalendar`). */
  autoAddPlans: bool(),
  /** Show events Google created from mail (today's `gmailEvents`). */
  providerEventsFromMail: bool(),
  defaultCalendarId: z.optional(Id),
});

const featureModel = (message: string, check?: (provider: string) => boolean) =>
  z.object({
    provider: line(60).check(z.refine(v => v.length > 0 && (!check || check(v)), message)),
    model: line(200).check(z.refine(v => v.trim().length > 0, message)),
  });

/** A provider and model per AI feature (AGENTS.md); Groq is the default for all of them. */
export const AiSettings = z.object({
  features: z.object({
    ask: featureModel('Choose an Ask model.'),
    summaries: featureModel('Choose a model for summaries.'),
    drafts: featureModel('Choose a model for drafts.'),
    plans: featureModel('Choose a model for plans.'),
    /** Voice needs a speech-to-text API. */
    voice: featureModel(
      'Choose a Voice model on Groq or ChatGPT.',
      p => p === 'groq' || p === 'openai',
    ),
  }),
  /** Provider id → its non-secret settings: the local server address (Ollama, LM Studio, custom) and the paid-key mark (Gemini). */
  providers: z.record(
    line(60),
    z.object({ address: z.optional(HttpAddress), paid: z.optional(bool()) }),
  ),
  /** Background enrichment on or off; Ask and other interactive features are unaffected. */
  background: bool(),
  /** The daily background budget in tokens (ARCH 8.4, Decision 13: 150,000 by default). */
  dailyCap: z.object({ enabled: bool(), tokens: Count }),
});

export const Settings = z.object({
  ui: UiSettings,
  mail: MailSettings,
  notifications: NotificationSettings,
  host: HostSettings,
  retention: RetentionSettings,
  calendar: CalendarSettings,
  ai: AiSettings,
});
export type Settings = z.infer<typeof Settings>;

export const SettingsPatch = z.object({
  ui: z.optional(z.partial(UiSettings)),
  mail: z.optional(z.partial(MailSettings)),
  notifications: z.optional(z.partial(NotificationSettings)),
  host: z.optional(z.partial(HostSettings)),
  retention: z.optional(z.partial(RetentionSettings)),
  calendar: z.optional(z.partial(CalendarSettings)),
  ai: z.optional(z.partial(AiSettings)),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;
