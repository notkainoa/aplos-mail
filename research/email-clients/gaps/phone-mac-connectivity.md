# How a phone reaches the Mac engine, and the serverless options for cross-device work

2026-10-25. This is gap research for `SYNTH-architecture.md` §2, §4.3, §8, §10, §11 (candidates A2, C and D) and §13. The synthesis drew three conclusions from 20 email projects. This report checks them against non-email precedents and against Apple, Google and Microsoft documentation.

**Labels.** **[V]** means I verified the claim myself, in cloned source (path and commit given) or in official docs (URL given). **[V-3p]** means a third-party source supports it but Apple or the vendor hasn't confirmed it. **[I]** means inference.

**Clones** (read only, nothing run; under `/Users/knewton/.t3/aplos-research/src/`): slopus-happy `5aa9780` (MIT), pingdotgg-t3code `7bafc40c` (MIT), anomalyco-opencode `1743d1a` (MIT), syncthing-syncthing `a4a2da4` (MPL-2.0), KDE-kdeconnect-kde `4a28f12` (GPL-2.0+/LGPL), KDE-kdeconnect-ios `5d8bb8b` (GPL-3.0 with an App Store non-enforcement note), home-assistant-iOS `98dc064` (Apache-2.0), n0-computer-iroh `cf0d2b0` (MIT/Apache-2.0), tailscale-libtailscale `d1dc45d` (BSD-3-Clause), apple-mDNSResponder `d4658af` (Apache-2.0). I also re-read `deltachat-core` (MPL-2.0) from the earlier corpus. No code is copied here.

---

## 0. Bottom line

1. **"No project serves a phone from a desktop daemon" is false outside email.** [V] Several projects have a phone talk to a process on the user's own machine: T3 Code (LAN, Tailscale, or its own tunnel), Happy (an end-to-end-encrypted relay), KDE Connect (LAN only) and Home Assistant (a self-hosted box). T3 Code is the closest match to Aplos: a TypeScript engine-as-server, an iOS app, QR pairing and scoped per-device sessions. The precedent for A2 goes from **none** to **medium-high**. Within email the claim still holds.
2. **"iOS push needs a server-held APNs key" is only partly true.** Three paths need no Aplos-run server:
   - **CloudKit subscriptions.** Apple's servers send the push. You need a Developer ID provisioning profile on the Mac.
   - **Local Push Connectivity.** No APNs at all, but it only works on named Wi-Fi networks and needs a restricted entitlement.
   - **A third-party broker such as Expo.** Expo holds the key, so it is not Aplos's server, but it is still somebody's.

   What still needs a server: anything that originates at Gmail or Graph while no Aplos device is awake to see it.
3. **"A sleeping Mac is the ceiling" holds for live access.** Wake on Demand works only on the LAN, needs an Apple TV, HomePod or AirPort acting as sleep proxy, and is unreliable over Wi-Fi. Apple removed its own off-LAN equivalent (Back to My Mac) in 2018. Every desktop-host precedent tells users to keep the host awake. CloudKit softens the ceiling into store-and-forward: while the Mac sleeps, the phone can read the last snapshot the Mac wrote and queue commands for it to run on wake.
4. **Quota.** Gmail's per-user limit is **per user per project**. Graph's is **per app ID and mailbox**. Both are verified below. A thin A2 phone uses no provider quota at all, which is A2's real advantage over D.

**Recommendation (§7):** a T3-Code-style A2 phone over LAN plus Tailscale, with CloudKit as the serverless glue once Aplos has a Developer ID. Defer C and D until the owner wants phone alerts while the Mac sleeps.

---

## 1. Non-email precedents: a phone talking to the user's own machine

### 1.1 T3 Code (MIT): the closest analogue

**Shape.** A server (`apps/server`) runs on the user's machine. Desktop, web and an Expo iOS/Android app (`apps/mobile`) are all clients of it. Each client keeps one connection owner per environment (`packages/client-runtime`, described in `docs/internals/connection-runtime.md`). [V]

**Routes.** Per `docs/user/remote-access.md` [V]:
- **Direct LAN or private-network pairing.** `t3 pair` prints a QR code or URL holding a one-time link.
- **Tailscale HTTPS.** Implemented by shelling out to the `tailscale` CLI (`packages/tailscale/src/tailscale.ts`), so it needs Tailscale on both devices.
- **T3 Connect.** A Cloudflare Tunnel per environment, run by a pinned `cloudflared`, plus a relay on Cloudflare Workers that handles identity and minting credentials (`docs/internals/t3-connect.md`, `infra/relay/`).
- **SSH.**

