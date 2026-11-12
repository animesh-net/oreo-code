import type { ModelInfo } from '../shared/protocol';

/**
 * The only models the extension offers, named once here and kept in sync with oreo-ai
 * (same ids, labels and order): two on Cloudflare Workers AI, as in oreo-ai, and three
 * on this Mac's Ollama, created from the Modelfiles in oreo-ai's `ollama/` folder.
 * Listed largest first, the order the menu shows them in. The prompt budgets keep
 * within each context window at about 3 characters a token, leaving room for the reply.
 * Every display name is "Oreo <size>" (parameters, upper-case B); the menu's groups
 * say where each runs, and the id is the provider's own name for it. `defaultRank`
 * is the order a model is picked in when none is chosen; one without it is only
 * picked by hand.
 */
export const OREO_MODELS: readonly Omit<ModelInfo, 'available'>[] = [
  // gpt-oss has a 128K context and always reasons; Qwen3 32K and a thinking switch.
  {
    id: '@cf/openai/gpt-oss-120b',
    name: 'Oreo 120B',
    provider: 'cloudflare',
    supportsTools: true,
    thinking: 'levels',
    maxPromptChars: 200_000,
    defaultRank: 4,
  },
  {
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    name: 'Oreo 30B',
    provider: 'cloudflare',
    supportsTools: true,
    thinking: 'switch',
    maxPromptChars: 66_000,
    defaultRank: 3,
  },
  // Both are qwen3.5 with a 32K context, which can only think or not.
  {
    id: 'oreo-4b',
    name: 'Oreo 4B',
    provider: 'macbook',
    supportsTools: true,
    thinking: 'switch',
    maxPromptChars: 66_000,
    defaultRank: 1,
  },
  {
    id: 'oreo-2b',
    name: 'Oreo 2B',
    provider: 'macbook',
    supportsTools: false,
    thinking: 'switch',
    maxPromptChars: 66_000,
    defaultRank: 2,
  },
  // qwen2.5-coder base, made for code completion, with an 8K context: it can't think or
  // use tools, so it is never picked unless you choose it. The budget leaves 4K tokens
  // for the reply.
  {
    id: 'oreo-1.5b',
    name: 'Oreo 1.5B',
    provider: 'macbook',
    supportsTools: false,
    thinking: 'none',
    maxPromptChars: 10_000,
  },
];

/** Puts models in OREO_MODELS's order, largest first, wherever they were listed from; others last. */
export function inCatalogOrder(models: ModelInfo[]): ModelInfo[] {
  const rank = (id: string) => {
    const i = OREO_MODELS.findIndex((m) => m.id === id);
    return i < 0 ? OREO_MODELS.length : i;
  };
  return [...models].sort((a, b) => rank(a.id) - rank(b.id));
}

/** The model's thinking style, or undefined for an id not in OREO_MODELS. */
export function thinkingOf(id: string): ModelInfo['thinking'] | undefined {
  return OREO_MODELS.find((m) => m.id === id)?.thinking;
}

/**
 * Reads Ollama's `GET /api/tags` body and marks each of the Mac's Oreo models
 * available if Ollama has it, under its id or its id + ":latest".
 */
export function modelsFromTags(body: unknown): ModelInfo[] {
  const list =
    body && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)
      ? (body as { models: unknown[] }).models
      : undefined;
  if (!list) throw new Error('Ollama returned an unexpected model list.');
  const installed = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { name, model } = item as { name?: unknown; model?: unknown };
    if (typeof name === 'string') installed.add(name);
    if (typeof model === 'string') installed.add(model);
  }
  return OREO_MODELS.filter((m) => m.provider === 'macbook').map((m) => ({
    ...m,
    available: installed.has(m.id) || installed.has(`${m.id}:latest`),
  }));
}
