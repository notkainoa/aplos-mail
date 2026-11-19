import * as z from 'zod/mini';
import { Count, DurationMs, EpochMs, Id, line, openEnum, Problem, text } from './common';
import { DraftFields } from './compose';
import { EventFields, EventTime } from './calendar';
import { SuggestedAction, ThreadAction } from './mail';

/**
 * AI providers (AGENTS.md): Groq is the default for every feature; OpenAI, Claude, Gemini, OpenRouter, the owner's
 * OpenCode Go plan, Ollama and LM Studio on this Mac, or a custom OpenAI-compatible server.
 */
export const aiProviderIds = [
  'groq',
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'opencode-go',
  'ollama',
  'lmstudio',
  'custom',
] as const;
export const AiProviderId = openEnum(aiProviderIds);
/** The features the owner picks a provider and model for in Settings → AI. Voice needs speech to text (Groq or OpenAI). */
export const aiFeatures = ['ask', 'summaries', 'drafts', 'plans', 'voice'] as const;
export const AiFeature = openEnum(aiFeatures);

export const ModelRef = z.object({ provider: AiProviderId, model: line(200) });
export type ModelRef = z.infer<typeof ModelRef>;

/** A row of Settings → AI's provider table. Never a key and never any of its characters: only where it comes from (plan 30 section 4.5). */
export const AiProvider = z.object({
  id: AiProviderId,
  label: line(100),
  group: openEnum(['hosted', 'local']),
  status: openEnum(['ready', 'missingKey', 'unreachable', 'notConfigured', 'error']),
  keySource: openEnum(['env', 'keychain', 'none']),
  /** The backend variable a key can come from, e.g. `GROQ_API_KEY`. */
  envVar: line(60),
  keyOptional: z.boolean(),
  /** For Ollama, LM Studio and custom servers. */
  address: z.optional(line(500)),
  defaultAddress: z.optional(line(500)),
  running: z.optional(z.boolean()),
  version: z.optional(line(100)),
  /** Background mail content never goes to a provider marked true (ARCH 8.3). Free-tier Gemini is true until marked paid. */
  trainsOnInputs: z.boolean(),
  paidMarked: z.optional(z.boolean()),
  sttCapable: z.boolean(),
  /**
   * Mail never leaves this Mac. Computed from the address (a loopback host: `localhost`, `127.0.0.0/8`, `::1`), never
   * from the provider id, so an Ollama address moved to another machine is not local (freeze FR-5).
   */
  local: z.boolean(),
  lastTest: z.optional(
    z.object({
      ok: z.boolean(),
      at: EpochMs,
      ms: z.optional(DurationMs),
      reasonCode: z.optional(line(60)),
    }),
  ),
});
export type AiProvider = z.infer<typeof AiProvider>;

export const AiModel = z.object({
  id: line(200),
  label: line(200),
  description: z.optional(line(500)),
  tools: z.optional(z.boolean()),
  stt: z.optional(z.boolean()),
});

/** Readiness per feature, for Ask's no-provider state and Settings. */
export const AiFeatureStatus = z.object({
  feature: AiFeature,
  ready: z.boolean(),
  model: z.optional(ModelRef),
  reasonCode: z.optional(line(60)),
});

/** A background or interactive AI job (ARCH 8.1). Background jobs run with no tools, on the primary device, after consent. */
export const AiJob = z.object({
  id: Id,
  kind: openEnum(['summary', 'classify', 'plan', 'suggestAction', 'followup']),
  threadId: z.optional(Id),
  state: openEnum(['queued', 'running', 'done', 'failed', 'dead', 'skipped']),
  attempts: Count,
  nextAt: z.optional(EpochMs),
  model: z.optional(ModelRef),
  problem: z.optional(Problem),
});
export type AiJob = z.infer<typeof AiJob>;

/** A thread summary, content-keyed so a label change does not invalidate it. */
export const Summary = z.object({
  threadId: Id,
  text: text(10_000),
  state: openEnum(['ready', 'stale', 'failed']),
  model: ModelRef,
  action: z.optional(SuggestedAction),
  createdAt: EpochMs,
});

/** The Follow up nudge: a local suggestion, never a synced draft, until the user keeps it (ARCH 8.1). */
export const FollowupSuggestion = z.object({
  threadId: Id,
  html: text(40_000),
  basedOnMessageId: Id,
  model: ModelRef,
  createdAt: EpochMs,
});

