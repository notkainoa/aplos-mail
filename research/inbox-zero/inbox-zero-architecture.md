# Inbox Zero (elie222/inbox-zero): architecture audit

*Audited 2026-10-25 from a shallow clone of `main` at `/tmp/iz-compare/src/inbox-zero`. I only read files; nothing from the repo was installed, built or run. Paths are relative to the repo root, and `web/` means `apps/web/`. Claims that rest on an assumption are marked "(unverified)".*

---

## 0. Summary

Inbox Zero is one of the largest and most mature open-source AI mail products. It is a server-side Next.js monolith of about 320k lines of non-test TypeScript in `apps/web` alone, with an equally large test suite.

It is really **two products in one repo**:

1. **An AI assistant** that runs in the background against Gmail and Outlook through their REST APIs and push webhooks. It handles rules, drafting, follow-ups, digests, a chat agent, cold-email blocking, bulk unsubscribe, document filing, meeting briefs and recording.
2. **A newer local-first email client.** A SQLite engine runs in an Electron utility process or in a browser web worker (WASM + OPFS). The server mediates its sync through `/api/mail/v1`.

**Strengths:**
- breadth of features;
- strict TypeScript with very little `any`;
- deterministic-first rule matching;
- structural limits on what the AI can make actions do;
- encrypted tokens;
- a serious eval harness;
- very thorough self-hosting tooling.

**Weaknesses:**
- sprawl (102 Prisma models, four queue backends, many feature flags, migration leftovers);
- a 2,000-line LLM wrapper with stacked retry layers;
- evals are not a CI gate;
- **the first-sync path that actually runs fires 50 parallel `messages.get` calls per page against Gmail, and when that fails it backs off for only about 1 second.** A better Redis token-bucket budget exists, but nothing outside tests calls it.

That last point is directly relevant to the Gmail 403 problem we just hit.

---

## 1. Monorepo layout and tech stack

**Tooling.** pnpm 11 workspaces with Turborepo (`pnpm-workspace.yaml`, `turbo.json`, root `package.json`) on Node 24.x.
- Supply-chain hardening: `minimumReleaseAge: 1440`, so packages published in the last 24 hours are blocked.
- Install scripts are allow-listed (`allowBuilds`).
- Many security pins are in `overrides`.

**Apps**

| App | LOC (TS/JS, incl. tests) | What it is |
|---|---|---|
| `apps/web` (`inbox-zero-ai`) | ~629k | The whole product: Next.js app, API, crons, AI, marketing pages |
| `apps/desktop` | ~12.5k | Electron. Runs the local SQLite mail engine in a utility process (`src/mail-engine/utility-host.ts`); not just a web wrapper |
| `apps/unsubscribe-worker` | ~2.1k | Headless Playwright unsubscribe agent in a gVisor sandbox |
| `apps/worker` | ~200 | BullMQ runner that only forwards jobs over HTTP back to the web app (`src/runtime.mjs`) |
| `apps/image-proxy`, `image-proxy-aws` | small | Cloudflare Worker / AWS remote-image proxy |

**Packages**

| Package | LOC | Contents |
|---|---|---|
| `mail-sqlite` | 17.4k | SQLite schema, store and search; `store.ts` alone is 3.4k |
| `cli` | 10.2k | Self-host setup: Docker, AWS, Terraform, Google Pub/Sub |
| `mail-core` | 7.8k | Engine, query semantics, command and effect state |
| `email-editor` | 4.5k | |
| `transactional-email` | 4.0k | React Email + Resend |
| `mail-ui` | 3.6k | |

Also present: `api` (a CLI over the public REST API), `loops`, `network`, `scheduling`, `tinybird`, `tinybird-ai-analytics` and `tsconfig`.

**Stack** (from `web/package.json` unless noted)

- **Framework:** Next.js **16.4.2**, App Router (`web/app/(app)`, `(landing)`, `(marketing)`), React 19.3, Turbopack in dev. The build is `standalone` for Docker (`web/next.config.ts:242`). Server actions use `next-safe-action`, client data uses SWR, and server state uses Jotai.
- **Language:** TypeScript 6 with `strict: true` (`packages/tsconfig/nextjs.json`) and Zod 4 everywhere. Env is validated with `@t3-oss/env-nextjs` (`web/env.ts`, 695 lines).
- **ORM and database:** Prisma **7.10** with `@prisma/adapter-pg` on PostgreSQL (16 in `docker-compose.yml`). There are 303 migrations, and the schema is 2,894 lines with **102 models** (`web/prisma/schema.prisma`).
- **Cache, locks and queues:**
  - Upstash Redis over HTTP (`web/utils/redis/index.ts`). Self-hosters run a `serverless-redis-http` shim in front of `redis:7` (`docker-compose.yml`).
  - ioredis for BullMQ and chat-adapter state.
  - Queues: **Upstash QStash**, **BullMQ**, **Vercel Queues** (`@vercel/queue`, topic triggers in `web/vercel.json`) and an "internal" HTTP fire-and-forget. `QUEUE_BACKEND` chooses between them (`web/env.ts:223`, `web/utils/queue/dispatch.ts`).
- **Auth:** **Better Auth 1.7** (`web/utils/auth.ts`) with the Prisma adapter, 30-day sessions and a cookie cache. Plugins add SSO (SAML), SCIM, Expo and an OAuth provider; the app is itself an OAuth server for MCP clients. It was migrated from NextAuth: `Account.type` is commented "next-auth deprecated field", and there is `docs/better-auth-1.7-upgrade.md`.
- **Payments:** Stripe as primary (`web/ee/billing/stripe`), Apple App Store server library for iOS in-app purchases (`web/ee/billing/apple`), and legacy Lemon Squeezy (`web/ee/billing/lemon`, `web/app/api/lemon-squeezy`). `ee/` has a separate commercial license (`web/ee/LICENSE.md`). The root license is AGPL-3.0 with an added clause, which GitHub reports as `NOASSERTION`.
- **Analytics and telemetry:**
  - PostHog for product analytics, feature flags and `@posthog/ai` LLM tracing.
  - Tinybird for AI-call spend analytics (`packages/tinybird-ai-analytics`).
  - Vercel Analytics and Speed Insights, Dub for attribution, Crisp for support chat.
  - Sentry (`@sentry/nextjs`; `web/instrumentation.ts`, with scrubbing in `web/utils/sentry-scrub.ts`).
  - Axiom logs through `next-axiom` (`web/utils/logger.ts`), plus a separate audit dataset (`AXIOM_AUDIT_*`).
