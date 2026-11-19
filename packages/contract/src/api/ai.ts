import * as z from 'zod/mini';
import { area } from '../registry/define';
import {
  Address,
  bool,
  choice,
  Count,
  DurationMs,
  Empty,
  getResult,
  GetInput,
  Id,
  Ids,
  line,
  Ok,
  OpId,
  Receipt,
  text,
  TimeZone,
} from '../schemas/common';
import {
  AiFeatureStatus,
  AiJob,
  AiModel,
  AiProvider,
  AiUsage,
  Consent,
  Conversation,
  FollowupSuggestion,
  ModelRef,
} from '../schemas/ai';
import { SetupStatus } from '../schemas/session';

const provider = choice([
  'groq',
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'opencode-go',
  'ollama',
  'lmstudio',
  'custom',
]);
const requestId = Id;
/** Where the provider's key now comes from; never any of its characters. */
const keySource = z.object({
  keySource: z.union([z.enum(['env', 'keychain', 'none']), z.string()]),
});

export const ai = area('ai', {
  'Ai/request': {
    summary:
      "Queue AI work for a thread ahead of the background order (today's `ai.summarize`); the result arrives as a Summary change. Without `force`, a thread with a summary is left alone. `forbidden` (`ai.accountExcluded`) for an account left out of AI.",
    kind: 'command',
    scope: 'ai',
    input: z.object({
      opId: OpId,
      kind: choice(['summary', 'classify', 'plan', 'suggestAction']),
      threadId: Id,
      force: z.optional(bool()),
    }),
    output: z.object({ job: AiJob, receipt: Receipt }),
  },
  'Ai/jobs': {
    summary: "AI jobs, e.g. which threads are being summarized (today's `ai.summarizing`).",
    kind: 'query',
    scope: 'read',
    input: z.object({
      threadIds: z.optional(Ids(500)),
      states: z.optional(
        z.array(choice(['queued', 'running', 'failed', 'dead'])).check(z.maxLength(4)),
      ),
    }),
    output: z.object({ list: z.array(AiJob) }),
  },
  'Ai/polish': {
    summary:
      "Suggest edits to a draft's text; the user's text stays until they choose. A `draftId` in an account left out of AI, or answering a thread there, is `forbidden` (`ai.accountExcluded`). Pasted text with no draft names the composing account in `accountId`, and one left out of AI is `forbidden` the same way; with neither, only the provider rule applies.",
    kind: 'command',
    scope: 'ai',
    input: z.object({
      requestId,
      html: text(1_000_000),
      instruction: z.optional(text(10_000)),
      draftId: z.optional(Id),
      /** The account the text is being written in, for pasted text with no `draftId`. */
      accountId: z.optional(Id),
    }),
    output: z.object({ html: text(1_000_000), changes: Count }),
  },
  'Ai/draft': {
    summary:
      'Write a draft or reply from an instruction, as a suggestion at the caret; a `threadId` or `draftId` in an account left out of AI (or a draft answering a thread there) is `forbidden` (`ai.accountExcluded`).',
    kind: 'command',
    scope: 'ai',
    input: z.object({
      requestId,
      instruction: text(20_000),
      threadId: z.optional(Id),
      draftId: z.optional(Id),
    }),
    output: z.object({ html: text(1_000_000), subject: z.optional(text(2_000)) }),
  },
  'Ai/transcribe': {
    summary:
      'Speech to text for dictation, from audio uploaded with `Blob/put` (25 MB at most) on the Voice provider.',
    kind: 'command',
    scope: 'ai',
    input: z.object({ requestId, blobId: Id, language: z.optional(line(20)) }),
    output: z.object({ text: text(1_000_000) }),
  },
  'Ai/cancel': {
    summary: 'Cancel an interactive AI request, or all of them when `requestId` is absent.',
    kind: 'command',
    scope: 'ai',
    input: z.object({ requestId: z.optional(Id) }),
    output: z.object({ cancelled: z.boolean() }),
  },
  'Ai/followup': {
    summary:
      'The Follow up nudge for a thread, if the background job wrote one (absent with AI off or without consent).',
    kind: 'query',
    scope: 'read',
    input: z.object({ threadId: Id }),
    output: z.object({ suggestion: z.optional(FollowupSuggestion) }),
  },
  'Ai/dismissFollowup': {
    summary: 'Dismiss a Follow up nudge.',
    kind: 'command',
    scope: 'triage',
    input: z.object({ opId: OpId, threadId: Id }),
    output: Receipt,
  },
  'Ai/providers': {
    summary: "Settings → AI's provider table: status, where each key comes from, never the key.",
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: z.object({ list: z.array(AiProvider) }),
  },
  'Ai/models': {
    summary:
      "A provider's models; local servers are asked live, hosted providers fall back to the curated list offline.",
    kind: 'query',
    scope: 'read',
    input: z.object({ provider }),
    output: z.object({ list: z.array(AiModel), live: z.boolean() }),
  },
  'Ai/status': {
    summary: 'Whether each AI feature is ready, and why not.',
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: z.object({ features: z.array(AiFeatureStatus) }),
  },
  'Ai/usage': {
    summary: "Today's AI use against the daily background cap.",
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: AiUsage,
  },
  'Ai/setKey': {
    summary: 'Save a provider key to the Keychain-backed vault; never echoed back.',
    kind: 'command',
    scope: 'admin',
    secret: true,
    audit: true,
    input: z.object({ provider, key: line(2_000).check(z.minLength(1, 'Paste a key first.')) }),
    output: keySource,
  },
  'Ai/removeKey': {
    summary: 'Remove a saved key; refused for a key from the backend environment.',
    kind: 'command',
    scope: 'admin',
    secret: true,
    audit: true,
    input: z.object({ provider }),
    output: keySource,
  },
  'Ai/testKey': {
    summary:
      "One cheap request with the provider's current key (usually its model list). No mail is sent. `message` is Aplos's own sentence for `reasonCode`, never the provider's text (FR-33).",
    kind: 'command',
    scope: 'admin',
    input: z.object({ provider }),
    output: z.object({
      ok: z.boolean(),
      ms: z.optional(DurationMs),
      reasonCode: z.optional(line(60)),
      message: z.optional(line(500)),
    }),
  },
  'Ai/test': {
    summary:
      "One tiny request asking a model to call a tool, so a pass means Ask's tools work too. No mail is sent. A failure's message is Aplos's own sentence for its `reasonCode`, never the provider's text (FR-33).",
    kind: 'command',
    scope: 'admin',
    input: z.object({ model: ModelRef }),
    output: z.object({ ms: DurationMs, tools: z.boolean() }),
  },
});

