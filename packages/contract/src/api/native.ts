import * as z from 'zod/mini';
import { desktop } from '../registry/define';
import {
  bool,
  Bytes,
  Count,
  choice,
  Empty,
  EpochMs,
  Id,
  line,
  Ok,
  openEnum,
  text,
} from '../schemas/common';

/** In-app update state from main (today's `UpdateInfo`). */
export const UpdateInfo = z.object({
  currentVersion: line(100),
  status: z.discriminatedUnion('state', [
    z.object({ state: z.literal('disabled'), reason: z.string() }),
    z.object({ state: z.literal('idle') }),
    z.object({ state: z.literal('checking') }),
    z.object({ state: z.literal('current') }),
    z.object({
      state: z.literal('downloading'),
      version: line(100),
      percent: z.optional(z.number()),
    }),
    z.object({ state: z.literal('ready'), version: line(100) }),
    z.object({ state: z.literal('error'), message: z.string() }),
  ]),
  lastCheck: z.optional(EpochMs),
  /** The owner chose Later for the ready update. */
  dismissed: z.optional(z.boolean()),
});

const key = z.object({ keySource: openEnum(['env', 'keychain', 'none']) });

/**
 * Main's native methods. They never reach the engine: preload routes them to main by the generated host table. Files
 * move as blob ids the engine already holds (`Attachment/get`, `Diagnostics/export`), never base64.
 */
