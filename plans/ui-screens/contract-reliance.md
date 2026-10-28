# Contract names the UI-screens lanes rely on

Written 2026-10-28 (day 2). Our four lanes build on the freeze candidate (PR #28 head 9ec6518 plus UI-core's `rv/ui-shell/contract-swap` at 1da5496). After `contract-v1` is tagged and restructure step 4 lands, each lane merges `revamp`, runs `npx tsc --noEmit -p apps/desktop`, and diffs this list against the frozen contract. Typecheck catches renamed types and fields. This list catches renamed method names, because some of those are plain strings in ports.

> **What this means:** After the freeze, a quick check shows which renames touch our screens.

### ui-onboard
- Types (contract or data layer): Account AiProvider ConnectFrame Consent Input Output ReasonCode Settings SetupAccount SetupStatus api getNow toIsoDateTime useAccounts useConsent useFrames useNow useSession useSettings useSetupStatus 
- Methods: Account/cancelConnect Account/connect Account/discover Account/reconnect Ai/models Ai/providers Ai/setKey Ai/testKey Consent/grant Notification/test Settings/set Setup/begin Setup/end System/login System/microphone System/notifications System/openSettings Window/finishOnboarding Window/openOnboarding 
- api.*: api.account.cancelConnect api.account.connect api.account.discover api.account.grantPermissions api.account.reconnect api.ai.models api.ai.providers api.ai.setKey api.ai.testKey api.consent.grant api.demo.load api.demo.remove api.demo.reset api.settings.set api.setup.begin api.setup.end 

### ui-calendar
- Types (contract or data layer): Calendar EpochMs Event EventChange EventFields HARNESS_NOW_MS Plan toIsoDate 
- Methods: Calendar/set Event/hide Event/rsvp Event/set Plan/confirm Plan/dismiss 
- api.*: api.operation.undo 

### ui-settings
- Types (contract or data layer): Account AiProvider Api Consent HARNESS_NOW_MS KeyBinding Session Settings SettingsPatch UiSettings api toIsoDateTime useAccounts useConsent useNow useSession useSettings 
- Methods: Ai/models Ai/usage Clients/list Diagnostics/preview Listener/get Queue/list 
- api.*: api.account.set api.consent.grant api.consent.revoke api.demo.load api.demo.remove api.demo.reset api.diagnostics.copy api.diagnostics.preview api.settings.set 

### ui-ask
- Types (contract or data layer): AiProvider AskTurn Calendar Citation Conversation ErrorBody Event EventTime ModelRef ProgressFrame Proposal Receipt SearchQuery ThreadRow api toIsoDate toIsoDateTime useAgenda useFrames useNow useRow useSettings useView 
- Methods: 
- api.*: api.ai.transcribe api.ask.cancel api.blob.put api.search.remote 