export const ask = area('ask', {
  'Ask/run': {
    summary:
      'Ask about your mail; returns at once with a run id, streams `progress` frames, and the answer lands in the Conversation. `scope.accountIds` and `context` only narrow the accounts whose "Use this account\'s mail for AI" is on; they never widen past them. A `context.draft.accountId` left out of AI is `forbidden` (`ai.accountExcluded`).',
    kind: 'command',
    scope: 'ai',
    input: z.object({
      question: text(20_000).check(z.refine(v => v.trim().length > 0, 'Write a question first.')),
      conversationId: z.optional(Id),
      scope: z.optional(
        z.object({ accountIds: z.optional(Ids(50)), searchAllMail: z.optional(bool()) }),
      ),
      /** What the user is looking at, so "summarize this" and "reply to this" need no tool call. */
      context: z.optional(
        z.object({
          view: z.optional(line(40)),
          threadId: z.optional(Id),
          eventId: z.optional(Id),
          selectedIds: z.optional(Ids(50)),
          draft: z.optional(
            z.object({
              to: z.optional(z.array(Address)),
              cc: z.optional(z.array(Address)),
              subject: z.optional(text(2_000)),
              html: z.optional(text(40_000)),
              /** The account the draft is being written in; one left out of AI makes the run `forbidden` (`ai.accountExcluded`). */
              accountId: z.optional(Id),
            }),
          ),
        }),
      ),
      timeZone: z.optional(TimeZone),
    }),
    output: z.object({ runId: Id, conversationId: Id }),
  },
  'Ask/cancel': {
    summary: 'Stop a run, keeping the partial answer.',
    kind: 'command',
    scope: 'ai',
    input: z.object({ runId: Id }),
    output: z.object({ cancelled: z.boolean() }),
  },
  'Ask/decide': {
    summary:
      'Accept or dismiss something Ask proposed (a reply, an event, a triage); accepting returns the receipt for Undo. Accepting an event with a guest other than you also needs `send`, and invites go out only then.',
    kind: 'command',
    scope: 'triage',
    audit: true,
    scopeRule: 'guests',
    input: z.object({ opId: OpId, conversationId: Id, turnId: Id, proposalId: Id, accept: bool() }),
    output: z.object({ receipt: Receipt, draftId: z.optional(Id), eventId: z.optional(Id) }),
  },
  'Ask/suggestions': {
    summary: 'Three plain suggested questions.',
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: z.object({ list: z.array(line(200)) }),
  },
  'Conversation/get': {
    summary: 'Ask conversations.',
    kind: 'query',
    scope: 'read',
    input: GetInput,
    output: getResult(Conversation),
  },
  'Conversation/destroy': {
    summary: 'Delete a conversation.',
    kind: 'command',
    scope: 'ai',
    audit: true,
    input: z.object({ opId: OpId, id: Id }),
    output: Receipt,
  },
});

