// Finds a newer Oreo Code release on GitHub and downloads its VSIX. No `vscode`
// imports: the install and the reload prompt are wired in src/extension.ts.

/** The repository the releases come from (CI tags each main build v<major>.<minor>.<n>). */
export const RELEASES_REPO = 'animesh-net/oreo-code';

export interface Release {
  version: string;
  assetName: string;
  /** The asset's API URL; downloading it needs the token, as the repo is private. */
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

function headers(token: string, accept: string): Record<string, string> {
  return { Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
}

/** The newest release, if it is newer than `current` and has a VSIX. */
export async function findUpdate(
  current: string,
  token: string,
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
      `No release found, or the GitHub token can't read ${RELEASES_REPO}. Give it Contents (read) on that repository.`,
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
  token: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetchImpl(release.assetUrl, { headers: headers(token, 'application/octet-stream'), signal });
  if (!res.ok)
    throw new ReleaseCheckError(res.status, `GitHub answered ${res.status} when downloading ${release.assetName}.`);
  return new Uint8Array(await res.arrayBuffer());
}
