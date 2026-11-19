# Aplos Mail revamp research: index

## In plain English

This folder holds the research for the Aplos Mail revamp. Aplos is a fast, keyboard-first mail and calendar app for the Mac.

The research studies other mail apps. It looks at how they are built, how they look and feel, and how they connect to mail accounts. It also checks Aplos itself.

It answers four main questions. How should the app's core be organized? How should it look and move? Which features are missing? Why did the first real Gmail sync fail? The likely answer is Google's new request limits.

This folder is not a set of decisions. The decisions built on it live in `../plans/`. Start at `../plans/README.md`.

Every other product here is studied for learning only. Aplos never copies their code, images, brand or wording.

## Start here

- [email-clients/SYNTH-architecture.md](email-clients/SYNTH-architecture.md): the ten findings that should shape the architecture plans, starting with the Gmail quota.
- [email-clients/SYNTH-ui.md](email-clients/SYNTH-ui.md): the proposed "Airmail" look, the motion system, and the screen-by-screen revamp list. The name was dropped: "Airmail" is a trademarked mail client. The final design is "Skypaper"; see [../plans/DESIGN.md](../plans/DESIGN.md).
- [email-clients/SYNTH-features.md](email-clients/SYNTH-features.md): the feature comparison across the researched clients, with the three camps and the gaps Aplos must close.
- [email-clients/protocols/proto-google.md](email-clients/protocols/proto-google.md): Gmail, Calendar and OAuth; finds the Gmail quota change that most likely caused the 403.
- [inbox-zero/SYNTHESIS.md](inbox-zero/SYNTHESIS.md): the council verdict comparing Aplos with Inbox Zero; Aplos has never synced a real mailbox, so the next 30 days are about one real sync.

## email-clients/ (synthesis files)

- [SYNTH-architecture.md](email-clients/SYNTH-architecture.md): cross-project architecture synthesis from 18 audits. Key finding: Google's quota makes the current first sync impossible, since it needs about 60,000 units.
- [SYNTH-ui.md](email-clients/SYNTH-ui.md): synthesis of six UI studies against the Aplos v0.2.3 baseline. Key finding: the best apps feel great mostly because input never waits for animation.
- [SYNTH-features.md](email-clients/SYNTH-features.md): feature matrix of end-user clients and engines. Key finding: Aplos is in the 2026 local-first camp, where the first client to be reliable is likely to win.

## inbox-zero/

- [SYNTHESIS.md](inbox-zero/SYNTHESIS.md): council synthesis of Aplos against Inbox Zero. Key finding: the verdict is unanimous that Aplos is not competing yet.
- [aplos-architecture.md](inbox-zero/aplos-architecture.md): critical audit of Aplos at v0.2.3. Key finding: the whole mailbox is one in-memory object, and the Gmail first sync is all-or-nothing.
- [aplos-product.md](inbox-zero/aplos-product.md): product inventory of Aplos with maturity labels. Key finding: no live mail provider has ever been verified.
- [inbox-zero-architecture.md](inbox-zero/inbox-zero-architecture.md): audit of Inbox Zero's server monolith and its local-first client. Key finding: it is really two products in one repo.
- [inbox-zero-product.md](inbox-zero/inbox-zero-product.md): product research on Inbox Zero's positioning, pricing and platforms. Key finding: the assistant and the Inbox Zero Mail client are two products under one brand.
- [council/council-opus.md](inbox-zero/council/council-opus.md): Claude Opus council answer. Key finding: no outside person can download, sign in or receive updates, and the one live Gmail sync failed.
- [council/council-kimi-k3.md](inbox-zero/council/council-kimi-k3.md): Kimi K3 council answer. Key finding: Aplos is a prototype that has never read a real email from any provider.
- [council/council-glm-5.3.md](inbox-zero/council/council-glm-5.3.md): GLM-5.3 council answer. Key finding: Aplos is roughly where Inbox Zero was in month one, except pre-launch, unverified and unobservable.
- [council/council-deepseek-v4-pro.md](inbox-zero/council/council-deepseek-v4-pro.md): DeepSeek V4 Pro council answer. Key finding: the core loop has never worked against a real mailbox.

## email-clients/arch/