- **Email sending:**
  - Users' own mail goes out through the Gmail and Graph APIs, with nodemailer used only to build MIME (`web/utils/gmail/mail.ts`).
  - Transactional mail goes through **Resend** with React Email (`packages/transactional-email`).
  - Lifecycle and marketing mail goes through **Loops** (`packages/loops`).
- **AI:** Vercel AI SDK `ai` 7 with 12 `@ai-sdk/*` providers, plus OpenRouter, Ollama and Braintrust (datasets only). See §4.
- **Deployment targets:**
  - Vercel first: `web/vercel.json` holds 13 crons and queue triggers, and the repo is in the "Vercel OSS Program" (README).
  - Docker image on GHCR (`docker/Dockerfile.prod`, `.github/workflows/build_and_publish_docker.yml`) with Compose running db, redis, web, worker and an alpine cron container.
  - Helm chart (`charts/inbox-zero`), AWS Copilot (`copilot/`), Terraform and AWS through the CLI, and a Homebrew formula (`Formula/`).
  - More than 20 hosting guides (`docs/hosting/*.mdx`) cover EC2, GCP with a Cloudflare tunnel, Kubernetes, security hardening and more.

**Critique:**
- The infrastructure surface is very large for a small team: four queue backends, three deploy families, an HTTP Redis shim for self-hosters, and Upstash and ioredis side by side.
- The Docker image bakes `NEXT_PUBLIC_*` values in at build time and replaces placeholders when the container starts (`docker/scripts/replace-next-public-placeholders.sh`), which is fragile.
- The production build needs `--max_old_space_size=16384` (`web/package.json` `build` script), a sign of how big the monolith has become.

---

## 2. Data model

There are 102 models in `web/prisma/schema.prisma`. Grouped by product area:

- **Identity:**
  - `User` holds the BYO AI key fields `aiProvider`, `aiModel` and `aiApiKey`.
  - `Account` holds the OAuth tokens.
  - `EmailAccount` (around 50 setting columns) is the tenant unit, and nearly every table hangs off `emailAccountId`.
  - Also `Session`, `Verification`, `ApiKey`, plus Better Auth OAuth-server tables (`OauthClient`, `OauthAccessToken`, `Jwks`, …) and 13 `Scim*` tables.
- **Automation core:**
  - `Rule` holds AI `instructions`; static `from`, `to`, `subject` and `body` regexes; an optional `groupId` (learned patterns); `conditionalOperator` (AND/OR); `systemType` (built-in rules like To Reply and Cold Email); and `runOnThreads`.
  - `Action` is a typed action with optional `{{template}}` fields.
  - `RuleHistory` stores versioned snapshots.
  - `ExecutedRule` and `ExecutedAction` are the audit trail: status, the model's `reason`, `matchMetadata`, and draft attribution (`draftModelName`, `draftPipelineVersion`).
  - Also `ScheduledAction` (delayed actions) and `ClassificationFeedback` (learning from user corrections).
- **Learned patterns:** `Group` and `GroupItem` store sender and subject patterns. `ColdEmail` is `@deprecated` and being migrated into `GroupItem`; `Category` and `Newsletter` are sender-level classification.
- **Reply and conversation state:** `ThreadTracker` (awaiting/needs reply, follow-up fields), `ResponseTime`, `ReplyMemory` and `ReplyMemorySource` (memories learned from user edits to drafts), `DraftSendLog`, `Knowledge` (just `title` and `content`), and `Snippet`.
- **Chat:** `Chat`, `ChatMessage` (`parts Json`), `ChatCompaction` and `ChatMemory`.
- **Mail-client features:** `MailSplit` and `MailSplitFilter` (split inbox), `SnoozedThread`, `ScheduledEmail`, `EmailSendOperation`, `SentMessageOpen` (open tracking for mail sent from their client, on by default per `EmailAccount.sentMessageOpenTrackingEnabled`), and the team-comments tables `Conversation*`.
- **Extensions:**
  - Calendar: `CalendarConnection`, `Calendar`, `BookingLink`, `Booking`, `Availability*`.
  - Meetings: `MeetingBriefing`, `ContactResearch`, `Meeting`, `MeetingRecording`.
  - Messaging: `MessagingChannel`, `MessagingRoute`.
  - Scheduled jobs: `AutomationJob`, `AutomationJobRun`.
  - Drive filing: `DriveConnection`, `FilingFolder`, `DocumentFiling`, `AttachmentSource`, `AttachmentDocument`.
  - MCP: `McpIntegration`, `McpConnection`, `McpTool`.
  - Mobile push: `MobilePushToken`, `MobilePushDelivery`.
