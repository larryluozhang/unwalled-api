import type {
  ChatCompletionResponse,
  ChatMessage,
  ChatToolChoice,
  ChatToolCall,
  TokenUsage,
  Platform,
} from '@freellmapi/shared/types.js';
import { contentToString } from './content.js';

/**
 * Upstream OpenAI **Responses** API support for OpenAI-compatible gateways that
 * serve some models ONLY through /v1/responses (AgentRouter's gpt-6-astra
 * answers /v1/chat/completions with
 * "模型不支持 /v1/chat/completions，请改用 /v1/responses", verified live
 * 2026-11-15; its /v1/responses non-stream, SSE stream and function tool calls
 * all work — gated on a `claude-cli` User-Agent, see providers/index.ts).
 *
 * The converters here are the mirror image of routes/responses.ts (which
 * translates inbound Responses requests DOWN to chat completions): these
 * translate our internal chat shape UP to a Responses request and normalize
 * the Responses result back into ChatCompletionResponse/Chunk, so the router,
 * fallback loop, redaction and usage accounting keep working unchanged.
 * Reuses the conversion idioms proven by providers/sail.ts (the other native
 * Responses upstream).
 */

const AGENTROUTER_HOST = 'agentrouter.org';

/** Whether a base URL points at AgentRouter's API (agentrouter.org or a
 * subdomain). False for anything that does not parse as a URL. */
export function isAgentRouterEndpoint(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === AGENTROUTER_HOST || host.endsWith(`.${AGENTROUTER_HOST}`);
}

/** Models served ONLY through the upstream Responses API (chat/completions is
 * a hard 400: "模型 … 不支持 /v1/chat/completions 接口，请改用 /v1/responses",
 * verified live 2026-11-15 for all three ids in AgentRouter's /models
 * catalog). Gated on BOTH the host and the model id so no other platform's
 * identically-named model is affected. */
export const AGENTROUTER_RESPONSES_ONLY_MODELS = new Set(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6.1-sol']);

/** The built-in 'agentrouter' platform's fixed upstream base URL. */
export const AGENTROUTER_BASE_URL = 'https://agentrouter.org/v1';

/** The claude-cli User-Agent AgentRouter's /v1/responses and /v1/models gate on
 *  (non-claude-cli UAs get "unauthorized client detected"; live-verified
 *  2026-11-15). Overridable via CHE_CUSTOM_AGENTROUTER_UA / CHE_AGENTROUTER_UA. */
export const AGENTROUTER_DEFAULT_UA = 'claude-cli/2.1.301 (external, sdk-cli)';

export function agentRouterUserAgent(): string {
  return process.env.CHE_CUSTOM_AGENTROUTER_UA
    ?? process.env.CHE_AGENTROUTER_UA
    ?? AGENTROUTER_DEFAULT_UA;
}

/** che.24: the built-in 'agentrouter' platform has a fixed base URL, so the
 *  platform check alone is sufficient there; the custom path still requires the
 *  endpoint host to actually be AgentRouter before switching wires. */
export function usesResponsesUpstream(baseUrl: string, platform: string, modelId: string): boolean {
  if (!AGENTROUTER_RESPONSES_ONLY_MODELS.has(modelId)) return false;
  return platform === 'agentrouter'
    || (platform === 'custom' && isAgentRouterEndpoint(baseUrl));
}

// ── Request building ─────────────────────────────────────────────────────

/** Chat Completions history → Responses `input` items (mirror of
 * routes/responses.ts toChatMessages). System/developer content is hoisted
 * into `instructions` by buildResponsesBody; everything else maps directly:
 * assistant tool_calls → function_call items, tool results →
 * function_call_output items. Moonshot's `partial` flag and the reasoning
 * extension have no Responses equivalent and are stripped. */
export function responsesInputItems(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'system') continue; // hoisted into `instructions`
    const text = contentToString(message.content);
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? message.name ?? 'unknown_call',
        output: text,
      });
      continue;
    }
    if (text || !message.tool_calls?.length) {
      input.push({ role: message.role, content: text });
    }
    for (const call of message.tool_calls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  return input;
}

/** Responses `tool_choice` shape differs from chat's: a named choice is
 * `{ type: 'function', name }`, not `{ type: 'function', function: { name } }`. */