A machine can have several routes. The client tries them in order, re-probes earlier ones every minute and on network changes, and learns the machine's current LAN and Tailscale addresses while connected.

**Pairing and auth** (`docs/internals/environment-auth.md`) [V]:
- A pairing link delegates scopes, and redeeming it can only narrow them.
- Tokens are bound to a DPoP key. WebSocket tickets are short-lived and proof-bound, "so a ticket captured on a plain HTTP LAN route is useless without the key".
- Each device's session can be revoked from Settings or with `t3 auth session revoke`.
- The read model never exposes pairing secrets.

**Transport security.** On the LAN, plain HTTP is allowed: the iOS app sets `NSAllowsArbitraryLoads: true` and declares `NSLocalNetworkUsageDescription` (`apps/mobile/app.config.ts` ~L257-261), with no Bonjour; the user scans or pastes an address. DPoP protects credentials, not content. [V] T3 Connect is not end-to-end encrypted against Cloudflare, whose edge serves the tunnel hostname. [I]

**Push.** Notifications arrive in the background only through T3 Connect: the relay holds the APNs and FCM credentials (`infra/relay/src/agentActivity/ApnsClient.ts`, `FcmClient.ts`). The payloads carry truncated plaintext summaries (`agentActivityPayloads.ts`, a 120-character summary). `docs/user/mobile-notifications.md` [V] says plainly that a direct or Tailscale connection alone does not give push.

**Host asleep.** `docs/user/background-service.md` [V] says: "Keep the Mac logged in and awake for unattended remote access." The service is a LaunchAgent in `~/Library/LaunchAgents`. The relay reaps tunnels that have been offline for 5 minutes or more and re-provisions them when the host wakes.

**Lesson for Aplos.** A2 is buildable. Use multiple routes, scoped revocable per-device sessions and proof-bound tokens. Getting push takes a hosted relay, which is exactly candidate C.

### 1.2 Happy (MIT): phone to desktop daemon over an end-to-end-encrypted relay

**Transport.** Everything goes through the hosted `happy-server` (Socket.IO at `/v1/updates`). It forwards phone-to-daemon RPC by room membership (`docs/realtime-sync-and-rpc.md`) and **stores** client-encrypted blobs (XSalsa20-Poly1305, or AES-256-GCM with a `box`-wrapped data key) in Postgres (`docs/encryption.md`). There is no LAN or peer-to-peer path; a self-host package exists (`packages/happy-server-self-host`). [V]

**Pairing.** The CLI shows a QR code holding an ephemeral NaCl public key. The signed-in phone encrypts the account secret to that key and posts it, and the CLI polls and decrypts (`packages/happy-cli/src/ui/auth.ts` L27-240). The server sees only ciphertext. [V] Every device then holds the same secret, and I found no per-device revocation. [I]

**Push.** The desktop CLI itself calls Expo's push API (`packages/happy-cli/src/api/pushNotifications.ts`), and so does the server (`packages/happy-server/sources/app/push/pushSend.ts`). Expo holds the APNs key. [V] Expo's docs say tokens work without an access token unless "enhanced security" is turned on (docs.expo.dev/push-notifications/sending-notifications). [V]

**Liveness.** The server marks machines inactive after 10 minutes of silence (`docs/backend-architecture.md` ~L251). [V]

**Host asleep.** The daemon runs `caffeinate -im` (`packages/happy-cli/src/utils/caffeinate.ts`). That prevents idle sleep only. [I: closing the lid on battery still sleeps the Mac.]

**Lesson for Aplos.** A desktop process can send iOS pushes with no Aplos server if a broker holds the key, but the broker then sees the payload unless it is encrypted and decrypted by a Notification Service Extension. Happy's relay stores data, so it is not the stateless relay DECISIONS describes.

### 1.3 OpenCode (MIT)

