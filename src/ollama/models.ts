import type { ModelInfo } from '../shared/protocol';

/**
 * The only models the extension offers, named once here. They are created in
 * Ollama from the Modelfiles in oreo-ai's `ollama/` folder. Listed default first.
 */
export const OREO_MODELS: readonly Omit<ModelInfo, 'available'>[] = [
  // Both are qwen3.5, which can only think or not.
  { id: 'oreo-4b', name: 'Oreo 4B', provider: 'macbook', supportsTools: true, thinking: 'switch' },
  { id: 'oreo-2b', name: 'Oreo 2B', provider: 'macbook', supportsTools: false, thinking: 'switch' },
];

/**
 * Reads Ollama's `GET /api/tags` body and marks each Oreo model available if Ollama
 * has it, under its id or its id + ":latest".
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
  return OREO_MODELS.map((m) => ({
    ...m,
    available: installed.has(m.id) || installed.has(`${m.id}:latest`),
  }));
}
