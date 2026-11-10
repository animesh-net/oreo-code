import { APIConnectionError, APIError, APIUserAbortError } from 'openai';

/** Turns an Ollama failure into one short sentence for the chat view. */
export function describeOllamaError(err: unknown, ollamaUrl: string, model?: string): string {
  if (err instanceof APIUserAbortError) return 'Stopped.';
  if (err instanceof APIConnectionError) return unreachable(ollamaUrl);
  const status = statusOf(err);
  const detail = serverMessage(err);
  if (status === 404) {
    // Ollama's /v1 answers 404 when the model isn't installed.
    return model
      ? `${model} isn't in Ollama. Run "ollama create ${model} -f Modelfile.${model}" with oreo-ai's Modelfile, or "ollama pull ${model}".`
      : `That model isn't in Ollama. Create it from oreo-ai's Modelfiles with "ollama create", or "ollama pull" it.`;
  }
  if (status !== undefined) {
    return detail ? `Ollama answered ${status}: ${detail}` : `Ollama answered ${status}. Try again in a moment.`;
  }
  if (isNetworkError(err)) return unreachable(ollamaUrl);
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong talking to Ollama.';
}

function unreachable(ollamaUrl: string): string {
  return `Can't reach Ollama at ${ollamaUrl}. Is it running?`;
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof APIError && typeof err.status === 'number') return err.status;
  if (err instanceof OllamaHttpError) return err.status;
  return undefined;
}

function serverMessage(err: unknown): string | undefined {
  if (err instanceof OllamaHttpError) return err.serverMessage?.trim() || undefined;
  if (err instanceof APIError) {
    // The SDK keeps the body's "error" field: an object in the OpenAI shape, or Ollama's plain string.
    const body = err.error as { message?: unknown } | string | undefined;
    if (typeof body === 'string' && body.trim()) return body.trim();
    if (body && typeof body === 'object' && typeof body.message === 'string' && body.message.trim()) {
      return body.message.trim();
    }
  }
  return undefined;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
  return (
    err.message === 'fetch failed' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ETIMEDOUT'
  );
}

/** A non-2xx answer from one of Ollama's REST endpoints. */
export class OllamaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage?: string,
  ) {
    super(serverMessage ?? `HTTP ${status}`);
    this.name = 'OllamaHttpError';
  }
}