`opencode serve` binds to `127.0.0.1` by default (`packages/cli/src/server-process.ts` ~L72). Auth is an optional HTTP Basic password (`OPENCODE_SERVER_PASSWORD`). A pairing code (16 random bytes, valid 5 minutes, `packages/server/src/pairing.ts`) redeems for a 30-day HMAC token keyed from that password (`packages/server/src/auth.ts`), so rotating the password is the only revocation and it is all-or-nothing. The docs list `--mdns`, but I found it only in a v1 config fixture. There is no TLS, relay or push. [V] Issue opencode#58080 reports that macOS Local Network Privacy blocked its background service until it shipped as a signed `.app` [V-3p], which bears directly on Aplos's A1 LaunchAgent (§2.1). **Lesson:** a shared password is the weakest model here; copy T3's per-device sessions instead.

### 1.4 Syncthing (MPL-2.0)

A device ID is the SHA-256 of its TLS certificate (`lib/protocol/deviceid.go` L46-47). Connections are mutual TLS, checked against config (`lib/connections/service.go` L264-331). Pairing exchanges IDs (by QR code on Android) and both sides accept; revocation removes the device. Discovery uses a client-certificate-authenticated HTTPS announce every 30 minutes (`lib/discover/doc.go`, `global.go` L58) plus multicast. NAT traversal uses UPnP/NAT-PMP and QUIC with STUN. Relays are volunteer-run, and TLS runs end to end **over** the relayed stream (`lib/connections/relay_dial.go` L52-59), so relays see only ciphertext. Reconnect is every 20 s (`lib/config/optionsconfiguration.go` L31). [V] There is no wake mechanism and no official iOS client. [I]

**Lesson for Aplos.** "Identity = certificate fingerprint, relay = dumb pipe under end-to-end TLS" is the cleanest way to pin a relay-capable link.

### 1.5 KDE Connect (desktop GPL/LGPL; iOS GPL-3.0)

**Discovery.** UDP broadcast on port 1716 plus mDNS (`core/backends/lan/lanlinkprovider.cpp` L62-206). [V]

**TLS and pairing** [V]:
- Certificates are self-signed. Unpaired peers are accepted with `QueryPeer`.
- Paired peers are pinned: their stored certificate becomes the only CA, with `VerifyPeer` (L634-645).
- Users compare an 8-hex verification key. It is the SHA-256 of both public keys plus a pairing timestamp (`core/backends/pairinghandler.cpp` L188-208), with a 30-minute timestamp skew allowance.

**The iOS app** [V]:
- Holds `com.apple.developer.networking.multicast` (`KDE Connect/KDE Connect.entitlements`).
- Declares `NSBonjourServices = _kdeconnect._udp` and `NSLocalNetworkUsageDescription` (`Info.plist` L31-36).
- Browses with `NWBrowser` (`.../lanBackend/MdnsDiscovery.swift`).
- Its README says the app being "unresponsive in the background is more or less intended".

**Lesson for Aplos.** There is a shipped App Store pattern for LAN pairing with a short authentication string and certificate pinning. It also confirms that the phone side works in the foreground only.

### 1.6 Home Assistant companion (Apache-2.0)

**URL selection.** An internal, external or Nabu Casa remote-UI URL is chosen by the current Wi-Fi SSID or hardware address (`Sources/HANetworking/Sources/ConnectionInfo.swift`). [V]

**Local push without APNs.** `Sources/Extensions/PushProvider/PushProvider.swift` subclasses `NEAppPushProvider` and holds a WebSocket to the home server while the phone is on a configured SSID (`matchSSIDs`, in `NotificationManagerLocalPushInterfaceExtension.swift`). The entitlement is added only when `ENABLE_PUSH_PROVIDER` is set (`Configuration/Entitlements/activate_special_entitlements.sh`), which fits Apple's statement that it is restricted and must be requested for both app and extension (WWDC20 session 10113). [V]

**Remote push.** HA runs its own push server (`Sources/PushServer`, a Vapor app on Fly.io). It accepts end-to-end-encrypted payloads (`Models/PushSendInput.swift` L34-53) and caps each device at 1,000 pushes a day (`RateLimits/RateLimits.swift` L10). [V]

**Lesson for Aplos.** This is the most complete model of reaching a home box. Local push gives **serverless alerts on home Wi-Fi**. Off the LAN, HA still runs a push server, which is candidate C.

### 1.7 Delta Chat and iroh (from the earlier corpus)

Delta Chat's second-device setup uses iroh. The QR code carries the provider's peer ID and an auth token, and the backup streams over QUIC (`deltachat-core/src/imex/transfer.rs` header; `Cargo.toml` L68-69). [V] That puts **iroh, with relays and QR authentication, inside an App Store app**. iroh dials by public key, hole-punches, and falls back to relays that carry only encrypted QUIC (`n0-computer-iroh/README.md`, `iroh-relay/README.md`). [V] The defaults point to n0's public relays (`iroh/src/defaults.rs` L27-33), and you can self-host a relay. [V]

