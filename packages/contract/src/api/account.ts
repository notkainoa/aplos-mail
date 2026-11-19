import * as z from 'zod/mini';
import { area } from '../registry/define';
import {
  bool,
  choice,
  Email,
  Empty,
  EpochMs,
  getResult,
  HttpsUrl,
  Id,
  Ids,
  line,
  OpId,
  openEnum,
  Receipt,
  text,
} from '../schemas/common';
import { Account, AccountPreset, ConnectStart, Lease, ServerSettings } from '../schemas/account';

const noBreaks = 'Passwords and tokens cannot contain line breaks.';
const secretText = text(4_000).check(z.regex(/^[^\r\n]*$/, noBreaks));

export const account = area('account', {
  'Account/get': {
    summary:
      'Accounts with health, capabilities, lease and identities; all of them when `ids` is absent.',
    kind: 'query',
    scope: 'read',
    input: z.object({ ids: z.optional(Ids(200)) }),
    output: getResult(Account),
  },
  'Account/discover': {
    summary:
      "Which provider an address or domain belongs to, with preset server settings (today's `account.discover` and `domain.check`). Round 1 connects Google only.",
    kind: 'query',
    scope: 'admin',
    input: z
      .object({ address: z.optional(Email), domain: z.optional(line(253)) })
      .check(z.refine(v => !!v.address || !!v.domain, 'Enter a valid email address.')),
    output: z.object({
      provider: openEnum([
        'google',
        'microsoft',
        'icloud',
        'fastmail',
        'yahoo',
        'imap',
        'jmap',
        'unsupported',
      ]),
      preset: z.optional(AccountPreset),
      server: z.optional(ServerSettings),
      sessionUrl: z.optional(line(2_000)),
      reasonCode: z.optional(line(60)),
      message: z.optional(z.string()),
    }),
  },
  'Account/connect': {
    summary:
      'Start connecting an account; returns at once with a `connectId` and reports through `connect` frames (OAuth opens the browser via the host channel).',
    kind: 'command',
    scope: 'admin',
    secret: true,
    audit: true,
    input: z.object({
      provider: choice(['google', 'microsoft', 'imap', 'jmap']),
      loginHint: z.optional(Email),
      setupId: z.optional(Id),
      preset: z.optional(
        choice(['gmail', 'outlook', 'icloud', 'yahoo', 'aol', 'fastmail', 'generic']),
      ),
      address: z.optional(Email),
      name: z.optional(line(200)),
      /** An app-specific password or API token for IMAP and JMAP hosts (round 2). Never logged or returned. */
      secret: z.optional(secretText),
      /** A second app password for the account's CalDAV calendars when `secret` is a mail-only API token (Fastmail). */
      calendarSecret: z.optional(secretText),
      server: z.optional(ServerSettings),
      sessionUrl: z.optional(HttpsUrl),
    }),
    output: ConnectStart,
  },
  'Account/reconnect': {
    summary:
      'Sign in again (the weekly Gmail reconnect, `needsReauth`): passes `login_hint`, refuses another identity, keeps queued changes, no resync.',
    kind: 'command',
    scope: 'admin',
    audit: true,
    input: z.object({ accountId: Id }),
    output: ConnectStart,
  },
  'Account/updateSecret': {
    summary:
      'Reconnect an app-password or API-token account (iCloud, IMAP, Fastmail) with its new secret after `needsReauth`; reports through `reconnect` connect frames, keeps queued changes, no resync. `calendarSecret` replaces a separate CalDAV app password.',
    kind: 'command',
    scope: 'admin',
    secret: true,
    audit: true,
    input: z
      .object({
        accountId: Id,
        secret: z.optional(secretText),
        calendarSecret: z.optional(secretText),
      })
      .check(z.refine(v => !!v.secret || !!v.calendarSecret, 'Paste the new password first.')),
    output: ConnectStart,
  },
  'Account/grantPermissions': {
    summary:
      'Full re-consent for missing scopes (installed apps cannot do incremental auth). `enable: calendarWrite` is the only way Aplos ever asks for permission to create, change and delete calendar events; without it the re-consent never asks for more than reading.',
    kind: 'command',
    scope: 'admin',
    audit: true,
    input: z.object({ accountId: Id, enable: z.optional(choice(['calendarWrite'])) }),
    output: ConnectStart,
  },
  'Account/cancelConnect': {
    summary: 'Cancel a connect still waiting for the browser; a late answer is then ignored.',
    kind: 'command',
    scope: 'admin',
    input: z.object({ connectId: Id }),
    output: z.object({ cancelled: z.boolean() }),
  },
  'Account/set': {
    summary:
      'Rename an account, change its colour, its notifications or "Use this account\'s mail for AI" (Electron windows only).',
    kind: 'command',
    scope: 'admin',
    audit: true,
    windowOnlyArgs: ['aiAllowed'],
    input: z.object({
      opId: OpId,
      accountId: Id,
      name: z.optional(line(200)),
      colorTag: z.optional(line(40)),
      aiAllowed: z.optional(bool()),
      notifications: z.optional(bool()),
    }),
    output: z.object({ account: Account, receipt: Receipt }),
  },
  'Account/lease': {
    summary:
      '"Use this Mac" for background work (pin), or back to automatic; every account when `accountId` is absent (ARCH 6.5).',
    kind: 'command',
    scope: 'admin',
    audit: true,
    input: z.object({ accountId: z.optional(Id), pin: bool() }),
    output: z.object({ leases: z.array(z.object({ accountId: Id, lease: Lease })) }),
  },
  'Account/disconnect': {
    summary:
      'Remove an account and everything Aplos stored for it on this device; refused while one of its messages is on its way (sending, queued, scheduled, suspended or maybe sent) or a calendar change for guests is waiting. Failed sends are deleted with it.',
    kind: 'command',
    scope: 'admin',
    audit: true,
    input: z.object({ opId: OpId, accountId: Id }),
    output: z.extend(Receipt, {
      /** The account is gone but its stored sign-in could not be deleted yet; the next start tries again. */
      signInKept: z.optional(z.literal(true)),
    }),
  },
});

