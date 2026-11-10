import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The github-mcp-server release the extension runs. Bump it only in a PR: a new
 * version can rename tools, and the policy in src/agent/ keys on tool names.
 */
export const GITHUB_MCP_VERSION = '2.1.0';

const RELEASES = 'https://github.com/github/github-mcp-server/releases/download';

/** The release archive for this machine, named as GoReleaser names them. */
export function assetName(platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'darwin' ? 'Darwin' : platform === 'linux' ? 'Linux' : undefined;
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x86_64' : undefined;
  if (!os || !cpu) throw new Error(`github-mcp-server has no download for ${platform}/${arch}.`);
  return `github-mcp-server_${os}_${cpu}.tar.gz`;
}

export function releaseUrls(version: string, asset: string): { archive: string; checksums: string } {
  return {
    archive: `${RELEASES}/v${version}/${asset}`,
    checksums: `${RELEASES}/v${version}/github-mcp-server_${version}_checksums.txt`,
  };
}

/** The SHA-256 the release's checksums file lists for one asset. */
export function expectedChecksum(checksums: string, asset: string): string {
  for (const line of checksums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === asset && /^[0-9a-f]{64}$/i.test(hash ?? '')) return hash.toLowerCase();
  }
  throw new Error(`The release's checksums don't list ${asset}.`);
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

type FetchLike = typeof fetch;
type Extract = (archive: string, into: string) => Promise<void>;

const execFileAsync = promisify(execFile);
const tarExtract: Extract = async (archive, into) => {
  await execFileAsync('tar', ['-xzf', archive, '-C', into, 'github-mcp-server']);
};

/**
 * Returns the path to the pinned github-mcp-server, downloading it into `storageDir`
 * the first time. The archive must match the SHA-256 in the release's checksums file.
 */
export async function ensureGithubMcpBinary(
  storageDir: string,
  options: { fetchImpl?: FetchLike; extract?: Extract; platform?: NodeJS.Platform; arch?: string } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const extract = options.extract ?? tarExtract;
  const dir = join(storageDir, `github-mcp-server-${GITHUB_MCP_VERSION}`);
  const binary = join(dir, 'github-mcp-server');
  if (await isExecutable(binary)) return binary;

  const asset = assetName(options.platform ?? process.platform, options.arch ?? process.arch);
  const urls = releaseUrls(GITHUB_MCP_VERSION, asset);
  const checksums = await download(fetchImpl, urls.checksums);
  const expected = expectedChecksum(new TextDecoder().decode(checksums), asset);
  const archive = await download(fetchImpl, urls.archive);
  const actual = sha256(archive);
  if (actual !== expected) {
    throw new Error(`The downloaded github-mcp-server doesn't match its checksum (${actual} ≠ ${expected}).`);
  }

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const archivePath = join(dir, asset);
  await writeFile(archivePath, archive);
  await extract(archivePath, dir);
  await rm(archivePath, { force: true });
  await chmod(binary, 0o755);
  return binary;
}

async function download(fetchImpl: FetchLike, url: string): Promise<Uint8Array> {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Downloading ${url} failed (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
