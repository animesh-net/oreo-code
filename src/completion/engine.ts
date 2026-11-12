import { completionModel } from '../ollama/models';
import { BUDGET } from './budget';
import { LruCache } from './cache';
import { gatherSnippets, type ContextSources } from './context';
import { buildPrompt } from './prompt';
import { isMidLine, STOP_TOKENS, trimCompletion } from './postprocess';

type FetchLike = typeof fetch;

export const DEBOUNCE_MS = 300;
/** Ollama keeps the model loaded this long after the last completion. */
export const KEEP_ALIVE = '30m';
const REQUEST_TIMEOUT_MS = 15_000;

export interface CompletionRequest {
  path: string;
  languageId: string;
  /** All text before the cursor. */
  prefix: string;
  /** All text after the cursor. */
  suffix: string;
  hasSelection: boolean;
}

export interface CompletionSettings {
  enabled: boolean;
  disabledLanguages: readonly string[];
  /** The completion model is installed on the Mac's Ollama. */
  modelInstalled: boolean;
  /** A chat reply is streaming from a Mac model: the 8 GB Mac shouldn't run both. */
  macChatBusy: boolean;
}

/** Why a request gets no completion, or undefined when it should get one. */
export function skipReason(req: CompletionRequest, settings: CompletionSettings): string | undefined {
  if (!settings.enabled) return 'off';
  if (settings.disabledLanguages.includes(req.languageId)) return 'language';
  if (!settings.modelInstalled) return 'model not installed';
  if (settings.macChatBusy) return 'chat busy';
  if (req.hasSelection) return 'selection';
  return undefined;
}

/** Ollama's native generate endpoint, raw, so the prompt's special tokens go through as written. */
export async function generate(
  ollamaUrl: string,
  prompt: string,
  numPredict: number,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetchImpl(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: completionModel().id,
      prompt,
      raw: true,
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: { num_predict: numPredict, stop: [...STOP_TOKENS] },
    }),
    signal: AbortSignal.any([signal, timeout]),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status} to a completion request.`);
  const body = (await res.json()) as { response?: unknown };
  return typeof body.response === 'string' ? body.response : '';
}

export interface EngineDeps {
  repoName(): string;
  ollamaUrl(): string | undefined;
  sources: ContextSources;
  fetchImpl?: FetchLike;
}

/**
 * Works out a completion for the cursor: repo snippets, the prompt, one request to the
 * Mac's Ollama, then trimming. The same cursor text is answered from a small cache.
 */
export class CompletionEngine {
  private readonly cache = new LruCache<string>(64);

  constructor(private readonly deps: EngineDeps) {}

  async complete(req: CompletionRequest, signal: AbortSignal): Promise<string | undefined> {
    const url = this.deps.ollamaUrl();
    if (!url) return undefined;
    const key = `${req.path}\0${req.prefix.slice(-800)}\0${req.suffix.slice(0, 300)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached || undefined;

    const linePrefix = req.prefix.slice(req.prefix.lastIndexOf('\n') + 1);
    const nl = req.suffix.indexOf('\n');
    const lineSuffix = nl < 0 ? req.suffix : req.suffix.slice(0, nl);

    const snippets = await gatherSnippets(req, this.deps.sources, signal);
    if (signal.aborted) return undefined;
    const prompt = buildPrompt({
      repoName: this.deps.repoName(),
      path: req.path,
      prefix: req.prefix,
      suffix: req.suffix,
      snippets,
    });
    const numPredict = isMidLine(lineSuffix) ? BUDGET.outputTokensLine : BUDGET.outputTokensBlock;
    const raw = await generate(url, prompt, numPredict, signal, this.deps.fetchImpl);
    const text = trimCompletion(raw, { linePrefix, lineSuffix, suffix: req.suffix });
    this.cache.set(key, text ?? '');
    return text;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/** Waits, unless the signal fires first; true when it waited the whole time. */
export function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
