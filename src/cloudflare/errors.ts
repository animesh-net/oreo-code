import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';

/** Turns a Workers AI failure into one short sentence for the chat view. */
export function describeCloudflareError(err: unknown): string {
  if (err instanceof APIUserAbortError) return 'Stopped.';
  if (err instanceof APIConnectionTimeoutError)
    return "Cloudflare didn't start answering within 10 minutes. Try again.";
  if (err instanceof APIConnectionError) return "Can't reach Cloudflare. Check the Mac's internet connection.";
  if (err instanceof APIError) {
    if (err.status === 401 || err.status === 403) {
      return 'Cloudflare refused the token. Run "Oreo Code: Set Cloudflare token" with a Workers AI token, and check oreo.cloudflare.accountId.';
    }
    if (err.status === 429) {
      return "Cloudflare's limit is reached (on the free plan, 10,000 Neurons a day). Use a Mac model, or try again later.";
    }
    const detail = detailOf(err);
    return detail ? `Cloudflare answered ${err.status}: ${detail}` : `Cloudflare answered ${err.status}. Try again.`;
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong talking to Cloudflare.';
}

function detailOf(err: APIError): string | undefined {
  const body = err.error as { message?: unknown; errors?: { message?: unknown }[] } | string | undefined;
  if (typeof body === 'string') return body.trim() || undefined;
  if (typeof body?.message === 'string') return body.message.trim() || undefined;
  const first = body?.errors?.[0]?.message;
  return typeof first === 'string' ? first : undefined;
}