export const native = desktop({
  'Window/compose': {
    summary: 'Open a saved draft in its own window.',
    kind: 'command',
    scope: 'read',
    input: z.object({ draftId: Id }),
    output: Ok,
  },
  'Window/thread': {
    summary: 'Open a thread in its own window.',
    kind: 'command',
    scope: 'read',
    input: z.object({ threadId: Id }),
    output: Ok,
  },
  'Window/claim': {
    summary: 'Claim a draft for this window so two windows never edit it at once.',
    kind: 'command',
    scope: 'read',
    input: z.object({ draftId: Id }),
    output: z.object({ claimed: z.boolean() }),
  },
  'Window/release': {
    summary: 'Release a claimed draft.',
    kind: 'command',
    scope: 'read',
    input: z.object({ draftId: Id }),
    output: Ok,
  },
  'Window/closeReady': {
    summary: 'The renderer saved its work; the held close may finish.',
    kind: 'command',
    scope: 'read',
    input: Empty,
    output: Ok,
  },
  'Window/closeCancel': {
    summary: 'The user kept the window open; cancel the held close or quit.',
    kind: 'command',
    scope: 'read',
    input: Empty,
    output: Ok,
  },
  'Window/openOnboarding': {
    summary: 'Open the onboarding window, first run or "Show welcome" beside the mail window.',
    kind: 'command',
    scope: 'read',
    input: z.object({ mode: choice(['first', 'review']) }),
    output: Ok,
  },
  'Window/finishOnboarding': {
    summary:
      'Hand over from onboarding to the mail window (main also calls `Setup/end` itself on any close); `to` names the screen the mail window opens on instead of Home.',
    kind: 'command',
    scope: 'read',
    input: z.object({ to: z.optional(choice(['settings.ai'])) }),
    output: Ok,
  },
  'Shell/open': {
    summary: 'Open an http, https or mailto link outside Aplos.',
    kind: 'command',
    scope: 'read',
    input: z.object({ url: text(4_000) }),
    output: Ok,
  },
  'File/save': {
    summary: 'Save a blob through the save dialog.',
    kind: 'command',
    scope: 'read',
    input: z.object({ blobId: Id, name: line(255) }),
    output: z.object({ canceled: z.boolean(), path: z.optional(line(4_000)) }),
  },
  'File/open': {
    summary:
      'Open an attachment blob in its app; only safe document and media types, else "Save this attachment to inspect it before opening."',
    kind: 'command',
    scope: 'read',
    input: z.object({ blobId: Id, name: line(255) }),
    output: Ok,
  },
  'Notification/test': {
    summary: 'Post a test notification.',
    kind: 'command',
    scope: 'read',
    input: Empty,
    output: Ok,
  },
  'System/login': {
    summary: 'Read, or set, whether Aplos opens at login.',
    kind: 'command',
    scope: 'admin',
    input: z.object({ enabled: z.optional(bool()) }),
    output: z.object({ enabled: z.boolean() }),
  },
  'System/defaultMail': {
    summary: 'Make Aplos the default mail app.',
    kind: 'command',
    scope: 'admin',
    input: Empty,
    output: z.object({ success: z.boolean() }),
  },
  'System/microphone': {
    summary: 'Microphone permission: check it without the macOS prompt, or ask.',
    kind: 'command',
    scope: 'read',
    input: z.object({ check: z.optional(bool()) }),
    output: z.object({ granted: z.boolean(), status: line(40) }),
  },
  'System/notifications': {
    summary: 'Notification permission, as far as macOS reports it.',
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: z.object({ status: openEnum(['granted', 'denied', 'notDetermined', 'unknown']) }),
  },
  'App/info': {
    summary: 'App name and version.',
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: z.object({ name: line(100), version: line(100), desktop: z.boolean() }),
  },
  'Update/status': {
    summary: 'In-app update state.',
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: UpdateInfo,
  },
  'Update/check': {
    summary: 'Check for an update now.',
    kind: 'command',
    scope: 'read',
    input: Empty,
    output: UpdateInfo,
  },
  'Update/restart': {
    summary: 'Restart to install the ready update.',
    kind: 'command',
    scope: 'admin',
    input: Empty,
    output: Ok,
  },
  'Update/later': {
    summary: 'Hide the ready update until the next check or launch.',
    kind: 'command',
    scope: 'read',
    input: Empty,
    output: UpdateInfo,
  },
  'Symbols/render': {
    summary: 'Render SF Symbols to PNG bytes for the menu bar and icons.',
    kind: 'query',
    scope: 'read',
    input: z.object({
      items: z
        .array(
          z.object({ name: line(100), size: z.optional(z.number()), weight: z.optional(line(20)) }),
        )
        .check(z.maxLength(200)),
      scale: z.optional(z.number().check(z.minimum(1), z.maximum(3))),
    }),
    output: z.object({
      images: z.array(z.object({ name: line(100), png: Bytes, width: z.int(), height: z.int() })),
    }),
  },
  'System/openSettings': {
    summary: 'Open the macOS System Settings pane for a permission Aplos needs.',
    kind: 'command',
    scope: 'read',
    input: z.object({ pane: choice(['notifications', 'microphone', 'loginItems']) }),
    output: Ok,
  },
  'Engine/restart': {
    summary:
      'Restart the engine, or un-park it (Try again); main answers even when the engine cannot.',
    kind: 'command',
    scope: 'admin',
    input: Empty,
    output: Ok,
  },
  'Engine/recover': {
    summary:
      "The damaged-database screen (plan 10 Decision 6), served by main while the engine is parked on a damaged `mail.db`: `inspect` lists what exists only on this Mac and the pre-migration backups; `export` saves a report (drafts' and scheduled sends' own words) where the owner chooses; `restore` puts a backup in place and `rebuild` starts over from the provider, each then relaunching Aplos. The damaged file is kept aside either way.",
    kind: 'command',
    scope: 'admin',
    input: z.object({
      action: choice(['inspect', 'export', 'restore', 'rebuild']),
      /** `restore`: the backup's name from `inspect`. */
      backup: z.optional(line(200)),
    }),
    output: z.object({
      /** The damaged copy's name in the data folder's `damaged/` folder; null when it could not be copied. */
      copy: z.nullable(line(300)),
      /** What exists only on this Mac; null where the damaged file would not say. */
      localOnly: z.object({
        drafts: z.nullable(Count),
        scheduled: z.nullable(Count),
        workflow: z.nullable(Count),
        changes: z.nullable(Count),
      }),
      /** Newest first. */
      backups: z.array(z.object({ name: line(200), schema: Count, at: EpochMs })),
      /** `export`: false when the owner cancelled the save. */
      saved: z.optional(z.boolean()),
    }),
  },
  'Diagnostics/copy': {
    summary:
      "Copy the content-free diagnostics bundle to the clipboard: the engine's, or main's host-only one when the engine is unreachable or parked.",
    kind: 'command',
    scope: 'admin',
    input: Empty,
    output: z.object({ source: openEnum(['engine', 'host']) }),
  },
  'Ai/pasteKey': {
    summary:
      'Main reads the clipboard and hands the key straight to `Ai/setKey`, so it never passes through the renderer.',
    kind: 'command',
    scope: 'admin',
    secret: true,
    audit: true,
    input: z.object({
      provider: choice([
        'groq',
        'openai',
        'anthropic',
        'gemini',
        'openrouter',
        'opencode-go',
        'ollama',
        'lmstudio',
        'custom',
      ]),
    }),
    output: key,
  },
});
