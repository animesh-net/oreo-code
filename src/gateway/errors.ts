import { APIConnectionError, APIError, APIUserAbortError } from 'openai';

/** Turns a gateway failure into one short sentence for the chat view. */
export function describeGatewayError(err: unknown, serverUrl: string): string {
  if (err instanceof APIUserAbortError) return 'Stopped.';
  if (err instanceof APIConnectionError) return unreachable(serverUrl);
  const status = statusOf(err);
  if (status === 401 || status === 403) {
    return 'oreo-ai rejected your API token. Run "Oreo: Sign in" with a new token.';
  }
  if (status === 429) {
    const detail = serverMessage(err);
    return detail ?? "Today's model limit is used up. Agent and chat resume tomorrow.";
  }
  if (status === 404) {
    return `${serverUrl} has no model gateway yet. Update oreo-ai, or check the "oreo.serverUrl" setting.`;
  }
  if (status !== undefined && status >= 500) {
    return `oreo-ai had a problem (${status}). Try again in a moment.`;
  }
  if (isNetworkError(err)) return unreachable(serverUrl);
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong talking to oreo-ai.';
}

function unreachable(serverUrl: string): string {
  return `Can't reach ${serverUrl}. Check that Tailscale is connected.`;
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof APIError && typeof err.status === 'number') return err.status;
  if (err instanceof GatewayHttpError) return err.status;
  return undefined;
}

function serverMessage(err: unknown): string | undefined {
  if (err instanceof GatewayHttpError) return err.serverMessage;
  if (err instanceof APIError) {
    const body = err.error as { message?: unknown } | undefined;
    if (body && typeof body.message === 'string' && body.message.trim()) return body.message.trim();
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

/** A non-2xx answer from one of the gateway's REST endpoints. */
export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage?: string,
  ) {
    super(serverMessage ?? `HTTP ${status}`);
    this.name = 'GatewayHttpError';
  }
}