export const AiUsage = z.object({
  day: line(10),
  backgroundTokens: Count,
  /** The daily background cap in tokens; absent means no limit. */
  cap: z.optional(Count),
  pausedUntil: z.optional(EpochMs),
  byModel: z.array(
    z.object({
      model: ModelRef,
      lane: openEnum(['interactive', 'background']),
      requests: Count,
      tokensIn: Count,
      tokensOut: Count,
    }),
  ),
});

/**
 * A versioned consent record (ARCH 8.3). The version covers the scope and, for every feature background jobs run on
 * (`summaries`; `plans` for plan jobs; `drafts` for follow-ups; freeze R2B-4), its provider, model and that provider's
 * address host: changing any of them bumps `currentVersion`, sets `needsReconsent` and pauses background AI until the
 * owner agrees again on the card (`Consent/grant`, Electron windows only; freeze FR-5).
 */
export const Consent = z.object({
  scope: openEnum(['background']),
  granted: z.boolean(),
  version: Count,
  currentVersion: Count,
  needsReconsent: z.boolean(),
  provider: z.optional(AiProviderId),
  model: z.optional(line(200)),
  grantedAt: z.optional(EpochMs),
});
export type Consent = z.infer<typeof Consent>;

/** What a citation points at, so hover and click work for mail and calendar sources alike. */
export const Citation = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    n: Count,
    messageId: Id,
    threadId: Id,
    quote: text(1_000),
    fromName: z.optional(line(200)),
    date: z.optional(EpochMs),
    subject: z.optional(text(2_000)),
  }),
  z.object({
    kind: z.literal('event'),
    n: Count,
    eventId: Id,
    title: text(1_000),
    start: EventTime,
  }),
]);
export type Citation = z.infer<typeof Citation>;

const proposal = {
  id: Id,
  consequence: line(500),
  state: openEnum(['open', 'accepted', 'dismissed']),
};
/** Something Ask prepared that only happens when the user accepts it (`Ask/decide`). */
export const Proposal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), ...proposal, draft: z.partial(DraftFields) }),
  z.object({
    kind: z.literal('addEvent'),
    ...proposal,
    calendarId: z.optional(Id),
    event: EventFields,
  }),
  z.object({
    kind: z.literal('triage'),
    ...proposal,
    threadIds: z.array(Id),
    action: ThreadAction,
  }),
]);
export type Proposal = z.infer<typeof Proposal>;

export const AskStep = z.object({
  id: Id,
  text: line(500),
  state: openEnum(['running', 'done', 'error']),
  count: z.optional(Count),
});

export const AskTurn = z.object({
  id: Id,
  question: text(20_000),
  /**
   * Paragraphs; `strong` marks ranges to emphasise. `cites` places citation chips (FR-30): chip `n` (a `Citation.n`) sits
   * at character `at` of `text`. Text carries no `[n]` markers: the engine strips any the model wrote, so offsets and
   * `strong` ranges count the text as shown, and quoted mail that contains "[1]" is just text.
   */
  answer: z.optional(
    z.object({
      blocks: z.array(
        z.object({
          text: text(20_000),
          strong: z.optional(z.array(z.object({ start: Count, end: Count }))),
          cites: z.optional(z.array(z.object({ at: Count, n: Count }))),
        }),
      ),
    }),
  ),
  citations: z.array(Citation),
  /** The answer used no source from the mailbox; the UI says so. */
  noSource: z.boolean(),
  model: z.optional(ModelRef),
  stopped: z.optional(z.boolean()),
  problem: z.optional(Problem),
  proposals: z.array(Proposal),
  steps: z.array(AskStep),
  /** Accounts left out because "Use this account's mail for AI" is off, even when `scope.accountIds` named them (FR-8). */
  excludedAccountIds: z.optional(z.array(Id)),
  createdAt: EpochMs,
});
export type AskTurn = z.infer<typeof AskTurn>;

export const Conversation = z.object({
  id: Id,
  rev: Count,
  title: line(200),
  updatedAt: EpochMs,
  turns: z.array(AskTurn),
});
export type Conversation = z.infer<typeof Conversation>;
