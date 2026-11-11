import OpenAI from 'openai';
import {
  FIRST_TOKEN_TIMEOUT_MS,
  readEvents,
  type FunctionTool,
  type ModelClient,
  type StreamEvent,
  type WireMessage,
} from '../ollama/client';
import { OREO_MODELS } from '../ollama/models';
import type { ModelInfo, ReasoningEffort } from '../shared/protocol';

type FetchLike = typeof fetch;

/** Room for the answer; doubled for a model that reasons first, as in oreo-ai. */
export const MAX_OUTPUT_TOKENS = 4096;

/** The Workers AI models, all usable once an account id and token are set. */
export function cloudModels(): ModelInfo[] {
  return OREO_MODELS.filter((m) => m.provider === 'cloudflare').map((m) => ({ ...m, available: true }));
}

/**
 * Talks to Cloudflare Workers AI's OpenAI-compatible endpoint
 * (https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1/chat/completions), sending
 * the thinking setting the way oreo-ai does: Qwen3 is switched off with "/no_think" in
 * the system message, gpt-oss takes a reasoning_effort (low for Off, as it always
 * reasons). Whatever is sent here leaves the Mac.
 */
export class CloudflareClient implements ModelClient {
  private readonly openai: OpenAI;

  constructor(accountId: string, apiToken: string, fetchImpl: FetchLike = fetch) {
    this.openai = new OpenAI({
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`,
      apiKey: apiToken,
      fetch: fetchImpl,
      maxRetries: 0,
      timeout: FIRST_TOKEN_TIMEOUT_MS,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    return cloudModels();
  }

  async *streamChat(
    model: string,
    messages: WireMessage[],
    signal: AbortSignal,
    effort: ReasoningEffort,
    tools?: FunctionTool[],
  ): AsyncIterable<StreamEvent> {
    const levels = OREO_MODELS.find((m) => m.id === model)?.thinking === 'levels';
    const think = effort !== 'none';
    const stream = await this.openai.chat.completions.create(
      {
        model,
        messages: (levels || think ? messages : noThink(messages)) as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: true,
        max_tokens: levels || think ? MAX_OUTPUT_TOKENS * 2 : MAX_OUTPUT_TOKENS,
        ...(levels ? { reasoning_effort: think ? effort : 'low' } : {}),
        ...(tools?.length ? { tools } : {}),
      },
      { signal },
    );
    yield* readEvents(stream, thinkFilter());
  }
}

/** Qwen3 thinks unless "/no_think" is in the system message. */
function noThink(messages: WireMessage[]): WireMessage[] {
  if (messages[0]?.role === 'system') {
    return [{ role: 'system', content: `${messages[0].content}\n\n/no_think` }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: '/no_think' }, ...messages];
}

/**
 * Qwen3 on Workers AI may put its thinking in the text as a leading
 * <think>…</think> block (empty when thinking is off); this drops it.
 */
export function thinkFilter(): (text: string) => string {
  let buffer = '';
  let state: 'start' | 'inside' | 'done' = 'start';
  return (piece) => {
    if (state === 'done') return piece;
    buffer += piece;
    if (state === 'start') {
      const trimmed = buffer.trimStart();
      if (!trimmed) return '';
      if ('<think>'.startsWith(trimmed)) return ''; // could still become "<think>"
      if (!trimmed.startsWith('<think>')) {
        state = 'done';
        const out = buffer;
        buffer = '';
        return out;
      }
      state = 'inside';
    }
    const end = buffer.indexOf('</think>');
    if (end < 0) return '';
    state = 'done';
    const out = buffer.slice(end + '</think>'.length).replace(/^\s+/, '');
    buffer = '';
    return out;
  };
}