### 1.8 Summary

| Project | Pairing | Transport | NAT / relay | End-to-end encryption | Revocation | Reconnect | Host asleep |
|---|---|---|---|---|---|---|---|
| T3 Code | QR one-time link with scopes | HTTP/WS; HTTPS via Tailscale or Cloudflare | Tailscale, CF Tunnel | WireGuard on Tailscale; **not** on LAN HTTP or CF | Per-device session | Ordered routes, re-probed every minute, jittered backoff capped at 5 min | "Keep the Mac awake" |
| Happy | QR with ephemeral box key | Socket.IO through a hosted relay | Relay | Yes (client crypto; the relay stores ciphertext) | None per device | Socket.IO; server-side grace period | `caffeinate -im` |
| OpenCode | 5-minute code → 30-day HMAC token | Plain HTTP | None | No | Rotate the password | n/a | n/a |
| Syncthing | Exchange device IDs | Mutual TLS over TCP/QUIC | UPnP, STUN, volunteer relays | Yes (TLS through the relay) | Remove the device | 20 s | Offline |
| KDE Connect | Compare SAS, pin the cert | TLS over TCP | None (LAN, Bluetooth) | Yes | Unpair | Rebroadcast on network change | Offline |
| Home Assistant | Login, then per-device webhook | HTTPS/WS | Nabu Casa remote UI | Yes for encrypted push | Server-side | URL switching by SSID | n/a (always-on host) |

---

## 2. Reachability under iOS constraints

### 2.1 LAN

**Local Network permission (iOS).**
- Bonjour browsing needs `NSBonjourServices` and `NSLocalNetworkUsageDescription` (KDE Connect `Info.plist`). [V]
- Raw multicast or broadcast needs `com.apple.developer.networking.multicast`, which Apple grants on request. KDE Connect has it. [V for its use; the request process is from TN3179, V-3p]
- Bonjour through `NWBrowser` does not need the multicast entitlement. [V-3p, TN3179]
- T3 Code avoids Bonjour entirely and has the user scan an address. [V]

**Local Network permission (macOS 15+).**
- Apps and **launch agents** must ask the first time. Launchd daemons running as root are exempt (Apple wording quoted in reports on TN3179). [V-3p]
- Ad-hoc-signed code "cannot be tracked reliably", so the prompt can come back after every update. [V-3p]
- Aplos currently ships ad-hoc builds (`apps/desktop/scripts/release-build.mjs` L20-27; DECISIONS L30). [V] So an A1 LaunchAgent helper on an ad-hoc build is likely to hit repeated prompts or silent LAN blocks, as OpenCode#58080 did. [I]

**TLS without a certificate authority.**
- *Pinning a self-signed certificate.* Put the fingerprint in the pairing QR code (KDE Connect and Syncthing pin by fingerprint). [V]
- *TLS-PSK.* Apple's TicTacToe sample derives a PSK from a typed passcode and uses `TLS_PSK_WITH_AES_128_GCM_SHA256` through `sec_protocol_options_add_pre_shared_key`. DTS notes that PSK needs TLS 1.2, and that a 4-digit passcode can be brute-forced (developer.apple.com/forums/thread/745186). [V-3p]

  For Aplos, a QR code carrying a 256-bit PSK or the certificate fingerprint avoids the brute-force problem. Node's `tls` module supports PSK (`pskCallback`), and so does Network.framework. [I]

### 2.2 Tailscale overlay

- **The zero-code route:** the user runs the Tailscale app on both devices, and Aplos listens on the tailnet interface. The owner already does this. Needs nothing from the App Store. [I]
- **The embedded route:** libtailscale/TailscaleKit (**BSD-3**) builds a userspace tsnet node into the app. That means no NetworkExtension entitlement and no VPN profile. Its README calls the iOS framework "suitable for app-store submissions" (`swift/README.md`). [V]

  Caveats, all third-party [V-3p]:
  - Adds about 20-25 MB per slice.
  - The Swift layer's outbound connection is write-only and needs iOS 18.1 or later.
  - The repo has no releases.
  - Each embedded node needs interactive tailnet sign-in or an auth key.
  - Tunnelless is a reference app for this approach that claims it can pass App Store review.

  On the Mac, tsnet would be a Go c-archive linked into a helper. [I]
