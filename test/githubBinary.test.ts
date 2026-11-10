import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assetName,
  ensureGithubMcpBinary,
  expectedChecksum,
  GITHUB_MCP_VERSION,
  releaseUrls,
  sha256,
} from '../src/mcp/githubBinary';

describe('release helpers', () => {
  it('names the archive the way the release does', () => {
    expect(assetName('darwin', 'arm64')).toBe('github-mcp-server_Darwin_arm64.tar.gz');
    expect(assetName('darwin', 'x64')).toBe('github-mcp-server_Darwin_x86_64.tar.gz');
    expect(assetName('linux', 'arm64')).toBe('github-mcp-server_Linux_arm64.tar.gz');
    expect(() => assetName('win32', 'x64')).toThrow(/no download/);
  });

  it('builds the release URLs for the pinned version', () => {
    expect(releaseUrls('2.1.0', 'a.tar.gz')).toEqual({
      archive: 'https://github.com/github/github-mcp-server/releases/download/v2.1.0/a.tar.gz',
      checksums:
        'https://github.com/github/github-mcp-server/releases/download/v2.1.0/github-mcp-server_2.1.0_checksums.txt',
    });
  });

  it('finds an asset in the checksums file', () => {
    const hash = 'a'.repeat(64);
    const text = `${'b'.repeat(64)}  other.tar.gz\n${hash.toUpperCase()}  wanted.tar.gz\n`;
    expect(expectedChecksum(text, 'wanted.tar.gz')).toBe(hash);
    expect(() => expectedChecksum(text, 'missing.tar.gz')).toThrow(/don't list/);
  });
});

describe('ensureGithubMcpBinary', () => {
  const asset = 'github-mcp-server_Darwin_arm64.tar.gz';
  const archive = new TextEncoder().encode('pretend archive');

  function fakeFetch(checksum: string) {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return url.endsWith('checksums.txt') ? new Response(`${checksum}  ${asset}\n`) : new Response(archive);
    }) as unknown as typeof fetch;
    return { urls, fetchImpl };
  }

  const extract = async (_archivePath: string, into: string) => {
    await writeFile(join(into, 'github-mcp-server'), '#!/bin/sh\n');
  };

  it('downloads, checks and unpacks the pinned version once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oreo-'));
    const { urls, fetchImpl } = fakeFetch(sha256(archive));

    const binary = await ensureGithubMcpBinary(dir, { fetchImpl, extract, platform: 'darwin', arch: 'arm64' });
    expect(binary).toBe(join(dir, `github-mcp-server-${GITHUB_MCP_VERSION}`, 'github-mcp-server'));
    expect(await readFile(binary, 'utf8')).toBe('#!/bin/sh\n');
    expect(urls).toHaveLength(2);

    await ensureGithubMcpBinary(dir, { fetchImpl, extract, platform: 'darwin', arch: 'arm64' });
    expect(urls).toHaveLength(2);
  });

  it('refuses an archive that does not match its checksum', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oreo-'));
    const { fetchImpl } = fakeFetch('0'.repeat(64));
    await expect(ensureGithubMcpBinary(dir, { fetchImpl, extract, platform: 'darwin', arch: 'arm64' })).rejects.toThrow(
      /doesn't match its checksum/,
    );
  });

  it('reports a failed download', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oreo-'));
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(ensureGithubMcpBinary(dir, { fetchImpl, extract, platform: 'darwin', arch: 'arm64' })).rejects.toThrow(
      /failed \(404\)/,
    );
  });
});
