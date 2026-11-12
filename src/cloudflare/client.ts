import OpenAI from 'openai';
import {
  FIRST_TOKEN_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  readEvents,
  type FunctionTool,
  type ModelClient,
  type StreamEvent,
  type WireMessage,
} from '../ollama/client';
import { OREO_MODELS } from '../ollama/models';
import { RelayHttpError } from './errors';
import type { ModelInfo, ReasoningEffort } from '../shared/protocol';

type FetchLike = typeof fetch;

export { MAX_OUTPUT_TOKENS };

/** How long the model list may take; over Tailscale a missing route otherwise hangs. */
export const LIST_TIMEOUT_MS = 10_000;

/** The Workers AI models, each available only if the relay lists it. */
export function cloudModels(listed: ReadonlySet<string> = new Set()): ModelInfo[] {
  return OREO_MODELS.filter((m) => m.provider === 'cloudflare').map((m) => ({ ...m, available: listed.has(m.id) }));
}

/**
 * Talks to Cloudflare Workers AI through oreo-ai's relay on the Pi ("oreo.cloudUrl",
 * reachable over Tailscale only), which adds the Pi's Cloudflare token:
 *  - GET  {relay}/models              -> the Workers AI models oreo-ai offers
 *  - POST {relay}/chat/completions    -> Workers AI's OpenAI-compatible chat, relayed unchanged
 * It sends the thinking setting the way oreo-ai does: Qwen3 is switched off with
 * "/no_think" in the system message, gpt-oss takes a reasoning_effort (low for Off, as it
 * always reasons). The relay needs no API key; the SDK insists on one, so a placeholder
 * is sent. Whatever is sent here leaves the Mac.
 */
export class CloudflareClient implements ModelClient {
  private readonly openai: OpenAI;

  constructor(
    private readonly relayUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.openai = new OpenAI({
      baseURL: relayUrl,
      apiKey: 'oreo-ai',
      fetch: fetchImpl,
      maxRetries: 0,
      timeout: FIRST_TOKEN_TIMEOUT_MS,
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.fetchImpl(`${this.relayUrl}/models`, {
      headers: { Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => undefined)) as
      { data?: unknown; error?: { message?: unknown } } | undefined;
    if (!res.ok) {
      const message = body?.error?.message;
      throw new RelayHttpError(res.status, typeof message === 'string' ? message : undefined);
    }
    if (!Array.isArray(body?.data)) throw new Error('oreo-ai returned an unexpected model list.');
    const listed = new Set<string>();
    for (const item of body.data as unknown[]) {
      const id = (item as { id?: unknown } | null)?.id;
      if (typeof id === 'string') listed.add(id);
    }
    return cloudModels(listed);
  }

  async *streamChat(
    model: string,
    messages: WireMessage[],
    signal: AbortSignal,
    effort: ReasoningEffort,
    tools?: FunctionTool[],
    temperature?: number,
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
        ...(temperature !== undefined ? { temperature } : {}),
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
