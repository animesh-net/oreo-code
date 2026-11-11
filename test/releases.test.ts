import { describe, expect, it } from 'vitest';
import {
  downloadRelease,
  findUpdate,
  findUpdateWithTokens,
  isNewer,
  parseVersion,
  RELEASES_REPO,
} from '../src/update/releases';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const latest = {
  tag_name: 'v0.2.11',
  assets: [{ name: 'oreo-code-0.2.11.vsix', url: 'https://api.github.com/repos/x/assets/1' }],
};

describe('versions', () => {
  it('parses v-prefixed and plain versions, and nothing else', () => {
    expect(parseVersion('v0.2.10')).toEqual([0, 2, 10]);
    expect(parseVersion('0.2.10')).toEqual([0, 2, 10]);
    expect(parseVersion('main-21')).toBeUndefined();
  });

  it('compares numerically', () => {
    expect(isNewer('0.2.10', '0.2.9')).toBe(true);
    expect(isNewer('0.3.0', '0.2.99')).toBe(true);
    expect(isNewer('0.2.9', '0.2.9')).toBe(false);
    expect(isNewer('0.1.50', '0.2.0')).toBe(false);
  });
});

describe('findUpdate', () => {
  it('returns the newest release when it is newer, asking GitHub with the token', async () => {
    let url = '';
    let auth = '';
    const release = await findUpdate('0.2.3', 'tok', async (input, init) => {
      url = String(input);
      auth = (init?.headers as Record<string, string>).Authorization;
      return json(200, latest);
    });
    expect(url).toBe(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`);
    expect(auth).toBe('Bearer tok');
    expect(release).toEqual({
      version: '0.2.11',
      assetName: 'oreo-code-0.2.11.vsix',
      assetUrl: 'https://api.github.com/repos/x/assets/1',
    });
  });

  it('returns nothing when already up to date', async () => {
    expect(await findUpdate('0.2.11', 'tok', async () => json(200, latest))).toBeUndefined();
  });

  it("explains a 404, which is what GitHub answers when the token can't see the repo", async () => {
    await expect(findUpdate('0.2.0', 'tok', async () => json(404, {}))).rejects.toThrow(/Contents \(read\)/);
  });
});

describe('downloadRelease', () => {
  it('asks for the asset as a file, with the token', async () => {
    let accept = '';
    const bytes = await downloadRelease(
      { version: '0.2.11', assetName: 'a.vsix', assetUrl: 'https://api.github.com/a' },
      'tok',
      async (_input, init) => {
        accept = (init?.headers as Record<string, string>).Accept;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    );
    expect(accept).toBe('application/octet-stream');
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});

describe('findUpdateWithTokens', () => {
  const byToken = (ok: string) => async (_input: unknown, init?: RequestInit) =>
    (init?.headers as Record<string, string>).Authorization === `Bearer ${ok}` ? json(200, latest) : json(404, {});

  it("falls back to the GitHub CLI's token when the Keychain token can't see the repo", async () => {
    const result = await findUpdateWithTokens('0.2.0', [async () => 'keychain', async () => 'gh'], byToken('gh'));
    expect(result.token).toBe('gh');
    expect(result.release?.version).toBe('0.2.11');
  });

  it('skips a source with no token', async () => {
    const result = await findUpdateWithTokens('0.2.0', [async () => undefined, async () => 'gh'], byToken('gh'));
    expect(result.token).toBe('gh');
  });

  it('says how to add a token when there is none, and passes on a refusal when all are refused', async () => {
    await expect(findUpdateWithTokens('0.2.0', [async () => undefined], byToken('x'))).rejects.toThrow(/gh auth login/);
    await expect(findUpdateWithTokens('0.2.0', [async () => 'a'], byToken('x'))).rejects.toThrow(/Contents \(read\)/);
  });
});
