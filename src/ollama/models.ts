import type { ModelInfo } from '../shared/protocol';

/**
 * The only models the extension offers, named once here: two on this Mac's Ollama,
 * created from the Modelfiles in oreo-ai's `ollama/` folder, and two on Cloudflare
 * Workers AI, as in oreo-ai. Listed default first. The prompt budgets keep within
 * each context window at about 3 characters a token, leaving room for the reply.
 */
export const OREO_MODELS: readonly Omit<ModelInfo, 'available'>[] = [
  // Both are qwen3.5 with a 32K context, which can only think or not.
  {
    id: 'oreo-4b',
    name: 'Oreo 4B',
    provider: 'macbook',
    supportsTools: true,
    thinking: 'switch',
    maxPromptChars: 72_000,
  },
  {
    id: 'oreo-2b',
    name: 'Oreo 2B',
    provider: 'macbook',
    supportsTools: false,
    thinking: 'switch',
    maxPromptChars: 72_000,
  },
  // Qwen3 has a 32K context and a thinking switch; gpt-oss 128K and always reasons.
  {
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    name: 'Qwen3 30B',
    provider: 'cloudflare',
    supportsTools: true,
    thinking: 'switch',
    maxPromptChars: 72_000,
  },
  {
    id: '@cf/openai/gpt-oss-120b',
    name: 'gpt-oss 120B',
    provider: 'cloudflare',
    supportsTools: true,
    thinking: 'levels',
    maxPromptChars: 200_000,
  },
];

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
