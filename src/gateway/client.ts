import OpenAI from 'openai';
import type { ChatMessage, ModelInfo } from '../shared/protocol';
import { GatewayHttpError } from './errors';

/** What the chat controller needs from oreo-ai. */
export interface Gateway {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  streamChat(model: string, messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
}

type FetchLike = typeof fetch;

/**
 * Talks to the oreo-ai model gateway on the Pi:
 *  - GET  {server}/api/models                 -> { models: [{ id, name, provider, supportsTools, available }] }
 *    Four models: two on Cloudflare Workers AI, two on the MacBook's Ollama.
 *  - POST {server}/api/llm/v1/chat/completions -> OpenAI-compatible, streamed
 * Every call carries the user's oreo-ai API token as a bearer token.
 */
export class OreoGateway implements Gateway {
  private readonly openai: OpenAI;

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.openai = new OpenAI({
      baseURL: `${serverUrl}/api/llm/v1`,
      apiKey: token,
      fetch: fetchImpl,
      // The gateway enforces its own limits; retrying a 429 just burns the budget.
      maxRetries: 0,
      timeout: 120_000,
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.fetchImpl(`${this.serverUrl}/api/models`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal,
    });
    if (!res.ok) throw new GatewayHttpError(res.status, await readMessage(res));
    return parseModels(await res.json());
  }

  async *streamChat(model: string, messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
    const stream = await this.openai.chat.completions.create({ model, messages, stream: true }, { signal });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) yield text;
    }
  }
}

/**
 * Accepts `{ models: [...] }` or a bare array; drops entries without an id.
 * Missing fields default safely: provider "cloudflare", no tools, available.
 */
export function parseModels(body: unknown): ModelInfo[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)
      ? (body as { models: unknown[] }).models
      : undefined;
  if (!list) throw new Error('oreo-ai returned an unexpected model list.');
  const models: ModelInfo[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== 'string' || !m.id) continue;
    models.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      provider: m.provider === 'macbook' ? 'macbook' : 'cloudflare',
      supportsTools: m.supportsTools === true,
      available: m.available !== false,
    });
  }
  return models;
}

async function readMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === 'string') return body.message;
    if (typeof body.error === 'string') return body.error;
    // oreo-ai answers in the OpenAI shape: { "error": { "message": "..." } }.
    const nested = (body.error as { message?: unknown } | null | undefined)?.message;
    if (typeof nested === 'string') return nested;
  } catch {
    // Not JSON; fall back to the status code.
  }
  return undefined;
}