- [deltachat-core.md](email-clients/arch/deltachat-core.md): Delta Chat core audit. Key finding: the brief's premise is out of date, since OAuth2 support was removed in 2.56.0.
- [emailengine.md](email-clients/arch/emailengine.md): EmailEngine audit, a commercial self-hosted gateway. Key finding: very mature and very active, but source-available under a commercial license.
- [extra-bulwark-legacy-proxy.md](email-clients/arch/extra-bulwark-legacy-proxy.md): Bulwark legacy-proxy audit, a JMAP-over-IMAP gateway. Key finding: the Gmail REST backend is the most useful part, and it is still pre-1.0.
- [extra-comail.md](email-clients/arch/extra-comail.md): comail audit, a keyboard-first offline Tauri client. Key finding: drafts are local-only, and labels go up as IMAP keywords, not real Gmail labels.
- [extra-flectar-mail.md](email-clients/arch/extra-flectar-mail.md): Flectar Mail audit, a native Rust client. Key finding: it is prerelease-only, is effectively one author, and has effectively no logging or crash reporting.
- [extra-parula-mustang.md](email-clients/arch/extra-parula-mustang.md): Parula/Mustang audit, an Electron and Capacitor client. Key finding: its IMAP and JMAP core is mature, but its local search uses LIKE with no full-text index.
- [extra-velo.md](email-clients/arch/extra-velo.md): Velo audit, a Tauri client built in about 2.5 weeks. Key finding: the service-layer-in-the-UI shortcut ships features fast, then stalls on concurrency and reliability.
- [geary.md](email-clients/arch/geary.md): Geary audit, the GNOME IMAP client. Key finding: its storage and sync model is the right one for Aplos's IMAP, iCloud and Fastmail wedge, but it has been at 46.0 since 2024.
- [inbox-zero-client.md](email-clients/arch/inbox-zero-client.md): sync, storage and topology audit of Inbox Zero Mail. Key finding: the client is about one month old, and sync correctness fixes are still landing.
- [mailspring.md](email-clients/arch/mailspring.md): Mailspring and Mailspring-Sync audit. Key finding: the account backend at id.getmailspring.com is not open source, and the client shipped five releases in five weeks.
- [nylas-sync-engine.md](email-clients/arch/nylas-sync-engine.md): Nylas sync engine audit. Key finding: it is archived, its last code release was in 2017, and it is a design document, not a usable dependency.
- [pimalaya.md](email-clients/arch/pimalaya.md): Pimalaya audit covering email-lib v1, Himalaya v2 and Neverest. Key finding: the unified backend trait was dropped in v2 as a maintenance tax.
- [redakt.md](email-clients/arch/redakt.md): Redakt audit, a server-hosted web mail app. Key finding: Gmail stays the source of truth, and there have been no commits since 2026-09-28.
- [stalwart.md](email-clients/arch/stalwart.md): Stalwart audit, a Rust mail server. Key finding: one maintainer wrote 94% of contributions, and the project is pre-1.0 at v0.16.27.
- [superlocal.md](email-clients/arch/superlocal.md): Superlocal audit, a local host with a browser UI and no license. Key finding: it has been idle since 2026-09-08, and its ideas are usable only as engineering ideas.
- [tuta-desktop.md](email-clients/arch/tuta-desktop.md): Tuta desktop audit, an Electron wrapper for Tuta's encrypted web app. Key finding: its offline data is a partial replica tracked by ranges, kept in encrypted SQLite.
- [zero.md](email-clients/arch/zero.md): Zero (0.email) audit, one Cloudflare Durable Object per mailbox. Key finding: its newest sync design is good on paper, but it stores Gmail tokens in plaintext.

## email-clients/ui/

- [aplos-baseline.md](email-clients/ui/aplos-baseline.md): audit of the Aplos v0.2.3 UI. Key finding: it looks like a careful, restrained macOS utility, but no view has a title and every control has key-cap noise.
- [avec.md](email-clients/ui/avec.md): Avec UI, motion and feel. Key finding: the done email is tossed away like a physical card, and Aplos chose to differ by making the AI summary the main line.
- [inbox-zero-mail.md](email-clients/ui/inbox-zero-mail.md): Inbox Zero Mail UI and motion. Key finding: input never waits for animation; focus moves in the same frame as an archive.
- [redakt.md](email-clients/ui/redakt.md): Redakt UI and motion. Key finding: it is calm, serious and quiet, but its list is a plain Gmail one-liner with no summary.
- [superlocal.md](email-clients/ui/superlocal.md): Superlocal UI and motion. Key finding: useful for how a list holds still, but its visuals copy another product, so they must not be borrowed.
- [tatem.md](email-clients/ui/tatem.md): Tatem UI and motion. Key finding: it animates nothing in the list, and it is probably unmaintained after a reported acqui-hire.
- [zero.md](email-clients/ui/zero.md): Zero UI and motion. Key finding: a dark, dense, developer-flavoured Gmail client whose marketing lags the product by more than a year.

## email-clients/protocols/

- [proto-google.md](email-clients/protocols/proto-google.md): Gmail, Calendar, OAuth and verification. Key finding: Google's 1 May 2026 quota change almost certainly explains the 403s.
- [proto-others.md](email-clients/protocols/proto-others.md): Microsoft Graph, IMAP, JMAP, CalDAV and iCloud. Key finding: Outlook's concurrency limit will likely fail the first real sync, because every 429 fails the whole run.

## email-clients/gaps/

- [electron-email-html-isolation.md](email-clients/gaps/electron-email-html-isolation.md): isolating email HTML in Electron 44. Key finding: there is no script-free way to measure the height of a cross-origin iframe.
- [engine-contract-rpc-stack.md](email-clients/gaps/engine-contract-rpc-stack.md): engine contract and RPC stack. Key finding: the recommended contract pushes IDs only, not full snapshots.
- [identity-collision-audit.md](email-clients/gaps/identity-collision-audit.md): collision check on the proposed "Airmail" direction. Key finding: the name is the real collision, since Airmail is a well-known Mac and iOS mail client.
- [macos-daemon-lifecycle.md](email-clients/gaps/macos-daemon-lifecycle.md): resident utilityProcess versus a SMAppService LaunchAgent. Key finding: the daemon should not be Electron, and the LaunchAgent path is blocked on Developer ID signing.
- [phone-mac-connectivity.md](email-clients/gaps/phone-mac-connectivity.md): how a phone reaches the Mac engine. Key finding: "No project serves a phone from a desktop daemon" is false outside email.
- [storage-engine-benchmark.md](email-clients/gaps/storage-engine-benchmark.md): storage engine benchmark at 100k to 1M messages. Key finding: the schema holds at 1M messages, and full-text indexing is about 80% of write cost.

## Top-level files

- [pr21-onboarding-review.md](pr21-onboarding-review.md): review of PR #21, the onboarding window and first-sync loading screen. Key finding: closing the onboarding window at the wrong moment can stop AI triage for an account until restart; not fixed yet.

## Screenshots and source clones

Screenshots and source clones are kept outside the repo at `/Users/knewton/.t3/aplos-research/`. The `ui/` folder holds screenshots and the `src/` folder holds clones. They are not committed, because of their size and third-party content.

## Use and licensing

The research describes other products for learning only. Aplos must never copy their code, assets, branding or wording.
