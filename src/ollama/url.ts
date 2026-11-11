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
