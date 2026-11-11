import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';

/** A non-2xx answer from the relay's `GET /models`. */
export class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage?: string,
  ) {
    super(serverMessage ?? `HTTP ${status}`);
    this.name = 'RelayHttpError';
  }
}

/** Turns a failure of oreo-ai's Workers AI relay into one short sentence for the chat view. */
export function describeCloudflareError(err: unknown, relayUrl: string): string {
  if (err instanceof APIUserAbortError) return 'Stopped.';
  if (err instanceof APIConnectionTimeoutError)
    return "Cloudflare didn't start answering within 10 minutes. Try again.";
  if (err instanceof APIConnectionError || isNetworkError(err)) return unreachable(relayUrl);
  const status = err instanceof APIError ? err.status : err instanceof RelayHttpError ? err.status : undefined;
  if (status !== undefined) {
    const detail = err instanceof RelayHttpError ? err.serverMessage?.trim() : detailOf(err as APIError);
    if (status === 429) {
      return 'The Cloudflare limit is reached (oreo-ai rate-limits the relay, and the free plan allows 10,000 Neurons a day). Use a Mac model, or try again later.';
    }
    if (status === 503) return 'oreo-ai has no Cloudflare set up, so the Cloudflare models are off. Use a Mac model.';
    if (status === 400 && detail) return detail;
    return detail ? `oreo-ai answered ${status}: ${detail}` : `oreo-ai answered ${status}. Try again.`;
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong talking to Cloudflare through oreo-ai.';
}

function unreachable(relayUrl: string): string {
  return `Can't reach oreo-ai at ${relayUrl}. Is the Mac on Tailscale?`;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
  return (
    err.message === 'fetch failed' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ETIMEDOUT'
  );
}

function detailOf(err: APIError): string | undefined {
  const body = err.error as { message?: unknown; errors?: { message?: unknown }[] } | string | undefined;
  if (typeof body === 'string') return body.trim() || undefined;
  if (typeof body?.message === 'string') return body.message.trim() || undefined;
  const first = body?.errors?.[0]?.message;
  return typeof first === 'string' ? first : undefined;
}
