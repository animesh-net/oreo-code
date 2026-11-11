import OpenAI from 'openai';
import type { ChatMessage, ModelInfo, ReasoningEffort } from '../shared/protocol';
import { OllamaHttpError } from './errors';
import { modelsFromTags } from './models';

/** What the chat controller needs from Ollama. */
export interface ModelClient {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  streamChat(
    model: string,
    messages: ChatMessage[],
    signal: AbortSignal,
    effort: ReasoningEffort,
  ): AsyncIterable<string>;
}

type FetchLike = typeof fetch;

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
      timeout: 120_000,
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
    messages: ChatMessage[],
    signal: AbortSignal,
    effort: ReasoningEffort,
  ): AsyncIterable<string> {
    // Ollama's /v1 honours reasoning_effort: "none" turns thinking off, and on a model
    // that can only think or not (qwen3.5) any level turns it on.
    const stream = await this.openai.chat.completions.create(
      { model, messages, stream: true, reasoning_effort: effort },
      { signal },
    );
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) yield text;
    }
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