export const setup = area('setup', {
  'Setup/begin': {
    summary:
      'Start a setup session (onboarding, or "Show welcome" from Settings); background AI waits for its end.',
    kind: 'command',
    scope: 'admin',
    input: z.object({ origin: choice(['onboarding', 'settings']) }),
    output: z.object({ setupId: Id }),
  },
  'Setup/end': {
    summary:
      'End setup; idempotent, called by the renderer and by main on any window close, and always queues the one-shot backfill of unsummarised threads.',
    kind: 'command',
    scope: 'admin',
    input: z.object({
      setupId: z.optional(Id),
      reason: choice(['finished', 'closed', 'skipped', 'demo']),
    }),
    output: Ok,
  },
  'Setup/retry': {
    summary:
      'First sync\'s "Try again" for one account: resume from its checkpoint; idempotent while a run is going.',
    kind: 'command',
    scope: 'admin',
    input: z.object({ accountId: Id, setupId: z.optional(Id) }),
    output: Ok,
  },
  'Setup/status': {
    summary:
      'First-sync progress per account for the loading screen; also pushed as `Setup` state changes.',
    kind: 'query',
    scope: 'read',
    input: z.object({ setupId: z.optional(Id) }),
    output: SetupStatus,
  },
});

export const demo = area('demo', {
  'Demo/load': {
    summary:
      'Add the demo accounts and their original demo mail; idempotent, never touches real accounts.',
    kind: 'command',
    scope: 'admin',
    uiOnly: true,
    input: Empty,
    output: z.object({ accountIds: z.array(Id), receipt: Receipt }),
  },
  'Demo/reset': {
    summary: 'Put the demo accounts back to their starting mail; refused while sending.',
    kind: 'command',
    scope: 'admin',
    audit: true,
    uiOnly: true,
    input: Empty,
    output: z.object({ accountIds: z.array(Id), receipt: Receipt }),
  },
  'Demo/remove': {
    summary: 'Remove the demo accounts and their mail.',
    kind: 'command',
    scope: 'admin',
    audit: true,
    uiOnly: true,
    input: Empty,
    output: Receipt,
  },
});

export const consent = area('consent', {
  'Consent/get': {
    summary:
      'The stored consent for background AI and whether a provider or scope change needs it again.',
    kind: 'query',
    scope: 'read',
    input: z.object({ scope: z.optional(choice(['background'])) }),
    output: Consent,
  },
  'Consent/grant': {
    summary:
      'Agree to background AI for the version shown, naming the provider and model on the card. Electron windows only: the owner must see the card (ARCH 8.3).',
    kind: 'command',
    scope: 'admin',
    uiOnly: true,
    audit: true,
    input: z.object({ scope: choice(['background']), version: Count, provider, model: line(200) }),
    output: Consent,
  },
  'Consent/revoke': {
    summary: 'Withdraw consent; background AI stops.',
    kind: 'command',
    scope: 'admin',
    audit: true,
    input: z.object({ scope: choice(['background']) }),
    output: Consent,
  },
});