- **Organisations and billing:** `Organization`, `Member`, `OrganizationRule` (materialised into each member's `Rule`), `Invitation`, `SsoProvider`, `Premium`, `Payment`, `Referral`.

**Does it store email bodies?** Mostly no, by design. Postgres holds IDs and metadata plus *derived* text:
- `EmailMessage` has only `threadId`, `messageId`, `date`, `from`, `fromDomain`, `to`, `unsubscribeLink` and read/sent/draft/inbox flags. There is no subject or body.
- Bodies are fetched from Gmail or Graph when needed.

Derived content does persist, though:
- `DigestItem.content` holds AI summaries.
- `ExecutedAction.content` holds draft text.
- `ChatMessage.parts` holds chat transcripts, which can include tool results quoting email.
- `ReplyMemory`, `Knowledge`, `ExecutedRule.reason`, and `ContactResearch` also hold derived text.

Retention crons trim reasoning text and sent-draft comparisons (`web/app/api/cron/reasoning-retention/route.ts`, using `REASONING_RETENTION_DAYS` and `DRAFT_SENT_TEXT_RETENTION_DAYS`), along with push and send-operation logs.

The new mail client stores full message HTML on the **client**: `packages/mail-sqlite/src/migrations.ts:67` has `html TEXT`, in OPFS in the browser or in `mailbox.sqlite` on the desktop.

**What the schema says about the product:**
- It is a background rules engine first. ExecutedRule/Action is the core audit loop.
- It has grown into a "chief of staff" platform: calendar, meetings, Drive, Slack and Telegram, MCP.

**Debt visible in the schema:**
- `@deprecated` columns: `coldEmailBlocker`, `coldEmailPrompt`, `rulesPrompt`, `Rule.automate`, `categoryFilters`, `wasDraftSent`.
- `ExecutedRuleStatus.PENDING` and `REJECTED` are deprecated, because the approval flow was removed.
- The `PremiumTier` enum carries `@map`s to old tier names.
- Two generations of cold-email storage exist side by side.

---

## 3. Mail provider integration

**This section matters most for our comparison.**

### Access
- Gmail uses the REST API through `@googleapis/gmail` (`web/utils/gmail/client.ts`), with a hand-built multipart caller for the Gmail batch endpoint (`web/utils/gmail/batch.ts`).
- Outlook uses `@microsoft/microsoft-graph-client`, with `$batch` (`web/utils/outlook/batch.ts`).
- **There is no IMAP.**
- `createEmailProvider` (`web/utils/email/provider.ts`) returns `GmailProvider` or `OutlookProvider` (`web/utils/email/google.ts`, 2.3k lines; `microsoft.ts`, 3.4k lines).
  - Before building one, it checks a Redis "rate-limited until" flag (`assertProviderNotRateLimited`).
  - It wraps every method in a Proxy that records auth and health issues.
  - Cost: each construction is a DB token read plus a Redis read, and the Gmail webhook constructs one *per history item* (`web/utils/webhook/google/process-history-item.ts`).

### Push

**Gmail:**
- `users.watch` on INBOX and SENT to `GOOGLE_PUBSUB_TOPIC_NAME` (`web/utils/gmail/watch.ts`). Watches are renewed hourly by the Vercel cron `/api/watch/all`, which calls `ensureEmailAccountsWatched` (`web/utils/email/watch-manager.ts`).
  - That renewal re-watches **every** premium account one at a time, with no "expiring soon" filter, inside an 800-second function.
  - Their own comment says it "already runs close to its time budget".
- Push is verified only by comparing a `?token=` query parameter to `GOOGLE_PUBSUB_VERIFICATION_TOKEN` using plain `!==` (`web/app/api/google/webhook/route.ts:40`).
  - An empty string turns the check off, on the assumption that an upstream OIDC gateway does the checking (`docs/hosting/aws-copilot.mdx`).
  - The app never verifies Google's OIDC JWT itself.
- The handler returns 200 at once and does the work in `after()` (`maxDuration = 300`). Errors also return 200, so Pub/Sub never redelivers; recovery depends on the next notification's history catch-up.

**Outlook:**
- A Graph subscription on `/me/messages` for `created,updated` with a 3-day expiry (`web/utils/outlook/watch.ts`).
- Renewal deletes and recreates the subscription rather than PATCHing it (`web/utils/outlook/subscription-manager.ts`). Old subscription IDs are kept in `EmailAccount.watchEmailsSubscriptionHistory`, which has a GIN index.
- The `validationToken` handshake is implemented, and the token is logged.
- `clientState` is a single global secret (`MICROSOFT_WEBHOOK_CLIENT_STATE`) compared with `!==`.
- Subscribing to `updated` means every read-flag change triggers a Graph GET *before* the dedupe lock (`web/utils/webhook/outlook/process-history.ts`).

### History sync

**Gmail** (`web/utils/webhook/google/process-history.ts`):
- `history.list` runs from `EmailAccount.lastSyncedHistoryId`, 500 per page.
- The gap is capped at 3,000 history IDs, or 30,000 during a rate-limit catch-up. Older history is skipped on purpose.
- A 404 (expired historyId) resets the cursor to the webhook's ID **with no backfill**.
- The cursor only moves forward, through a conditional SQL `UPDATE ... WHERE CAST(...) < new`, and it is saved after each record so a timed-out function keeps its progress. These are good patterns.
- **Webhooks for the same account are not serialized.** Only a per-message Redis `SET NX` lock with a 5-minute TTL (`web/utils/redis/message-processing.ts`) prevents duplicate work. Overlapping webhooks still double the `history.list` and `messages.get` calls.

**Local cache:**
- The local-cache delta for the mail client is in `web/utils/gmail/mailbox-sync.ts`; there, a 404 silently restarts a *full* snapshot.
- Outlook uses Graph `/delta` only for that local cache (`web/utils/outlook/mailbox-sync.ts`).

### First sync and bulk loading (the weak spot)

**The path that actually runs.** The client engine (`packages/mail-core/src/engine.ts`) bootstraps with `afterMs: null` (line 704), so it enumerates the **whole mailbox**, at `pageSize: 50` (line 748).
- The server side is `web/utils/mail-api/source.ts`. It calls `GmailProvider.getMessagesWithPagination`, which runs `messages.list` and then `Promise.all` over every ID, each a `messages.get` with `format=full` (`web/utils/email/google.ts`, around lines 1457-1470).
  - That is **50 concurrent requests per page for one user**: the classic trigger for `userRateLimitExceeded` / "Too many concurrent requests for user".
- Pacing is by time slices (2-second bootstrap slices, at most 25 pages per run, lane backoff of 1 to 60 s), not by quota.
- **On any provider error, `mapProviderError` (`source.ts:558-580`) returns `paused` with `retryAfterMs: 1000`.** Only an existing Redis rate-limit flag produces 15 s. Because the error is swallowed there, no cooldown is ever recorded.
  - The result: a 403 during bootstrap gets a retry about 1 second later with another 50-way fan-out.

**The better design that is unused.** `web/utils/email/local-mail-sync-budget.ts` is a Redis Lua token bucket measured in Gmail quota units.
- Budgets: 1,200 units/min per account and 120,000 per app, with backfill limited to half. Costs: list 5, message 20, history 2.
- At most 1 request in flight per account and 8 per app, enforced with leased ZSET entries. Time comes from Redis to avoid clock skew, and refill runs at half speed for 5 minutes after a throttle.
- `web/utils/gmail/local-mail-sync.ts` uses it properly:
  - records the historyId before backfilling;
  - passes `retry:false` to googleapis;
  - hydrates at most 25 messages, one at a time.
- I confirmed `syncLocalMail` has **no non-test call sites**. It is defined in `google.ts:1652` and `microsoft.ts:1716` and referenced only by tests. It looks like a stronger design that was replaced by mail-api v1 without bringing the budget along.

**Other bulk jobs:**
- Stats and newsletter loading (`web/utils/actions/stats-loading.ts`) loads up to 1,000 messages per call through the same 20-way parallel `format=full` path, only to read headers.
- The cleaner (`web/utils/actions/clean.ts`) is the good example: one QStash job per thread, with a per-account `flowControl` parallelism of 3.

### Retries and backoff
- **Shared wrapper.** `withProviderRetry` (`web/utils/retry/provider-retry.ts`) is built on p-retry. It **gives up instead of sleeping** if the computed delay is over 10 s. It has no jitter, and p-retry's own default `minTimeout` may stack on top (unverified).
- **Gmail policy** (`web/utils/gmail/retry.ts`, 5 retries):
  - It classifies 429, `RESOURCE_EXHAUSTED`, and 403 with `rateLimitExceeded`, `userRateLimitExceeded` or `quotaExceeded`, plus "too many concurrent requests".
  - It parses Gmail's **"Retry after <ISO timestamp>"** from the error *message* first, then the `Retry-After` header, then falls back to 1, 2, 4, 8, 10 s.
  - Weaknesses: daily `quotaExceeded` is treated as retryable, and server errors are detected partly with the regex `/500|502|503|504/` on message text.
- **Per-account cooldown:**
  - Storage: `web/utils/redis/email-provider-rate-limit.ts` stores `{provider, retryAt, source}` with a TTL of the delay plus 5 s, and the time only ever moves later.
  - Readers: the provider factory, both webhooks and history processing check it. Webhooks skipped during a cooldown set a catch-up flag.
  - Gap: the cooldown is computed as attempt 1, so without a Gmail "Retry after" time it is about **1 second**.
  - Gap: `getMessage`, the first-sync method, is not wrapped with `withRateLimitRecording`.
  - Gap: project-wide throttles are recorded per account, so they never slow other accounts.
- **Batching:**
  - Gmail batches use 25 requests (the limit is 100). Throttled sub-requests are retried in chunks of 10, sequentially, up to 3 times with 1/2/4 s plus up to 1 s of jitter (`web/utils/gmail/batch-with-retry.ts`).
  - **Bug:** `checkBatchResponseForError` (`web/utils/gmail/batch.ts:89-101`) throws *inside* a `try {} catch {}` that swallows it. A whole-batch 429 or 403 then surfaces as a generic parse failure and is never classified as a rate limit.
  - Graph `$batch` is chunked at 20 and stops at the first 429.

### Token refresh
- **Google** (`web/utils/gmail/client.ts`):
  - Refreshes when 10 minutes or less remain.
  - There is no distributed lock; concurrent refreshes race, and an optimistic compare-and-set on `expires_at` decides which result is saved (`web/utils/auth/save-tokens.ts`).
  - `invalid_grant` clears tokens only if they still match the failing snapshot, then sends a "reconnect" email.
- **Microsoft** (`web/utils/outlook/client.ts:290-305`):
  - A raw token-endpoint POST with a large AADSTS error table.
  - **Only `access_token` and `expires_at` are saved. The rotated `refresh_token` in the response is thrown away and the old one is reused** (`accountRefreshToken: refreshToken`).
  - I expect long-lived Outlook accounts to hit refresh-token expiry and need a reconnect.

### Transferable lessons for our Gmail 403 problem
1. Classify by Gmail's `reason` rather than the HTTP code, and parse the "Retry after <timestamp>" text in the message. Treat `dailyLimitExceeded` / `quotaExceeded` as "stop for today".
2. Never fan out `messages.get` with an unbounded `Promise.all`. Their live path does this and is fragile. Use 1 to 4 concurrent requests per account, or sequential batches of 10 to 25, and shrink after any throttled sub-response.
3. Budget in quota units with a token bucket, not in requests. Stay well under Google's per-user per-minute limit, give interactive work priority over backfill, and refill slowly after a throttle.
4. Keep one durable "rate limited until" per account, check it before *every* call, and only ever move it later. Default to 30 to 60 s or more when Gmail gives no time; their ~1 s fallback is a mistake.
5. Fail fast instead of sleeping long, save the cursor and reschedule, and always add jitter.
6. Read `historyId` from `getProfile` **before** backfilling, page the backfill with a saved cursor, then replay history from that ID.
7. Limit the first sync by date and use `format=metadata`. Fetch full bodies lazily, or only for recent mail.
8. Turn off hidden library retries (googleapis `retry:false`) so only one retry layer exists.
9. Check for whole-batch errors, not just per-part errors.
10. After a historyId 404, run a bounded, rate-limited resync of a recent window, not an unbounded full re-snapshot.

---

## 4. AI pipeline

- **SDK and providers.** Vercel AI SDK `ai` 7 with `@ai-sdk/{openai, azure, anthropic, amazon-bedrock, google, google-vertex, groq, cerebras, gateway, openai-compatible, perplexity, mcp}`, plus OpenRouter and Ollama. There is also an unusual CLI provider (`codex-cli`, `claude-code`) behind `CLI_LLM_ENABLED` (`web/utils/llms/cli-provider.ts`).
- **Model tiers.** `default`, `economy`, `chat`, `nano` and `draft`, each configured as an ordered fallback chain of `provider:model` (`DEFAULT_LLMS`, `ECONOMY_LLMS`, …) in `web/env.ts`.
  - The old `*_LLM_PROVIDER` / `*_LLM_MODEL` variables are still converted at startup (`web/env-legacy-llms.ts`).
  - 43 use cases are mapped to tiers in `web/utils/llms/use-cases.ts`.
- **Where prompts live.** Inline template strings next to the code, about 40 files under `web/utils/ai/**`. They use XML-ish tags (`<instructions>`, `<user_rules>`, `<email>`, `<security>`) and shared builders in `web/utils/ai/helpers.ts`.
  - There is no prompt registry. Versioning is a manual integer (`ASSISTANT_CHAT_PIPELINE_VERSION = 14`) and a draft pipeline version stored on `ExecutedAction`.
- **Rule evaluation** (`web/utils/ai/choose-rule/run-rules.ts`, `match-rules.ts`):
  1. The cold-email check runs first (`web/utils/cold-email/is-cold-email.ts`).
  2. Deterministic passes run before any LLM call: static regex, learned-pattern groups (a match removes AI candidates altogether), and thread continuity. They are combined with each rule's AND/OR operator.
  3. An optional non-LLM "decision model" (`web/utils/decision-model/`, `experimental_decide`, off by default) can choose or defer.
  4. `aiChooseRule` makes one `generateObject` call with a Zod schema. Single-rule mode returns `{reasoning, ruleName, noMatchFound}`; multi-rule mode returns `matchedRules[{ruleName, isPrimary}]`. Names are resolved tolerantly, and unknown names throw.
  5. `aiGenerateArgs` fills only `{{template}}` fields.
  6. An `ExecutedRule` row is written as `APPLYING`, then `APPLIED`/`ERROR`/`SKIPPED`. Delayed actions go to `ScheduledAction`.
  - **Test mode** runs the whole path without writing anything.
  - **Context sent:** the body goes through hidden-content stripping (`web/utils/ai/content-sanitizer.ts`) and HTML-to-text, and is then truncated to **500 characters** for rule selection (`web/utils/stringify-email.ts`). Other paths use 3,000 for args and drafts and 4,000 for chat reads.
  - **Inconsistency:** rule selection uses the `default` tier from webhooks but the `chat` tier from manual runs.
- **Structured output.** `generateObject` with Zod everywhere outside chat. `createGenerateObject` in `web/utils/llms/index.ts` (**2,157 lines**) layers:
  - model fallback;
  - DLP;
  - `jsonrepair` with balanced-JSON extraction;
  - usage accounting, even on failure;
  - PostHog tracing;
  - **stacked retries:** `withLLMRetry` (3 tries, Retry-After aware), then `withNetworkRetry` (which also retries schema failures), then per-call `withRetry`, then the SDK's own retries. One bad call can expand to a dozen attempts per candidate model.
- **BYO keys.** Stored per user (`User.aiApiKey`), encrypted with AES-256-GCM under a versioned key (`web/utils/encryption.ts`, `web/utils/prisma-extensions.ts`). A BYO key replaces *all* tiers with one model and **no fallback**.
- **Cost controls:**
  - Per-call token and cost accounting (`web/utils/usage.ts`) using static plus OpenRouter-generated pricing tables, written to Redis hashes and Tinybird.
  - Weekly spend limits for trial users, plus an automatic downgrade to `nano` (`web/utils/llms/model-usage-guard.ts`).
  - Premium-tier gating (`web/utils/premium/limits.ts`).
  - Prompt caching for Anthropic, Bedrock and OpenAI (`web/utils/llms/caching.ts`), with account-keyed `promptCacheKey`.
  - **Gaps:** no per-user LLM request rate limit, no `maxOutputTokens` anywhere, chat runs on a 720-second time budget with no step cap (`maxDuration = 800`), and the general rate limiter fails open (`web/utils/rate-limit.ts`).
- **Evals:**
  - `web/__tests__/eval/` has 72 test files, 42 of them assistant-chat. `web/__tests__/ai-regression/` has 19.
  - Vitest is gated by `RUN_AI_TESTS`, with a multi-model matrix (`describeEvalMatrix`), LLM-as-judge (`judge.ts`, `harness/criteria-judge.ts`) and ablation and compare scripts (`web/scripts/eval-*.ts`).
  - **Not a CI gate.** `.github/workflows/ai-evals.yml` is `workflow_dispatch` only, and it pins `claude-sonnet-4.5`, which differs from the code defaults.
  - The draft-reply eval cases load from a **private** external dataset (`EVAL_DATA_DIRS`), so outside contributors cannot reproduce them.
- **Prompt-injection guardrails:**
  - All untrusted fields are HTML-escaped inside XML tags, so `</email>` cannot break out.
  - Zero-width and bidi characters, HTML comments and inline `display:none` / `visibility:hidden` / `font-size:0` elements are stripped. It does *not* handle white-on-white text, `opacity:0`, the `hidden` attribute or class-based hiding.
  - A `<security>` system block at full, compact or none level (`web/utils/ai/security.ts`).
  - **Structural limits (the strongest part):**
    - the AI fills only fields marked with `{{template}}`, so injected `to`, `cc` or `bcc` values are ignored (`choose-args.security.test.ts`);
    - REPLY, SEND and FORWARD are blocked for spoofable From patterns (`web/utils/rule/static-from-risk.ts`);
    - chat send, reply and forward only create a pending action that the UI must confirm (`web/utils/ai/assistant/chat-inbox-tools.ts`, `app/api/chat/confirm-email-action`);
    - chat memory writes need an exact user quote, checked in code (`chat-memory-policy.ts`).
  - **Gaps:**
    - rule actions (REPLY, SEND_EMAIL, FORWARD, CALL_WEBHOOK) execute automatically with no approval, since the approval flow was removed;
    - DLP (`web/utils/dlp/`) is regex-only and defaults to **ALLOW**;
    - chat's `manageInbox` (archive, trash, unsubscribe) needs no confirmation.
- **Chat agent** (`web/utils/ai/assistant/chat.ts`, about 25 tools):
  - It streams through `toolCallAgentStream`, compacts history with an economy model, trims stale tool results and orders messages to maximise cache hits.
  - The same engine runs behind Slack, Teams and Telegram.
  - MCP *client* tools, read-only by default, are used by the drafting agent (`web/utils/ai/mcp/mcp-tools.ts`), not by the main chat.

---

## 5. Features and how deep each one goes

| Feature | Depth | Evidence and notes |
|---|---|---|
| Assistant rules | **Deep** | 17 action types (`ActionType`, `schema.prisma:2160`); `web/utils/rule` (32 files, 6.4k LOC); learned patterns; rule history is stored but viewable only under `debug/`. Prompt-to-rules has moved into chat, and `aiPromptToRules` survives only for `app/api/mobile/rules` |
| Reply tracking / follow-ups | **Deep** | Now system rules (To Reply / Awaiting / FYI / Actioned); `web/utils/reply-tracker` (5.6k LOC); `web/utils/follow-up` (6.4k LOC) with an hourly cron, follow-up drafts and messaging notifications. Behind a flag (`follow-up-reminders`). The standalone "Reply Zero" page was removed (`next.config.ts` redirect) |
| Cold email blocker | Moderate, mid-migration | `web/utils/cold-email` (1.4k LOC); LLM plus prior-contact check; old `ColdEmail` model and new `GroupItem` coexist |
| Bulk unsubscribe | **Deep** | Ladder of one-click POST, then HTML form, then an optional LLM-driven Playwright agent in a gVisor sandbox with egress filtering (`apps/unsubscribe-worker/README.md`). HTTP only, no mailto. Very strong for hosted use, heavy for self-hosters |
| Sender categorisation | Moderate | `web/utils/ai/categorize-sender`, `smart-categories/` UI; feeds bulk archive and split inbox |
| Digest | Moderate to deep, flagged | `DIGEST` rule action, AI summaries, 5-minute Resend cron; `NEXT_PUBLIC_DIGEST_ENABLED`. Overlaps with the weekly summary, inbox-health and automation check-in emails |
| Chat assistant | **Deep, the center of gravity** | About 8.3k LOC of logic and 6.4k of UI; about 25 tools, memory, compaction, voice (Groq or OpenAI STT/TTS behind `NEXT_PUBLIC_VOICE_ENABLED`), Slack, Teams and Telegram |
| Drafting | **Deep** | `web/utils/ai/reply` (17 files); context collection (history, knowledge, public docs sites); draft confidence; learned writing style plus reply memories from user edits; draft cleanup cron |
| Knowledge base | Thin store | `Knowledge{title, content}` with no embeddings or vector search; chosen by prompt |
| Calendar / meeting briefs | Deep / moderate, flagged | `web/utils/calendar` (7.5k LOC, Google and Microsoft); briefs on a 15-minute cron behind `NEXT_PUBLIC_MEETING_BRIEFS_ENABLED`; booking links with public pages (`app/book/[slug]`) |
| Meeting recorder | Deep, flagged | Recall.ai bot lifecycle, transcripts, recap email and follow-up draft (`web/utils/meeting-recorder`, 3.6k LOC) |
| Drive filing | Deep | `web/utils/drive` (6.7k LOC, Google Drive and OneDrive); users reply by email or chat to correct a filing |
| MCP | Moderate (server) / deep (client) | Server: 11 tools plus a "mail client" MCP app with its own OAuth and dynamic client registration (`web/utils/mcp/server.ts`, `oauth.ts`), behind `MCP_SERVER_ENABLED`. Client: Composio plus about 20 integrations and custom servers, wired to the `INTEGRATION` action |
| Public API / CLI | Thin / deep | v1 API covers rules CRUD, two stats endpoints and unsubscribe only. `packages/cli` is a thorough self-host installer |
| Browser extension | Not in repo | Documented (`docs/essentials/inbox-zero-tabs-extension.mdx`); the web app only syncs tab config to it |
| Mobile | Server side only | Native Swift iOS app (closed source) and an older React Native Android app (README). This repo has mobile auth (PKCE, Expo), APNS/FCM push, an OTP endpoint and App Store review demo accounts |
| Desktop / local mail client | **Deep, newest investment** | Electron plus a SQLite engine in a utility process; the web version uses WASM SQLite on OPFS with a cross-tab owner lock; split inbox, snooze, scheduled and undo send, send-as, team comments. The desktop README ("Electron shell for the hosted web app") is out of date |
| Orgs / SSO / SCIM / billing | Moderate | Better Auth plugins do most of the work; Stripe, Apple IAP and Lemon Squeezy; messy tier enum |
| Agent plugins (`clawhub/`, `plugins/`, `skills/`, `agents/`) | Shells | About 135 lines of manifests and docs |

**Overall read on features:**
- **Breadth is exceptional.** There is real depth in rules, drafting, chat, unsubscribe and the local engine.
- **Sprawl is the cost.** Four "reduce volume" flows (bulk archive, quick bulk archive, cleaner, bulk unsubscribe) and four periodic-email features overlap.
- **Much of the product is gated by about 20 env or PostHog flags** (`web/hooks/useFeatureFlags.ts`; `NEXT_PUBLIC_*_ENABLED` in `web/env.ts`). Most are off by default, so a self-hosted install is noticeably smaller than the hosted product.

---

## 6. Engineering quality

**Tests.** There are 1,302 test and spec files repo-wide, about 305k LOC of tests against about 390k LOC of non-test TS/JS. In `apps/web` the split is 322k non-test vs 302k test lines, close to 1:1.

| Kind | Files | Location |
|---|---|---|
| Co-located unit tests | 930 | `web/utils`, `app`, `components`, … |
| Integration | 40 | `web/__tests__/integration` |
| DB | 19 | `web/__tests__/db` |
| E2E (Vitest flows) | 21 | `web/__tests__/e2e` |
| Playwright | 76 | `web/__tests__/playwright`, run against an **emulator stack** (`emulate` for Google, Microsoft, Stripe, Recall and the LLM; `emulate.config.yaml`) |
| AI evals / regression | 72 + 19 | `web/__tests__/eval`, `web/__tests__/ai-regression` |
| Other packages and apps | 99 | `packages/*`, `apps/desktop`, `apps/unsubscribe-worker` |

The emulated-provider Playwright setup is a real strength. It tests Gmail and Graph flows without live accounts.

**CI** (`.github/workflows/`, 15 workflows):
- `test.yml` on push and PR runs:
  - `pnpm check` (Biome via ultracite) and a typecheck of packages;
  - `konsistent` and custom guard scripts (`check-enums`, `check-server-actions`, `check-client-redirects`, `check-test-fixtures`);
  - unit tests in 2 shards.
- `build-check.yml` runs `next build`, which type-checks the web app.
- `playwright.yml` runs on push, PR and a schedule.
- `e2e-flows.yml` runs on a schedule and uses ngrok against real providers.
- AI evals are manual only.
- There are release pipelines for the desktop app, CLI, API, mail packages, Docker and the image proxy, plus Claude Code review bots (`claude.yml`, `claude-code-review.yml`).

**Linting and types:**
- Biome with the ultracite presets (`biome.json`); `noExplicitAny` is only `warn`.
- Even so, non-test code has just **15 `as any`, 27 `: any` and 1 `@ts-ignore`**, which is excellent for 320k LOC. There are 104 `biome-ignore` comments and 26 TODO/FIXME markers.
- The repo's AGENTS.md says root `tsc --noEmit` is unsupported because of "unrelated repo-wide debt", so type safety is enforced per package and through `next build`.

**Error handling and observability:**
- Route wrappers `withError`, `withAuth` and `withEmailAccount` (`web/utils/middleware.ts`) and `next-safe-action` clients (`web/utils/actions/safe-action.ts`) centralise errors and tag Sentry with `emailAccountId`.
- There is a scoped logger that sends PII only at trace level (`web/utils/logger.ts`, through Axiom), an audit context, and error dedupe (`log-error-with-dedupe.ts`).
- There is no distributed tracing beyond Sentry and PostHog LLM traces.

**Feature flags.** Env vars OR'd with PostHog flags; an `early-access` page lets users opt in themselves.

**i18n.** **None.** There is no i18n library and the layout hard-codes `lang="en"` (`web/app/layout.tsx:180`). The AI is told to work across languages, but the UI is English only.

**Accessibility.** Ad hoc. shadcn and Radix primitives give a baseline, with 351 `aria-` attributes and 47 `sr-only` usages in non-test code. There is no axe or a11y test tooling.

**Process.** The repo is heavily set up for coding agents (`AGENTS.md`, `.claude/skills`, `.cursor`, `.codex`, `.conductor`), and bots appear among the top contributors. Together with the 1:1 test ratio, this suggests a lot of agent-written code. That is good for coverage, but some tests probably just restate the implementation, which their own AGENTS.md warns against.

---

## 7. Security and privacy

- **Token storage.** A Prisma extension (`web/utils/prisma-extensions.ts`) encrypts these fields with AES-256-GCM:
  - OAuth `access_token` and `refresh_token`;
  - calendar, Drive, messaging and MCP tokens;
  - the MCP client secret;
  - `User.aiApiKey` and `webhookSecret`;
  - the meeting URL.

  The key is derived with scrypt from `EMAIL_ENCRYPT_SECRET` and `EMAIL_ENCRYPT_SALT` and is versioned for rotation (`web/utils/encryption.ts`). Legacy unversioned ciphertext and **plaintext** still read transparently, which helps migration but means a plaintext row would never be flagged.
- **Scopes:**
  - Gmail: `gmail.modify` plus `gmail.settings.basic` (both **restricted**, so CASA is required for the hosted app). Contacts scopes are optional and flag-gated (`web/utils/gmail/scopes.ts`). Calendar is a separate consent (`calendar.readonly`, `calendar.events`, `calendar.freebusy`).
  - Outlook: `Mail.ReadWrite`, `MailboxSettings.ReadWrite`, `offline_access`, and `Mail.Send` only when sending is enabled (`web/utils/outlook/scopes.ts`).
  - The repo has **no CASA or Google-verification artefacts**. Self-host docs tell users to run as an unverified app with test users (`docs/hosting/google-oauth.mdx`).
- **Multi-tenant isolation.** This is application-level only; there is no Postgres row-level security (no RLS in migrations).
  - `withEmailAccount` and the safe-action client load the `EmailAccount` and check `account.userId === session.user.id` (`web/utils/actions/safe-action.ts:141-153`).
  - Every downstream query has to remember to scope by `emailAccountId`. Composite `@@unique([id, emailAccountId])` relations, such as `Rule` and `Action`, are a nice defence-in-depth pattern.
- **Webhook verification:**
  - Implemented: Stripe signature, Slack signing secret (`web/utils/messaging/providers/slack/verify-signature.ts`), Loops and standard webhooks (`web/utils/webhooks/verify-standard-webhook.ts`), QStash signatures (`web/utils/qstash.ts`), and `CRON_SECRET` with `secureCompare` (`web/utils/cron.ts`).
  - Weaker: Gmail Pub/Sub uses a shared query-string token compared with `!==` and no OIDC JWT check; Outlook uses one global `clientState` with `!==`.
  - When cron auth fails, the app logs the `Authorization` header or the request body the caller sent (`web/utils/cron.ts:15-16, 44`). That is minor, but it can leak a near-miss or a rotated secret into Axiom.
- **Secrets.** All config is validated in `web/env.ts`, and there is the supply-chain pinning noted in §1. The unsubscribe worker never receives mailbox tokens. There is an SSRF-safe fetch for MCP (`web/utils/mcp/safe-fetch.ts`) and an image proxy to hide the reader's IP from remote images.
- **Privacy defaults to note:**
  - Open tracking on sent mail is **on by default**.
  - DLP defaults to ALLOW.
  - Chat transcripts and AI reasoning are stored in Postgres, with retention crons.

---

## 8. Scale and operations

- **Crons** (`web/vercel.json`), 13 in total:
  - every minute: scheduled actions;
  - every 5 minutes: digest and the meeting-recorder scheduler;
  - every 15 minutes: meeting briefs and automation jobs;
  - hourly: watch renewal and follow-ups;
  - daily: retention jobs and draft cleanup.

  Self-hosters get an alpine `cron` container that curls these routes (`docker-compose.yml`).
- **Queues.** The `QUEUE_BACKEND` abstraction covers QStash, BullMQ (concurrency 3, 3 attempts, exponential from 5 s; `web/utils/queue/bullmq.ts`), Vercel Queues (`retryAfterSeconds: 60`) and internal HTTP.
  - `deduplicationId` is honoured **only by QStash**, so idempotency differs by backend.
  - The BullMQ worker only proxies HTTP back to the web app, so every job still runs inside a Next.js route with that route's `maxDuration`.
- **Idempotency:**
  - per-message Redis locks;
  - a forward-only `lastSyncedHistoryId`;
  - the `ExecutedRule` index on `(emailAccountId, threadId, messageId, ruleId)`;
  - `EmailSendOperation` tracking for sends;
  - "unknown outcome" command handling in the mail engine.
- **What breaks at scale:**
  1. **Webhook-inline AI.** Gmail and Outlook webhooks run rules, LLM calls and categorisation inside `after()` with no queue, no backpressure and no per-account serialization. A burst of incoming mail turns directly into a burst of concurrent LLM and Gmail calls.
  2. **Hourly re-watch.** Every account is re-watched one at a time in one function that is already "close to its time budget".
  3. **Outlook `updated` subscription.** It multiplies Graph GETs on every read-flag change.
  4. **Client polling.** Every open client polls history every 60 seconds per account (`packages/mail-core/src/engine.ts`).
  5. **Unbudgeted first sync.** Full-mailbox `format=full` bootstrap with a 50-way fan-out and a 1-second retry.
  6. **Unbounded chat runs.** 800-second chat functions with no step cap.
  7. **Inconsistent queue semantics** across four backends.

---

## 9. Code size and community

- **LOC** (`find … | xargs cat | wc -l`, TS/JS):

  | Area | LOC |
  |---|---|
  | Total | ~699k |
  | of which tests | ~305k |
  | `apps/web` | ~629k (322k non-test) |
  | `web/utils` | 313k (AI 45k, actions 27k, email 20k, Outlook 19.6k, messaging 14.9k, Gmail 12k, LLM 10k, mail-engine 8.4k, MCP 7.7k) |
  | `web/app` | 143k (106 pages, 291 API route files, 107 server-action files) |
  | `web/components` | 41k |
  | `web/__tests__` | 102k |
  | `web/scripts` | 11k |
  | `packages/mail-sqlite` | 17.4k |
  | `packages/cli` | 10.2k |
  | `packages/mail-core` | 7.8k |
  | `apps/desktop` | 12.5k |

  There are also 6.7k lines of migration SQL and 9.2k lines of docs.
- **Largest files:**

  | File | Lines |
  |---|---|
  | `packages/mail-sqlite/src/store.ts` | 3,423 |
  | `web/utils/email/microsoft.ts` | 3,379 |
  | `web/utils/messaging/chat-sdk/bot.ts` | 3,123 |
  | `web/utils/messaging/rule-notifications.ts` | 2,673 |
  | `web/components/assistant-chat/tools.tsx` | 2,395 |
  | `web/utils/email/google.ts` | 2,305 |
  | `web/utils/llms/index.ts` | 2,157 |

- **GitHub** (`gh api repos/elie222/inbox-zero`): 12,806 stars, 1,632 forks, 142 open issues. Created 2023-07-12; last pushed 2026-10-25.
  - About **11,699 commits** on the default branch and about **90 contributors** (including anonymous), both from pagination `last` links.
  - The work is highly concentrated: `elie222` has 10,276 commits, then jshwrnr 461, edulelis 356 and gentlemandev 144, with bots in the top 10.
  - In practice this is a one-maintainer project with a small core team and heavy AI-agent help.

---

## 10. Bottom line for the comparison

**Where Inbox Zero is ahead:**
- breadth (rules, drafting with learned memories, chat with confirmations, calendar, meetings, Drive, Slack and Telegram, MCP, organisations and SSO);
- a mature eval harness;
- emulator-based end-to-end testing;
- encrypted token storage;
- structural guardrails on AI actions;
- polished self-hosting.

**Where it is exposed:**
- **Server-centric design:** every user's mail flows through their backend and their LLM keys. That brings restricted-scope CASA burden, webhook infrastructure, and per-user server cost.
- **Sprawl and migration leftovers.**
- **Prompts that are hard to maintain.**
- **Evals that do not gate releases.**
- **Auto-executing outbound rule actions.**
- **No i18n.**
- **A first-sync path with the same Gmail-quota weakness we just hit.** Their unused `local-mail-sync-budget.ts` design is the better template: quota-unit token bucket, one in-flight request per account, historyId recorded before backfill, `retry:false`, sequential hydration.

A desktop-first client that syncs directly to Gmail can differentiate on privacy (no server-side mail processing), on quota-safe sync, and on simplicity. It should not try to match their feature breadth.
