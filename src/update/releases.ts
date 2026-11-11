// Finds a newer Oreo Code release on GitHub and downloads its VSIX. No `vscode`
// imports: the install and the reload prompt are wired in src/extension.ts.

/** The repository the releases come from (CI tags each main build v<major>.<minor>.<n>). */
export const RELEASES_REPO = 'animesh-net/oreo-code';

export interface Release {
  version: string;
  assetName: string;
  /** The asset's API URL; a token is sent with the download when one was used for the check. */
  assetUrl: string;
}

type FetchLike = typeof fetch;

/** "v0.2.10" or "0.2.10" -> [0, 2, 10]; anything else -> undefined. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** GitHub answered with an error, e.g. 404 when the token can't see the repository. */
export class ReleaseCheckError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function headers(token: string | undefined, accept: string): Record<string, string> {
  const base: Record<string, string> = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

/** The newest release, if it is newer than `current` and has a VSIX. */
export async function findUpdate(
  current: string,
  token: string | undefined,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<Release | undefined> {
  const res = await fetchImpl(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
    headers: headers(token, 'application/vnd.github+json'),
    signal,
  });
  if (res.status === 404) {
    throw new ReleaseCheckError(
      404,
      token
        ? `No release found, or the GitHub token can't read ${RELEASES_REPO}. Give it Contents (read) on that repository.`
        : `No release found in ${RELEASES_REPO}.`,
    );
  }
  if (!res.ok) throw new ReleaseCheckError(res.status, `GitHub answered ${res.status} when checking for updates.`);
  const body = (await res.json()) as { tag_name?: unknown; assets?: { name?: unknown; url?: unknown }[] };
  const version = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
  if (!parseVersion(version) || !isNewer(version, current)) return undefined;
  const asset = body.assets?.find((a) => typeof a.name === 'string' && a.name.endsWith('.vsix'));
  if (!asset || typeof asset.name !== 'string' || typeof asset.url !== 'string') return undefined;
  return { version, assetName: asset.name, assetUrl: asset.url };
}

/** Downloads the VSIX. GitHub redirects to storage; fetch drops the token on that hop. */
export async function downloadRelease(
  release: Release,
  token: string | undefined,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetchImpl(release.assetUrl, { headers: headers(token, 'application/octet-stream'), signal });
  if (!res.ok)
    throw new ReleaseCheckError(res.status, `GitHub answered ${res.status} when downloading ${release.assetName}.`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Tries each token source in turn (the Keychain token, then the GitHub CLI's), then
 * no token, which works while the repository is public. A source with no token is
 * skipped; a refusal (401, 403, 404) moves on to the next. If every try is refused,
 * throws the last refusal.
 */
export async function findUpdateWithTokens(
  current: string,
  sources: (() => Promise<string | undefined>)[],
  fetchImpl: FetchLike = fetch,
): Promise<{ release: Release | undefined; token: string | undefined }> {
  const tokens: (string | undefined)[] = [];
  for (const source of sources) {
    const token = await source();
    if (token) tokens.push(token);
  }
  tokens.push(undefined);
  let refused: ReleaseCheckError | undefined;
  for (const token of tokens) {
    try {
      return { release: await findUpdate(current, token, fetchImpl), token };
    } catch (err) {
      if (err instanceof ReleaseCheckError && [401, 403, 404].includes(err.status)) {
        refused = err;
        continue;
      }
      throw err;
    }
  }
  throw refused;
}

/**
 * Words anything that was thrown: an Error's message (or its name), a string as it
 * is, anything else as JSON. VS Code commands can reject with a bare string.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'unknown error';
  if (typeof err === 'string') return err || 'unknown error';
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