export const sync = area('sync', {
  'Sync/request': {
    summary:
      'Ask for a sync now; refused without any network call while an account is paused, unless `force` (once per throttle pause).',
    kind: 'command',
    scope: 'read',
    input: z.object({
      accountId: z.optional(Id),
      scope: z.optional(choice(['mail', 'calendar', 'all'])),
      force: z.optional(bool()),
    }),
    output: z.object({
      accounts: z.array(
        z.object({
          accountId: Id,
          accepted: z.boolean(),
          reasonCode: z.optional(line(60)),
          resumeAt: z.optional(EpochMs),
        }),
      ),
    }),
  },
});

export const workflow = area('workflow', {
  'Workflow/status': {
    summary: 'Whether Done, Later and reminders sync between your Macs on the encrypted channel.',
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: z.object({
      enabled: z.boolean(),
      available: z.boolean(),
      message: z.optional(z.string()),
    }),
  },
  'Workflow/enable': {
    summary: 'Turn on device sync, joining with a pairing code from another Mac or creating one.',
    kind: 'command',
    scope: 'admin',
    secret: true,
    audit: true,
    input: z.object({ code: z.optional(line(200)) }),
    output: z.object({ code: line(200) }),
  },
  'Workflow/code': {
    summary: 'The pairing code to enter on another Mac.',
    kind: 'query',
    scope: 'admin',
    secret: true,
    input: Empty,
    output: z.object({ code: line(200) }),
  },
  'Workflow/disable': {
    summary: 'Turn off device sync.',
    kind: 'command',
    scope: 'admin',
    audit: true,
    input: Empty,
    output: z.object({ enabled: z.literal(false) }),
  },
});

export const unsubscribe = area('unsubscribe', {
  'Unsubscribe/get': {
    summary:
      'How this thread can be unsubscribed from: one-click (RFC 8058), mailto, a link to review, or not at all.',
    kind: 'query',
    scope: 'read',
    input: z.object({ threadId: Id }),
    output: z.object({
      method: openEnum(['oneClick', 'mailto', 'link', 'none']),
      url: z.optional(line(2_000)),
    }),
  },
  'Unsubscribe/run': {
    summary:
      "Unsubscribe (today's `thread.unsubscribe`): one-click POST or mailto where offered, else an https link to review.",
    kind: 'command',
    scope: 'send',
    audit: true,
    input: z.object({ opId: OpId, threadId: Id }),
    output: z.object({
      /**
       * - `done`: the request was accepted (a one-click 2xx) or the unsubscribe email was queued.
       * - `openLink`: show `url` for the owner to review.
       * - `unavailable`: the sender offers no usable way.
       * - `unsure`: the request was sent but the sender's answer did not confirm it; say so, never claim success.
       * - `failed`: the sender refused or the request could not be made; the owner is not unsubscribed.
       * - `compose`: a mailto needs a message the owner must review and send; open the composer with `url`.
       */
      outcome: openEnum(['done', 'openLink', 'unavailable', 'unsure', 'failed', 'compose']),
      url: z.optional(line(2_000)),
      message: z.string(),
      receipt: z.optional(Receipt),
    }),
  },
});
