import OpenAI from 'openai';
import type { ModelInfo, ReasoningEffort } from '../shared/protocol';
import { OllamaHttpError } from './errors';
import { inMenuOrder, modelFrom, tagsFrom, type ShowResponse } from './models';

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
  /** Why /api/show failed for each model the last listModels couldn't describe. */
  readonly showErrors?: ReadonlyMap<string, string>;
  streamChat(
    model: string,
    messages: WireMessage[],
    signal: AbortSignal,
    effort: ReasoningEffort,
    tools?: FunctionTool[],
    /** Lower is steadier; agent mode sets it so small models follow the tool format. */
    temperature?: number,
  ): AsyncIterable<StreamEvent>;
}

type FetchLike = typeof fetch;

export const FIRST_TOKEN_TIMEOUT_MS = 10 * 60_000;

/** How often /api/show is asked about one model before it's offered for plain chat. */
export const SHOW_ATTEMPTS = 3;
/** The wait before the second ask; the third waits twice as long. */
export const SHOW_RETRY_MS = 500;

/** Waits, unless Stop or a new refresh aborts first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Room for the answer; doubled when the model thinks first. */
export const MAX_OUTPUT_TOKENS = 4096;

/**
 * Talks to Ollama on this Mac (or wherever "oreo.ollamaUrl" points):
 *  - GET  {ollama}/api/tags               -> the installed models
 *  - POST {ollama}/api/show               -> what each can do (tools, thinking, context)
 *  - POST {ollama}/v1/chat/completions    -> OpenAI-compatible, streamed over SSE
 * Ollama needs no API key; the SDK insists on one, so a placeholder is sent.
 */
export class OllamaClient implements ModelClient {
  private readonly openai: OpenAI;
  /** Each listed model's thinking style, for what to send with a chat. */
  private readonly thinking = new Map<string, ModelInfo['thinking']>();
  readonly showErrors = new Map<string, string>();

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
    const tags = tagsFrom(await res.json());
    this.showErrors.clear();
    const models = await Promise.all(tags.map(async (tag) => modelFrom(tag, await this.show(tag.name, signal))));
    const usable = models.filter((m): m is ModelInfo => !!m);
    this.thinking.clear();
    for (const m of usable) this.thinking.set(m.id, m.thinking);
    return inMenuOrder(usable);
  }

  /**
   * What Ollama says a model can do, asked up to SHOW_ATTEMPTS times: a busy Ollama (say,
   * loading a model as VS Code starts) can fail one request. Undefined if it never says,
   * with the reason in `showErrors`; the model is then offered for plain chat.
   */
  private async show(model: string, signal?: AbortSignal): Promise<ShowResponse | undefined> {
    let reason = '';
    for (let attempt = 0; attempt < SHOW_ATTEMPTS; attempt++) {
      if (attempt) await sleep(SHOW_RETRY_MS * attempt, signal);
      try {
        const res = await this.fetchImpl(`${this.ollamaUrl}/api/show`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
          signal,
        });
        if (res.ok) {
          const body: unknown = await res.json();
          if (body && typeof body === 'object') return body as ShowResponse;
          reason = "an answer that wasn't JSON";
        } else {
          const message = await readMessage(res).catch(() => '');
          reason = message ? `HTTP ${res.status}: ${message}` : `HTTP ${res.status}`;
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        reason = (err as Error).message;
      }
    }
    this.showErrors.set(model, reason);
    return undefined;
  }

  async *streamChat(
    model: string,
    messages: WireMessage[],
    signal: AbortSignal,
    effort: ReasoningEffort,
    tools?: FunctionTool[],
    temperature?: number,
  ): AsyncIterable<StreamEvent> {
    // Ollama's /v1 honours reasoning_effort: "none" turns thinking off, and on a model
    // that can only think or not (qwen3.5) any level turns it on. A model that can't
    // think gets none at all.
    const style = this.thinking.get(model) ?? 'none';
    const thinks = style !== 'none' && effort !== 'none';
    const stream = await this.openai.chat.completions.create(
      {
        model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: true,
        ...(style === 'none' ? {} : { reasoning_effort: effort }),
        // Without a cap a small model can run on until the context is full, and once
        // Ollama shifts the context it loses its place and repeats itself.
        max_tokens: thinks ? MAX_OUTPUT_TOKENS * 2 : MAX_OUTPUT_TOKENS,
        ...(tools?.length ? { tools } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      },
      { signal },
    );
    yield* readEvents(stream);
  }
}

/** The chunk fields Ollama's /v1 streams. */
type Chunk = OpenAI.Chat.ChatCompletionChunk;

/**
 * Turns an OpenAI-style stream into events: text as it arrives, a sign the model is
 * thinking (Ollama sends `delta.reasoning`, some servers `delta.reasoning_content`;
 * only their presence is passed on), and the tool calls once the stream ends, joined
 * from pieces that arrive by index. `filter` may rewrite or drop text pieces.
 */
export async function* readEvents(
  stream: AsyncIterable<Chunk>,
  filter: (text: string) => string = (t) => t,
): AsyncIterable<StreamEvent> {
  const calls: ToolCall[] = [];
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as
      (Chunk['choices'][number]['delta'] & { reasoning?: unknown; reasoning_content?: unknown }) | undefined;
    if (delta?.reasoning || delta?.reasoning_content) yield { type: 'thinking' };
    const text = delta?.content ? filter(delta.content) : '';
    if (text) yield { type: 'text', text };
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
