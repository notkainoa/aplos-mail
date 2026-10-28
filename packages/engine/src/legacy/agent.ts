import type { AskStep } from '@aplos/contract/legacy/types';

/**
 * A small tool-using agent loop over an OpenAI-compatible chat API (Groq). Platform-free: the transport is
 * injected as `chat`, tools are plain functions. Bounded by steps, per-call and total timeouts, a context
 * budget and the caller's abort signal. Tool results are data for the model, never instructions to us:
 * nothing here acts on the mailbox; tools decide what they return.
 */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  /** `raw` is a provider's own content for this turn (e.g. Claude's thinking blocks), replayed only to that provider. */
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
      raw?: unknown;
    }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };
/** `session` is a stable ID per conversation, for providers that route or cache by it. */
/** `json` asks for a single JSON object (summaries, drafts, plans); providers with a JSON mode turn it on. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  session?: string;
  json?: boolean;
}
export interface ChatTurn {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: { prompt: number; completion: number };
  raw?: unknown;
}
export interface ChatOptions {
  signal?: AbortSignal;
  onText?: (text: string) => void;
}
export type Chat = (request: ChatRequest, options: ChatOptions) => Promise<ChatTurn>;

export interface ToolResult {
  data: unknown;
  label?: string;
  count?: number;
}
export interface AgentTool {
  spec: ToolSpec;
  /** A calm, human line for the step list, e.g. `Searched mail for "invoice"`. */
  label(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> | ToolResult;
}
/** A problem the model can fix by calling again differently; its message is returned to the model. */
export class ToolError extends Error {}

export type AgentEvent =
  { type: 'text'; text: string } | { type: 'reset' } | { type: 'step'; step: AskStep };
export interface AgentOptions {
  chat: Chat;
  model: string;
  messages: ChatMessage[];
  tools: AgentTool[];
  session?: string;
  signal?: AbortSignal;
  /** Model calls, including the final answer. The last one is made without tools. */
  maxSteps?: number;
  stepTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Serialized characters of conversation sent per call; older tool results are trimmed first. */
  budget?: number;
  maxCallsPerStep?: number;
  onEvent?: (event: AgentEvent) => void;
}
export interface AgentResult {
  content: string;
  steps: AskStep[];
  stopped?: 'max-steps';
  usage: { calls: number; prompt: number; completion: number };
}

const RESULT_LIMIT = 16_000;
const TRIMMED =
  '{"trimmed":true,"note":"Older result removed to save space. Call the tool again if you still need it."}';

