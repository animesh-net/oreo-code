import OpenAI from 'openai';
import type { ModelInfo, ReasoningEffort } from '../shared/protocol';
import { OllamaHttpError } from './errors';
import { modelsFromTags } from './models';

/** A message as sent to Ollama, including the system prompt and tool turns. */
export type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** An OpenAI-style function definition. */
export interface FunctionTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Text as it streams, a sign the model is thinking, then any tool calls once complete. */
export type StreamEvent =
  { type: 'text'; text: string } | { type: 'thinking' } | { type: 'toolCalls'; calls: ToolCall[] };

/** What the chat controller needs from Ollama. */
export interface ModelClient {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  streamChat(
    model: string,
    messages: WireMessage[],
    signal: AbortSignal,
    effort: ReasoningEffort,
    tools?: FunctionTool[],
  ): AsyncIterable<StreamEvent>;
}

type FetchLike = typeof fetch;

export const FIRST_TOKEN_TIMEOUT_MS = 10 * 60_000;

/**
 * Talks to Ollama on this Mac (or wherever "oreo.ollamaUrl" points):
 *  - GET  {ollama}/api/tags               -> which Oreo models are installed
 *  - POST {ollama}/v1/chat/completions    -> OpenAI-compatible, streamed over SSE
 * Ollama needs no API key; the SDK insists on one, so a placeholder is sent.
 */
export class OllamaClient implements ModelClient {
  private readonly openai: OpenAI;

  constructor(
    private readonly ollamaUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.openai = new OpenAI({
      baseURL: `${ollamaUrl}/v1`,
      apiKey: 'ollama',
      fetch: fetchImpl,
      maxRetries: 0,
      // How long Ollama may take to start answering. On an 8 GB M1, loading the model and
      // reading a long prompt (repo snapshot, file contents) can take minutes; a reply
      // that has started streaming is never cut off by this.
      timeout: FIRST_TOKEN_TIMEOUT_MS,
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.fetchImpl(`${this.ollamaUrl}/api/tags`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) throw new OllamaHttpError(res.status, await readMessage(res));
    return modelsFromTags(await res.json());
  }

  async *streamChat(
    model: string,
    messages: WireMessage[],
    signal: AbortSignal,
    effort: ReasoningEffort,
    tools?: FunctionTool[],
  ): AsyncIterable<StreamEvent> {
    // Ollama's /v1 honours reasoning_effort: "none" turns thinking off, and on a model
    // that can only think or not (qwen3.5) any level turns it on.
    const stream = await this.openai.chat.completions.create(
      {
        model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: true,
        reasoning_effort: effort,
        ...(tools?.length ? { tools } : {}),
      },
      { signal },
    );
    // Tool calls may arrive in pieces, by index; they are passed on once the stream ends.
    const calls: ToolCall[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      // Ollama's /v1 streams a thinking model's reasoning as delta.reasoning; only its
      // presence is passed on, so the view can say the model is thinking.
      if ((delta as { reasoning?: unknown } | undefined)?.reasoning) yield { type: 'thinking' };
      if (delta?.content) yield { type: 'text', text: delta.content };
      for (const part of delta?.tool_calls ?? []) {
        const call = (calls[part.index] ??= {
          id: part.id ?? `call_${part.index}`,
          type: 'function',
          function: { name: '', arguments: '' },
        });
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
      }
    }
    const complete = calls.filter((c) => c?.function.name);
    if (complete.length) yield { type: 'toolCalls', calls: complete };
  }
}

async function readMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    // Ollama's native API answers { "error": "..." }; its /v1 uses { "error": { "message": "..." } }.
    if (typeof body.error === 'string') return body.error;
    const nested = (body.error as { message?: unknown } | null | undefined)?.message;
    if (typeof nested === 'string') return nested;
  } catch {
    // Not JSON; fall back to the status code.
  }
  return undefined;
}
