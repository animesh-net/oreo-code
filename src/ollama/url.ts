/**
 * Validates the "oreo.ollamaUrl" setting and strips trailing slashes,
 * so paths can be appended safely. Throws with a readable message.
 */
export function normalizeOllamaUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('The "oreo.ollamaUrl" setting is empty.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`"${trimmed}" in "oreo.ollamaUrl" is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('"oreo.ollamaUrl" must start with http:// or https://.');
  }
  if (url.search || url.hash) {
    throw new Error('"oreo.ollamaUrl" must not contain a query string or fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

/** True for the default local address, which may not be where Ollama listens. */
export function isLoopbackUrl(ollamaUrl: string): boolean {
  const host = new URL(ollamaUrl).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

interface InterfaceAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

/**
 * Where else Ollama may be on this Mac: oreo-ai's `scripts/oreo-ai.sh models` makes it
 * listen only on the Mac's Tailscale address (100.64.0.0/10), so the Pi can reach it.
 * Takes `os.networkInterfaces()` and keeps the configured URL's scheme and port.
 */
export function tailscaleOllamaUrls(
  ollamaUrl: string,
  interfaces: Record<string, InterfaceAddress[] | undefined>,
): string[] {
  const base = new URL(ollamaUrl);
  const urls: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || !isTailscaleIPv4(a.address)) continue;
      const url = new URL(base.toString());
      url.hostname = a.address;
      const normalized = url.toString().replace(/\/+$/, '');
      if (!urls.includes(normalized)) urls.push(normalized);
    }
  }
  return urls;
}

function isTailscaleIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}
