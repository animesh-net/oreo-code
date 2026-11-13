import type { ModelInfo, ThinkingStyle } from '../shared/protocol';

/**
 * The models come from the Mac's Ollama itself: `GET /api/tags` lists what's installed
 * and `POST /api/show` says what each can do. Nothing here names a model.
 */

/** Ollama's context when a model sets no `num_ctx`: its default below 23 GiB of memory. */
export const DEFAULT_CONTEXT_TOKENS = 4096;

/** What `POST /api/show` answers, as far as it's read here. */
export interface ShowResponse {
  /** e.g. ["completion", "tools", "thinking", "insert", "vision"]; "insert" means fill-in-the-middle. */
  capabilities?: unknown;
  details?: { family?: unknown; parameter_size?: unknown };
  /** Holds "<architecture>.context_length", the most the model was trained for. */
  model_info?: Record<string, unknown>;
  /** The Modelfile's parameters, one per line: "num_ctx 32768". */
  parameters?: unknown;
}

/** An installed model from `GET /api/tags`. */
export interface TagEntry {
  name: string;
  /** Changes when the model is replaced, so what /api/show said can be reused until then. */
  digest?: string;
  /** e.g. "4.0B", "596.05M". */
  parameterSize?: string;
}

/**
 * Reads Ollama's `GET /api/tags` body, leaving out Ollama's cloud models: they run on
 * ollama.com, not the Mac (`remote_host`/`remote_model` set, or a name ending in "cloud").
 */
export function tagsFrom(body: unknown): TagEntry[] {
  const list =
    body && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)
      ? (body as { models: unknown[] }).models
      : undefined;
  if (!list) throw new Error('Ollama returned an unexpected model list.');
  const tags: TagEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { name, model, digest, details, remote_host, remote_model } = item as {
      name?: unknown;
      model?: unknown;
      digest?: unknown;
      details?: { parameter_size?: unknown };
      remote_host?: unknown;
      remote_model?: unknown;
    };
    const id = typeof name === 'string' ? name : typeof model === 'string' ? model : undefined;
    if (!id || remote_host || remote_model || /[-:]cloud$/i.test(id)) continue;
    tags.push({
      name: id,
      digest: typeof digest === 'string' ? digest : undefined,
      parameterSize: typeof details?.parameter_size === 'string' ? details.parameter_size : undefined,
    });
  }
  return tags;
}

/** A model's size in billions of parameters from "4.0B" or "596.05M"; 0 if unknown. */
export function billions(parameterSize: string | undefined): number {
  const m = /^([\d.]+)\s*([KMBT])/i.exec(parameterSize ?? '');
  if (!m) return 0;
  const scale = { K: 1e-6, M: 1e-3, B: 1, T: 1e3 }[m[2].toUpperCase() as 'K' | 'M' | 'B' | 'T'];
  return Number(m[1]) * scale;
}

/**
 * How many characters of prompt fit a context of `tokens`: at about 3 characters a token,
 * after room for the reply (up to 8K tokens, doubled for thinking) and about a tenth for
 * the tool definitions and chat template. 32K tokens give about 66,000.
 */
export function promptBudget(tokens: number): number {
  const reply = Math.min(8192, Math.floor(tokens / 2));
  return Math.floor((tokens - reply) * 0.9 * 3);
}

/** The context a model runs with: its `num_ctx`, else Ollama's default, within what it was trained for. */
export function contextTokens(show: ShowResponse): number {
  const param = typeof show.parameters === 'string' ? /^\s*num_ctx\s+(\d+)/m.exec(show.parameters) : null;
  const trained = Object.entries(show.model_info ?? {}).find(
    ([k, v]) => k.endsWith('.context_length') && typeof v === 'number',
  )?.[1] as number | undefined;
  const tokens = param ? Number(param[1]) : DEFAULT_CONTEXT_TOKENS;
  return trained ? Math.min(tokens, trained) : tokens;
}

/** The menu's name for a model: Ollama's own, without the default ":latest" tag. */
export function displayName(id: string): string {
  return id.replace(/:latest$/, '');
}

/**
 * A model as the extension uses it, from its tag and what /api/show said (undefined if
 * that failed: then it's offered for plain chat only). Undefined for a model that can't
 * chat at all, such as an embedding model.
 */
export function modelFrom(tag: TagEntry, show: ShowResponse | undefined): ModelInfo | undefined {
  const caps = Array.isArray(show?.capabilities)
    ? (show.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
    : undefined;
  if (caps && !caps.includes('completion')) return undefined;
  const family = typeof show?.details?.family === 'string' ? show.details.family : '';
  const thinks = caps?.includes('thinking') ?? false;
  // gpt-oss always reasons, at a level; other thinking models can only think or not.
  const thinking: ThinkingStyle = !thinks ? 'none' : /gpt-?oss/i.test(family) ? 'levels' : 'switch';
  const size =
    tag.parameterSize ?? (typeof show?.details?.parameter_size === 'string' ? show.details.parameter_size : undefined);
  return {
    id: tag.name,
    name: displayName(tag.name),
    provider: 'macbook',
    supportsTools: caps?.includes('tools') ?? false,
    thinking,
    maxPromptChars: promptBudget(show ? contextTokens(show) : DEFAULT_CONTEXT_TOKENS),
    sizeB: billions(size),
    // The inline completion prompt is Qwen2.5-Coder's fill-in-the-middle format.
    completion: (caps?.includes('insert') ?? false) && /^qwen2/i.test(family),
    available: true,
  };
}

/** Largest first, as the menu lists them; same size by name. */
export function inMenuOrder(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => (b.sizeB ?? 0) - (a.sizeB ?? 0) || a.name.localeCompare(b.name));
}

/** The model picked when none is chosen: the largest that can use tools, else the largest that can't complete code. */
export function defaultModel(models: readonly ModelInfo[]): ModelInfo | undefined {
  const ordered = inMenuOrder(models.filter((m) => m.available));
  return ordered.find((m) => m.supportsTools) ?? ordered.find((m) => !m.completion) ?? ordered[0];
}

/** The model that writes inline completions: the smallest Qwen2.5-Coder-style one, as it must be quick. */
export function completionModel(models: readonly ModelInfo[]): ModelInfo | undefined {
  return inMenuOrder(models.filter((m) => m.available && m.completion)).at(-1);
}
