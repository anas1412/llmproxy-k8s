import type { IncomingMessage } from 'node:http';
import type { Channel } from '../../common/types.js';

/**
 * OpenAI-compatible passthrough adaptor.
 * Used for: openai, deepseek, groq, together, openrouter, and any other
 * provider that speaks the OpenAI chat completions API.
 *
 * No request transformation needed. Auth is set via the Authorization header.
 * The upstream baseURL + path is used directly.
 */
export interface PassthroughRequest {
  channel: Channel;
  upstreamKey: string;
  /** Parsed request body (the OpenAI chat completion JSON) */
  body: Buffer;
  /** Original request headers, stripped of hop-by-hop + auth headers */
  headers: Record<string, string | string[]>;
  /** The upstream path (from the incoming request, e.g. /v1/chat/completions) */
  path: string;
}

export function buildPassthroughHeaders(req: PassthroughRequest): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {
    ...req.headers,
    authorization: `Bearer ${req.upstreamKey}`,
    'content-length': String(req.body.length),
  };
  return headers;
}

export function buildPassthroughURL(channel: Channel, path: string): URL {
  return new URL(path, channel.spec.baseURL);
}

/**
 * Extract model from the request body for channel selection.
 * Returns undefined if body can't be parsed.
 */
export function extractModelFromBody(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: string };
    return parsed.model;
  } catch {
    return undefined;
  }
}

/**
 * Extract token usage from an OpenAI-compatible streaming or non-streaming response.
 * For streaming: tokens are in the last chunk's usage field.
 * For non-streaming: tokens are in response.usage.
 * Returns null if usage can't be determined (streams that never end, etc.)
 */
export function extractOpenAIUsage(body: string): { input: number; output: number; total: number } | null {
  try {
    const parsed = JSON.parse(body) as { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
    if (parsed.usage) {
      return {
        input: parsed.usage.prompt_tokens,
        output: parsed.usage.completion_tokens,
        total: parsed.usage.total_tokens,
      };
    }
  } catch {}
  return null;
}