const size = (messages: ChatMessage[]) => JSON.stringify(messages).length;
/** Keeps the request under budget: older tool results go first, then the oldest history, then the latest results shrink. */
export function fitBudget(messages: ChatMessage[], budget: number, historyEnd: number) {
  if (size(messages) <= budget) return messages;
  const lastCall = messages.findLastIndex(m => m.role === 'assistant' && !!m.tool_calls?.length);
  for (let i = 0; i < lastCall && size(messages) > budget; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content !== TRIMMED) messages[i] = { ...m, content: TRIMMED };
  }
  // History is plain user/assistant text before the current question, so dropping it never orphans a tool result.
  while (size(messages) > budget && historyEnd > 1) {
    messages.splice(1, 1);
    historyEnd--;
  }
  for (let guard = 0; size(messages) > budget && guard < 20; guard++) {
    let longest = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (
        m.role === 'tool' &&
        (longest < 0 ||
          m.content.length > (messages[longest] as { content: string }).content.length)
      )
        longest = i;
    }
    const m = messages[longest];
    if (!m || m.role !== 'tool' || m.content.length < 400) break;
    messages[longest] = {
      ...m,
      content: m.content.slice(0, Math.floor(m.content.length / 2)) + '…(truncated)',
    };
  }
  return messages;
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('AI request cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new Error('AI request cancelled.'));
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}
function parseArgs(raw: string): Record<string, unknown> | undefined {
  const source = raw.trim() || '{}';
  try {
    const value = JSON.parse(source);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { chat, model, tools, onEvent } = options;
  const maxSteps = Math.max(1, options.maxSteps ?? 6),
    maxCalls = options.maxCallsPerStep ?? 6,
    budget = options.budget ?? 120_000;
  const totalMs = options.totalTimeoutMs ?? 120_000,
    deadline = Date.now() + totalMs,
    total = AbortSignal.timeout(totalMs);
  const messages = [...options.messages];
  const historyEnd = Math.max(
    1,
    messages.findLastIndex(m => m.role === 'user'),
  );
  const specs = tools.map(t => t.spec),
    byName = new Map(tools.map(t => [t.spec.name, t]));
  const steps: AskStep[] = [];
  const seen = new Map<string, string>();
  let malformed = 0,
    callCount = 0,
    waits = 0;
  const usage = { calls: 0, prompt: 0, completion: 0 };
  const step = (value: AskStep) => {
    const index = steps.findIndex(s => s.id === value.id);
    if (index < 0) steps.push(value);
    else steps[index] = value;
    onEvent?.({ type: 'step', step: { ...value } });
  };
  const fail = (stepSignal: AbortSignal, error: unknown): never => {
    if (options.signal?.aborted) throw new Error('AI request cancelled.');
    if (total.aborted) throw new Error('Ask took too long to finish. Try a narrower question.');
    if (stepSignal.aborted) throw new Error('Groq took too long to answer. Please try again.');
    throw error;
  };
  for (let index = 0; index < maxSteps; index++) {
    // The last call has no tools, so the loop always ends with an answer.
    const last = index === maxSteps - 1 || malformed >= 2;
    if (last && index > 0)
      messages.push({
        role: 'system',
        content: 'Answer the user now with what you have found. Do not call tools.',
      });
    fitBudget(messages, budget, historyEnd);
    const stepSignal = AbortSignal.timeout(options.stepTimeoutMs ?? 30_000);
    const signal = AbortSignal.any([
      total,
      stepSignal,
      ...(options.signal ? [options.signal] : []),
    ]);
    let streamed = false,
      turn: ChatTurn;
    try {
      turn = await chat(
        {
          model,
          messages,
          ...(options.session ? { session: options.session } : {}),
          ...(specs.length ? { tools: specs, toolChoice: last ? 'none' : 'auto' } : {}),
        },
        {
          signal,
          onText: text => {
            if (!text) return;
            streamed = true;
            onEvent?.({ type: 'text', text });
          },
        },
      );
    } catch (error) {
      if (streamed) onEvent?.({ type: 'reset' });
      // Groq's free tier allows a few thousand tokens a minute; wait out the window when it fits in the time left, then repeat this step.
      const retryAfter =
        (error as { code?: unknown })?.code === 'rate_limited'
          ? Math.max(
              1_000,
              Number((error as { retryAfterMs?: unknown }).retryAfterMs ?? 5_000) || 5_000,
            )
          : NaN;
      if (
        retryAfter <= 65_000 &&
        Date.now() + retryAfter < deadline - 5_000 &&
        waits < 6 &&
        !signal.aborted
      ) {
        waits++;
        const id = `w${waits}`,
          label = `Waiting for Groq · about ${Math.ceil(retryAfter / 1000)} s`;
        step({ id, tool: 'wait', label, status: 'running' });
        await pause(
          retryAfter,
          AbortSignal.any([total, ...(options.signal ? [options.signal] : [])]),
        ).catch(error => fail(stepSignal, error));
        // The wait is not part of the answer, so it leaves the saved steps once it is over.
        steps.splice(
          steps.findIndex(s => s.id === id),
          1,
        );
        onEvent?.({ type: 'step', step: { id, tool: 'wait', label, status: 'done' } });
        index--;
        continue;
      }
      // Groq rejects a malformed tool call the model generated (400 tool_use_failed); ask again, then answer without tools.
      if (
        (error as { code?: unknown })?.code === 'tool_use_failed' &&
        !signal.aborted &&
        malformed < 2
      ) {
        malformed++;
        messages.push({
          role: 'system',
          content:
            'Your previous tool call could not be parsed. Call one tool at a time with valid JSON arguments that match its schema, or answer directly.',
        });
        continue;
      }
      return fail(stepSignal, error);
    }
    if (signal.aborted) fail(stepSignal, new Error('AI request cancelled.'));
    usage.calls++;
    if (turn.usage) {
      usage.prompt += turn.usage.prompt;
      usage.completion += turn.usage.completion;
    }
    if (!turn.toolCalls.length) return { content: turn.content.trim(), steps, usage };
    if (streamed) onEvent?.({ type: 'reset' });
    if (last) {
      if (turn.content.trim()) return { content: turn.content.trim(), steps, usage };
      break;
    }
    const calls = turn.toolCalls.map((c, i) => ({ ...c, id: c.id || `call_${index}_${i}` }));
    messages.push({
      role: 'assistant',
      content: turn.content || null,
      ...(turn.raw !== undefined ? { raw: turn.raw } : {}),
      tool_calls: calls.map(c => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments || '{}' },
      })),
    });
    // Independent calls from one step run at the same time; results go back in the order the model asked.
    const toolSignal = AbortSignal.any([total, ...(options.signal ? [options.signal] : [])]);
    const run = async (call: (typeof calls)[number], i: number, id: string): Promise<string> => {
      const tool = byName.get(call.name),
        args = parseArgs(call.arguments);
      if (i >= maxCalls)
        return JSON.stringify({
          error: `Only ${maxCalls} tool calls are run per step. Call the rest next.`,
        });
      if (!tool) {
        step({ id, tool: 'unknown', label: 'Tried an unknown tool', status: 'error' });
        return JSON.stringify({
          error: `Unknown tool "${call.name.slice(0, 60)}". Use only the listed tools.`,
        });
      }
      if (!args) {
        step({ id, tool: call.name, label: tool.label({}), status: 'error' });
        return JSON.stringify({
          error: 'Arguments must be a JSON object matching the tool schema.',
        });
      }
      const key = call.name + JSON.stringify(args),
        label = tool.label(args);
      const repeat = seen.get(key);
      if (repeat) return repeat;
      step({ id, tool: call.name, label, status: 'running' });
      try {
        const result = await tool.run(args, toolSignal);
        let content = JSON.stringify(result.data ?? null);
        if (content.length > RESULT_LIMIT)
          content = content.slice(0, RESULT_LIMIT) + '…(truncated)';
        seen.set(key, content);
        step({
          id,
          tool: call.name,
          label: result.label ?? label,
          ...(result.count !== undefined ? { count: result.count } : {}),
          status: 'done',
        });
        return content;
      } catch (error) {
        if (toolSignal.aborted) return fail(stepSignal, error);
        // Tool problems go back to the model so it can correct the call; nothing internal leaks.
        step({ id, tool: call.name, label, status: 'error' });
        return JSON.stringify({
          error:
            error instanceof ToolError
              ? error.message
              : 'This tool failed. Try again differently or answer with what you have.',
        });
      }
    };
    const results = await Promise.all(calls.map((call, i) => run(call, i, `s${++callCount}`)));
    calls.forEach((call, i) =>
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: results[i] }),
    );
  }
  return {
    content: 'I couldn’t finish looking this up within the step limit. Try a narrower question.',
    steps,
    stopped: 'max-steps',
    usage,
  };
}
