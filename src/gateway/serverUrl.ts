/**
 * Validates the "oreo.serverUrl" setting and strips trailing slashes,
 * so paths can be appended safely. Throws with a readable message.
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('The "oreo.serverUrl" setting is empty.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`"${trimmed}" in "oreo.serverUrl" is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('"oreo.serverUrl" must start with https:// or http://.');
  }
  if (url.search || url.hash) {
    throw new Error('"oreo.serverUrl" must not contain a query string or fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}
