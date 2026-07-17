import type { Channel } from '../../common/types.js';

/**
 * Anthropic Messages API adaptor.
 * Converts OpenAI chat completion format → Anthropic Messages API format.
 *
 * POST https://api.anthropic.com/v1/messages
 * Headers: x-api-key, anthropic-version
 *
 * Transformation:
 *   OpenAI                                    → Anthropic
 *   { model, messages, max_tokens?, ... }     → { model, messages, max_tokens, system? (extracted) }
 *
 * Note: Anthropic requires system messages to be a top-level field, not in messages[].
 * OpenAI's "system" role messages are extracted and moved.
 */
export interface AnthropicAdaptedRequest {
  channel: Channel;
  upstreamKey: string;
  /** Transformed Anthropic JSON body */
  body: string;
  /** Request headers (from client, stripped) + anthropic auth */
  headers: Record<string, string | string[]>;
}

interface OpenAIMessage {
  role: string;
  content: string | unknown[];
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  [key: string]: unknown;
}

interface AnthropicContent {
  type: string;
  text?: string;
  source?: unknown;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContent[];
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

export function convertOpenAIToAnthropic(body: Buffer): AnthropicAdaptedRequest | null {
  let parsed: OpenAIChatRequest;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }

  const systemMessages: string[] = [];
  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of parsed.messages ?? []) {
    if (msg.role === 'system') {
      systemMessages.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      anthropicMessages.push({ role: msg.role, content: msg.content as string | AnthropicContent[] });
    }
  }

  const anthropic: AnthropicRequest = {
    model: parsed.model,
    messages: anthropicMessages,
    max_tokens: parsed.max_tokens ?? parsed.max_completion_tokens ?? 4096,
  };

  if (systemMessages.length > 0) {
    anthropic.system = systemMessages.join('\n\n');
  }
  if (parsed.temperature !== undefined) anthropic.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) anthropic.top_p = parsed.top_p;
  if (parsed.stop) {
    anthropic.stop_sequences = Array.isArray(parsed.stop) ? parsed.stop : [parsed.stop];
  }
  if (parsed.stream !== undefined) anthropic.stream = parsed.stream;

  return {
    channel: undefined as unknown as Channel, // filled by caller
    upstreamKey: '', // filled by caller
    body: JSON.stringify(anthropic),
    headers: {},
  };
}

export function buildAnthropicURL(channel: Channel): URL {
  return new URL('/v1/messages', channel.spec.baseURL);
}

export function extractAnthropicUsage(body: string): { input: number; output: number; total: number } | null {
  try {
    const parsed = JSON.parse(body) as {
      usage?: { input_tokens: number; output_tokens: number };
    };
    if (parsed.usage) {
      return {
        input: parsed.usage.input_tokens,
        output: parsed.usage.output_tokens,
        total: parsed.usage.input_tokens + parsed.usage.output_tokens,
      };
    }
  } catch {}
  return null;
}
