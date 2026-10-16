# Mobile portability spike (M30)

Question: can an iOS/Android app reuse the Aplos mail engine, with no server, the way the desktop app does?

## What was checked (2026-10-16)

- `src/engine` (store, merge rules, sync gate, provider contract, address discovery, DNS checker) bundles with esbuild for `platform: 'neutral'`. That build has no Node or Electron modules and no CommonJS `require`, and is about 93 KB minified, `fast-xml-parser` included. `tests/portability.test.ts` keeps it that way: adding a Node import to the engine fails `npm test`.
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
| Service orchestration (`main/service.ts`) | Not yet in the engine | M26 moves it into `src/engine` with paged queries and change events. The remaining Node uses are `node:crypto` `randomUUID` and `Buffer` for attachment sizes; both have direct web equivalents. |
| Groq AI | Portable | HTTPS `fetch`. The key must stay off the device or be user-supplied: a mobile app cannot keep a shared key secret. |

## Recommendation

A React Native app can share the engine and the HTTPS adapters as-is, once the injected platform pieces are filled in: SQLite, keychain, OAuth sheet, crypto and a URL polyfill. IMAP is the only adapter that needs a native socket layer. Do M26 first, so the orchestration lives in the platform-free engine, then build the mobile shell against that boundary.

Not done in this spike: a running React Native app, on-device SQLite/FTS5 checks, background fetch limits (iOS gives apps short, infrequent background windows, so push via provider webhooks or a silent-push service would be needed for timely mail without a server of our own), and app-store review of mail-access scopes.
