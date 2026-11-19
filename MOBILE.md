# Mobile portability spike (M30)

Paths below are relative to `apps/desktop` since the repo became a monorepo.

Question: can an iOS/Android app reuse the Aplos mail engine, with no server, the way the desktop app does?

## What was checked (2026-10-16)

- `packages/engine/src` (today's engine in `legacy/`: store, merge rules, sync gate, provider contract, address discovery, DNS checker) bundles with esbuild for `platform: 'neutral'`. That build has no Node or Electron modules and no CommonJS `require`, and is about 93 KB minified, `fast-xml-parser` included. `packages/engine/tests/portability.test.ts` keeps it that way: it walks every subfolder, and adding a Node import anywhere in the engine fails `npm test`.
- The bundle loads and runs in plain JavaScriptCore (macOS `jsc -m`, the engine iOS uses under React Native's JSC mode). The merge rules, sync gate, known-domain lookup, autoconfig parsing and full-text query building all gave the same results as under Node.
- Bare JavaScriptCore has no `URL`, `URLSearchParams`, `fetch` or `AbortSignal`, so converting non-ASCII domain names to ASCII returned "not a domain", and DNS lookups need a fetch. React Native and Hermes provide `fetch` and `AbortController`. Their built-in `URL` is incomplete, so a mobile build needs `react-native-url-polyfill` (or a small punycode function in `dns.ts`).

## What carries over, and what does not

| Piece | Mobile status | Work needed |
|---|---|---|
| Store (`engine/store.ts`) | Portable | Back `SqlDatabase` with a synchronous SQLite binding (op-sqlite, or expo-sqlite's `*Sync` calls). FTS5 must be compiled in; op-sqlite enables it, and the expo-sqlite default build may not. |
| Merge, gate, provider contract | Portable | None. |
| Discovery and DNS checker | Portable | URL polyfill, as above. |
| Gmail, Outlook (Graph), JMAP, CalDAV adapters | Mostly portable: all plain HTTPS `fetch` | Replace the loopback `node:http` OAuth redirect with the system sign-in sheet (ASWebAuthenticationSession on iOS, Custom Tabs on Android) and a custom-scheme or claimed-https redirect. Use WebCrypto for PKCE hashes and `crypto.randomUUID` (a polyfill on Hermes). Use the platform keychain instead of Electron safeStorage. |
| IMAP/SMTP adapter (iCloud, Yahoo, AOL, generic) | Not portable as is | imapflow and nodemailer need Node `net`/`tls` sockets. Options: a TLS socket native module (react-native-tcp-socket) behind the existing `ImapSession`/`SmtpSender` interfaces, or native IMAP libraries (MailCore2) behind the same interfaces. The `ImapSession` boundary in `src/main/imap-session.ts` already isolates this. |
| Service orchestration (`engine/service.ts`) | Portable, including paged reads, change events, queued writes, drafts, reminders and sends | Supply the interfaces in `engine/ports.ts`: SQL-backed service store, async-scoped staged memory, providers, Groq, encrypted workflow transport, UUIDs and optional system services. `main/service.ts` is now only the desktop composition root. |
| Groq AI | Portable | HTTPS `fetch`. The key must stay off the device or be user-supplied: a mobile app cannot keep a shared key secret. |

## Recommendation

A React Native app can share the engine after supplying SQLite, keychain, OAuth, crypto, URL support and the host interfaces above. HTTPS adapters still need their desktop OAuth/credential dependencies replaced; IMAP additionally needs native sockets. Staged provider memory must preserve scope across overlapping async operations; a shared global “current stage” would break atomic sync. The desktop implements that interface with AsyncLocalStorage. Native symbols are optional and fall back to vectors.

The completion audit extended the portability test (now `packages/engine/tests/portability.test.ts`, with the orchestration run in `apps/desktop/tests/engine-host.test.ts`) to include the actual orchestration: the entire engine (11 modules, 146,544 minified bytes) bundles without Node imports, typechecks with browser libraries and `types:[]`, and runs mail operations in a restricted VM without `process`, `Buffer` or `require`, using browser-style numeric timer IDs. The original demo data is also platform-free. These checks establish the shared boundary; they do not constitute an iOS/Android app or on-device acceptance.

Not done in this spike: a running React Native app, on-device SQLite/FTS5 checks, background fetch limits (iOS gives apps short, infrequent background windows, so push via provider webhooks or a silent-push service would be needed for timely mail without a server of our own), and app-store review of mail-access scopes.