- **Neither route wakes a sleeping Mac.** [I]

### 2.3 Peer to peer

- **iroh:** QUIC, dial by key, relay fallback, MIT/Apache-2.0. Delta Chat ships it in an App Store app (§1.7). [V] Aplos's engine is TypeScript, so the Mac side would need a Rust sidecar or a napi binding. [I]
- **WebRTC data channels** need signalling. That could be CloudKit records or the existing encrypted Gmail label, so it needs no server, but TURN is needed behind symmetric NAT. [I]

### 2.4 A self-run end-to-end-encrypted relay

The minimal design follows Syncthing and iroh: identities pinned at pairing, a Noise (or libsodium box) session end to end, and a dumb byte pipe keyed by an opaque rendezvous ID. [I]

Hosting costs single-digit dollars a month at personal scale (a Worker plus a Durable Object, or a small VPS). [I] **Operational load** is the real cost. T3 Code's relay grew Clerk identity, tunnel reaping, generation locks and version pins (`docs/internals/t3-connect.md`, `docs/operations/relay-observability.md`). [V] Even a relay that stores nothing brings uptime, abuse handling, a privacy-label disclosure and the CASA question (DECISIONS L151). [I]

---

## 3. A sleeping Mac

**Wake on Demand ("Wake for network access").** Apple says the Mac wakes "when a user at another computer accesses the shared resources", and that Wi-Fi requires "an Apple wireless device that supports 802.11n" (support.apple.com/guide/mac-help/mh27905). [V] Apple's open-source mDNSResponder registers the sleeping host's multicast records with a Bonjour Sleep Proxy (`mDNSCore/mDNS.c`, `SendSPSRegistrationForOwner` ~L6794), and its filter `mDNSUpdateOkToSend` (~L6635) does not exclude third-party services. [V] So a Bonjour-advertised Aplos port should be proxied, with a TCP SYN to it triggering a wake. [I; Stuart Cheshire's "Understanding Sleep Proxy Service" describes the same.]

**What it needs.** A sleep-proxy device: Apple TV, HomePod, or the discontinued AirPort/Time Capsule. [V-3p: SleepProxyClient README; Apple's old HT3789] On this M1 MacBook Air, `pmset -g` shows `womp 1`, `powernap 1` and `tcpkeepalive 1`. [V] I could not observe `_sleep-proxy._udp` from this sandboxed session. Wake over Wi-Fi on Apple silicon laptops is reported as unreliable, and on battery the setting can be off. [V-3p]

**Off the LAN.** No wake. Back to My Mac, Apple's off-LAN reachability-and-wake service, was removed in macOS Mojave in 2018 (Apple's "Prepare for changes to Back to My Mac", reported by MacRumors, TidBITS and AppleInsider). [V-3p]

**Power Nap and DarkWake.** Apple documents Power Nap only for Apple services: Mail, Calendar, iCloud, and on power also updates and Time Machine (support.apple.com/guide/mac-help/mh40773). [V] There is no documented API for third-party work in DarkWake. [I] Aplos must not rely on it.

**Verdict.** At best, Wake on Demand is a **LAN-only bonus** for owners with an Apple TV or HomePod and a Mac on power. The ceiling stands for live A2.

---

## 4. Serverless push and sync through Apple

**Does a CloudKit subscription push need no APNs server of your own?** Yes. [V]
- A `CKDatabaseSubscription` (custom zones; private or shared databases) with `shouldSendContentAvailable` sends a silent push from Apple's servers.
- A `CKQuerySubscription` with `alertBody`/`title` plus `shouldSendMutableContent` sends a **visible** push that reaches a Notification Service Extension, which can fetch and decrypt the record before showing it. Do not combine alert fields with `content-available` (developer.apple.com/forums/thread/82074; the `shouldSendMutableContent` docs).
- **Silent-push budget:** Apple says "don't try to send more than two or three per hour", and delivery isn't guaranteed. DTS says low-priority background pushes may arrive "1 or 2 per hour across all apps, or none", and a force-quit app is not woken (forums thread 760244). [V-3p, quoting Apple]
- **BGAppRefresh** time is system-scheduled and short. [I] So timely phone alerts must be **visible** CloudKit pushes, not silent ones.

**Developer ID.** Allowed. Apple: Developer ID apps "can also take advantage of advanced capabilities such as CloudKit and push notifications". This requires a Developer ID provisioning profile, which is "evaluated... at every app launch", is valid for 18 years, and the app "will no longer launch" once it expires (developer.apple.com/support/developer-id). [V] Developer ID profiles use only the **Production** CloudKit environment. [V-3p]

**Electron.** A bare command-line tool with restricted entitlements is killed by AMFI; it must be wrapped in an app-like bundle with an embedded profile ("Signing a daemon with a restricted entitlement"; DTS threads 701272 and 791996). [V-3p, Apple docs and DTS] So the `aplos-symbols` CLI pattern (`scripts/build-main.mjs` L19-20) **cannot** host CloudKit as it is. The options are:
- (a) Give the main app the profile and call CloudKit from a native addon.
- (b) Ship a nested helper `.app` that shares the iCloud container.
- (c) Use CloudKit JS or Web Services. This is a fallback only. Private databases need an API token plus a `ckWebAuthToken` from Apple ID web sign-in [V-3p], and MistKit reports that ADP accounts never get that token (brightdigit/MistKit #486). [V-3p]

Electron's main process can already receive APNs on macOS (`pushNotifications.registerForAPNSNotifications`). [V] **The gating prerequisite:** Aplos has no Developer ID today (DECISIONS L29-32). [V] It is needed anyway for notarization and auto-update.

**Quotas and privacy** [V]:
- Private-database data "counts against their personal iCloud quota" (TN2241).
- Data is always encrypted in transit and at rest. It is end-to-end encrypted only for fields written through `encryptedValues`, and only when the user has Advanced Data Protection on. With ADP, encrypted fields and all assets are E2E (Apple Platform Security, "Advanced Data Protection"; support.apple.com/102651).
- Encrypted fields can't be indexed. [V-3p, apple/sample-cloudkit-encryption]

**Can CloudKit replace the hidden-label workflow sync (DECISIONS L173-181)?** Mostly yes, for Apple-only users. [I] It gains a per-device zone change token instead of re-reading and merging the whole log, spends no Gmail quota on `messages.insert`, leaves no copies in Trash, pushes between devices, and detects conflicts with record change tags instead of device clocks. It loses support for non-Apple devices and per-provider symmetry, and it needs iCloud plus a Developer ID. Keep the label transport behind the same port (MOBILE.md's "encrypted workflow transport") as a fallback.

**NSUbiquitousKeyValueStore** (1 MB total, 1,024 keys, 64-byte key names) [V, Apple's "Storing Preferences in iCloud"] is too small for the log. It fits pairing metadata, settings and the sync code.

**Local Push Connectivity** (§1.6) adds serverless alerts on configured home SSIDs. The entitlement is discretionary. [I: Apple framed it at WWDC20 for "restricted networks".]

---

## 5. Quota sharing (verified 2026-10-25)

- **Gmail** (developers.google.com/workspace/gmail/api/reference/quota, updated 2026-10-16) [V]:
  - The page reads "Per minute per user per project... 6,000 quota units", and "1,200,000" per project. It says nothing about OAuth clients.
  - So **a Mac engine and a phone engine in the same Cloud project share 6,000 units/min per user**, whatever their client IDs. [I from the wording]
  - A separate phone project gets its own budget, but needs its own verification and CASA work. [I]
  - Projects that used the API between November 2025 and April 2026 keep their earlier quotas.
- **Graph** (learn.microsoft.com/graph/throttling-limits, "Outlook service limits") [V]:
  - Limits apply "to each app ID and mailbox combination": 10,000 requests per 10 minutes, **four concurrent requests**, and 150 MB of uploads per 5 minutes.
  - A phone using the same app registration shares the 4 slots; a separate registration would not.
  - JSON batches run at most 4 at a time.
- **Effect on the choice:** A2's thin phone costs **zero** provider quota. D must coordinate a shared budget between devices, through CloudKit leases, for example. [I]

---

## 6. Options matrix

"Sleeps?" means: does the phone still work while the Mac sleeps? "Aplos server?" means: does it need a server Aplos runs?

| Option | Sleeps? | Aplos server? | iOS / App Store constraints | Security model | Effort beyond F + A0 [I] | Precedent |
|---|---|---|---|---|---|---|
| **A2 on the LAN** | No (Wake on Demand is a LAN-only bonus with an Apple TV or HomePod) | No | Local Network prompt; `NSBonjourServices` if browsing; foreground only; ATS exception or pinned TLS | QR pairing (cert fingerprint or 256-bit PSK); scoped, proof-bound per-device sessions; revocation list | 2-4 wk host + thin client (months) | **Medium-high**: T3 Code, KDE Connect, OpenCode |
| **A2 + overlay** (Tailscale app, or embedded TailscaleKit) | No | No (Tailscale's control plane and DERP) | App route: none. Embedded: +20-25 MB, young API, tailnet sign-in | WireGuard plus app-level pairing | ~0 (owner-only, via the app); 1-3 wk embedded | Medium: T3 Code (CLI), Tunnelless (3p) |
| **A2 + E2E relay** (Noise/libsodium, or iroh) | No (the Mac must answer) | Yes, stateless; or n0 public relays | None special; iroh is proven in Delta Chat | Keys pinned at pairing; relay sees ciphertext and metadata | 3-6 wk + ops | Medium: Happy (stateful), Syncthing, iroh/Delta Chat |
| **CloudKit-mediated** (snapshot + command mailbox + visible alerts) | Partly: phone reads the last snapshot and queues commands; no new mail | No (Apple's) | Developer ID + profile; native addon or helper `.app`; NSE on iOS; iCloud quota; ADP for E2E | Apple ID boundary; `encryptedValues` | 2-4 wk after Developer ID | Low-medium: CloudKit is proven, this pattern is not |
| **D + CloudKit push** | Yes, phone engine (BGAppRefresh polling; not timely for Gmail or Graph) | No | Phone OAuth, App Store review of mail scopes, native IMAP sockets (MOBILE.md) | Credentials on every device | Months + 2-4 wk | High that it works (5 email projects); low for shared Gmail quota |
| **C with an Aplos relay** (Pub/Sub, Graph webhooks, APNs) | Alerts yes; actions only with D | **Yes** | APNs key on the relay; CASA question | Relay sees mailbox IDs and timing; encrypt payloads (HA pattern) | 2-4 wk + ops | High: T3 Code, Home Assistant, Happy, Delta Chat |

## 7. Recommendation

1. **Now:** F plus A0. Design A0's auth for a phone from day one. Take from T3 Code: scoped per-device sessions, revocation, short-lived socket tickets, and DPoP-style key binding. Do not take OpenCode's shared password.
2. **Get a Developer ID first.** It unblocks CloudKit, stable Local Network grants, Keychain ACLs and updates.
3. **First phone: A2 over LAN plus the Tailscale app.**
   - Pair by QR code carrying the host certificate fingerprint and a one-time code.
   - Use multiple routes, as T3 Code does.
   - The phone stays thin: no OAuth, no AI keys, no quota.
4. **Add CloudKit as the serverless layer:**
   - Workflow sync (keep the label as a fallback).
   - Visible Mac-to-phone alerts through `CKQuerySubscription` plus an NSE that decrypts.
   - A command mailbox and snapshot for when the Mac is asleep.
5. **Only if the owner wants alerts while the Mac sleeps:** C, with end-to-end-encrypted payloads in the HA style, after the Google CASA conversation. Phone actions while the Mac sleeps would need D.

**Claims this report changes:**
- Synthesis §0.3 and §2, "no phone-to-desktop precedent": **overturned outside email.**
- §2 and §8, "iOS push needs a server-held APNs key": **narrowed.** Pushes the Mac originates can go through CloudKit (Apple's servers), Local Push (LAN) or Expo (a third party). Only events that originate at a provider while no device is awake need an Aplos relay.
- §0.8, "a sleeping Mac is the ceiling": **confirmed for live access, softened** by CloudKit store-and-forward and LAN Wake on Demand.
- §11.5's precedent rating for A2: "none" → **medium-high**.

## 8. Open questions

1. Does the owner's iCloud account have Advanced Data Protection on? It decides whether CloudKit is end-to-end encrypted and whether CloudKit JS can work at all.
2. Will Apple grant Aplos the Local Push (`app-push-provider`) entitlement?
3. Does a Bonjour-advertised Aplos port actually wake the owner's M1 Air on Wi-Fi through a HomePod or Apple TV? Test with `dns-sd -B _sleep-proxy._udp` on a real terminal.
4. Is mail metadata in the user's own iCloud acceptable under SPEC's "no Aplos server stores user data"? It is literally compliant, but it is a new place for the data to live.