export function responsesToolChoice(choice: ChatToolChoice | undefined): unknown {
  if (!choice || typeof choice === 'string') return choice;
  return { type: 'function', name: choice.function.name };
}

export function buildResponsesBody(
  messages: ChatMessage[],
  modelId: string,
  options?: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    tools?: { type: string; function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean } }[];
    tool_choice?: ChatToolChoice;
    parallel_tool_calls?: boolean;
    response_format?: { type: string; json_schema?: { name?: string; strict?: boolean; schema?: Record<string, unknown> } };
  },
): Record<string, unknown> {
  // Multiple system messages (gateway-prepended + client's own) coalesce into
  // one `instructions` string, the Responses-era system channel.
  const instructions = messages
    .filter(m => m.role === 'system')
    .map(m => contentToString(m.content))
    .filter(Boolean)
    .join('\n\n');
  const tools = options?.tools?.map(tool => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: tool.function.strict,
  }));
  const format = options?.response_format;
  const textFormat = !format ? undefined : format.type === 'json_schema'
    ? {
      type: 'json_schema',
      name: format.json_schema?.name ?? 'response',
      schema: format.json_schema?.schema ?? { type: 'object' },
      strict: format.json_schema?.strict ?? false,
    }
    // Responses has no `json_object`; a permissive schema is the supported
    // equivalent (same substitution providers/sail.ts makes).
    : { type: 'json_schema', name: 'response', schema: { type: 'object', additionalProperties: true }, strict: false };

  return {
    model: modelId,
    input: responsesInputItems(messages),
    ...(instructions ? { instructions } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.max_tokens !== undefined ? { max_output_tokens: options.max_tokens } : {}),
    ...(options?.top_p !== undefined ? { top_p: options.top_p } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(options?.tool_choice !== undefined ? { tool_choice: responsesToolChoice(options.tool_choice) } : {}),
    ...(options?.parallel_tool_calls !== undefined ? { parallel_tool_calls: options.parallel_tool_calls } : {}),
    ...(textFormat ? { text: { format: textFormat } } : {}),
    // `stop` has no Responses equivalent and is dropped (same as Sail).
  };
}

// ── Response normalization ───────────────────────────────────────────────

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface ResponsesOutputItem {
  type?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface ResponsesResult {
  id?: string;
  model?: string;
  created_at?: number;
  status?: string;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
}

export function responsesUsageOf(usage?: ResponsesUsage): TokenUsage {
  return {
    prompt_tokens: usage?.input_tokens ?? 0,
    completion_tokens: usage?.output_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    prompt_tokens_details: { cached_tokens: usage?.input_tokens_details?.cached_tokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? 0 },
  };
}

/** The chat finish_reason a terminal Responses status maps to. */
export function responsesFinishReason(result: ResponsesResult, toolCallCount: number): string {
  if (toolCallCount > 0) return 'tool_calls';
  if (result.status === 'incomplete') return 'length';
  return 'stop';
}

export function normalizeResponsesToChat(
  result: ResponsesResult,
  modelId: string,
  platform: string,
  makeId: () => string,
): ChatCompletionResponse {
  const text = (result.output ?? [])
    .filter(item => item.type === 'message')
    .flatMap(item => item.content ?? [])
    .filter(content => content.type === 'output_text' && typeof content.text === 'string')
    .map(content => content.text as string)
    .join('');
  const toolCalls: ChatToolCall[] = (result.output ?? [])
    .filter(item => item.type === 'function_call' && typeof item.name === 'string')
    .map((item, index) => ({
      id: item.call_id ?? item.id ?? `call_resp_${index + 1}`,
      type: 'function',
      function: {
        name: item.name as string,
        arguments: item.arguments ?? '{}',
      },
    }));
  const out: ChatCompletionResponse = {
    id: result.id ?? makeId(),
    object: 'chat.completion',
    created: result.created_at ?? Math.floor(Date.now() / 1000),
    model: result.model ?? modelId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: responsesFinishReason(result, toolCalls.length),
    }],
    usage: responsesUsageOf(result.usage),
  };
  out._routed_via = { platform: platform as Platform, model: modelId };
  return out;
}
