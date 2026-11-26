# The old providers, kept at `legacy-final`

Job 3 deleted the old engine and its provider adapters. Their last version is the tag `legacy-final` (commit `29c7838b`). Read a file there with `git show legacy-final:<path>`. Every path below was checked at that tag.

Shared by all four: the provider contract `packages/engine/src/legacy/provider.ts` and the service that drove the adapters, `packages/engine/src/legacy/service.ts`. Account setup by address (MX over DNS-over-HTTPS, autoconfig, ISPDB) is in `packages/engine/src/legacy/discover.ts` and `packages/engine/src/legacy/dns.ts`, tested in `apps/desktop/tests/discover.test.ts`.

None of these adapters ever connected to a real mailbox. TODO.md M28 says "verified against fake servers only" and PROGRESS.md (2026-10-16) lists live Outlook, iCloud and Fastmail as unverified.

## Outlook and Microsoft 365 (Microsoft Graph)

- Adapter: `apps/desktop/src/main/microsoft.ts`
- Tests: `apps/desktop/tests/microsoft.test.ts`

What worked: browser sign-in with PKCE and a loopback redirect (no client secret), and Done or Later moving mail to the Archive folder. Its tests ran against a fake Graph server. The loopback emulator (M32) also ran it through OAuth/PKCE, token refresh and rotation, and initial and incremental mail. A review fixed its cursor saves, resends and HTTPS checks, each with a regression test. Only tested against fakes: everything. No Aplos Microsoft client ID existed, so it never signed in to Microsoft.

## iCloud and other IMAP/SMTP hosts (Yahoo, AOL, generic)

- Adapter: `apps/desktop/src/main/imap.ts`, `apps/desktop/src/main/imap-index.ts`, `apps/desktop/src/main/imap-session.ts` (the `ImapSession` boundary over imapflow; nodemailer sends)
- Tests: `apps/desktop/tests/imap.test.ts`, `apps/desktop/tests/imap-session.test.ts`

What worked: app-password sign-in, UIDVALIDITY checks, no unsafe EXPUNGE, and Archive moves. All of this ran against a fake IMAP/SMTP server. The one live result: discovery over live DNS chose the iCloud preset for an icloud.com address, and the packaged app rendered the iCloud credential step. Only tested against fakes: sign-in, sync, flags and sending. No real iCloud, Yahoo or AOL mailbox was ever connected.

## Fastmail (JMAP)

- Adapter: `apps/desktop/src/main/jmap.ts`
- Tests: `apps/desktop/tests/jmap.test.ts`

What worked: API-token sign-in, sync and sending against a fake JMAP server. Live DNS discovery found the JMAP session URL for a fastmail.com address. Calendar was never connected for Fastmail. Only tested against fakes: everything except discovery. No real Fastmail account was used.

## Calendars over CalDAV (iCloud and generic)

- Backend: `apps/desktop/src/main/caldav.ts`, with the original iCalendar parser `apps/desktop/src/main/ical.ts`
- Tests: `apps/desktop/tests/caldav.test.ts`

What worked: calendar reads and single-event changes with ETag protection across restarts, against a fake CalDAV server. Recurring events and meetings were read-only. Only tested against fakes: everything. No real iCloud or other CalDAV calendar was used.
