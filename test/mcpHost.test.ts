import { describe, expect, it, vi } from 'vitest';
import type { McpToolInfo } from '../src/agent/catalog';
import { githubServerSpec, GITHUB_TOOLSETS } from '../src/mcp/githubServer';
import { McpHost, type McpConnection, type McpServerSpec } from '../src/mcp/host';

const schema = { type: 'object' };
const tools: McpToolInfo[] = [
  { name: 'get_me', inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: 'create_branch', inputSchema: schema, annotations: { readOnlyHint: false } },
  { name: 'merge_pull_request', inputSchema: schema, annotations: { readOnlyHint: false } },
];

function fakeConnection() {
  let closeListener: (() => void) | undefined;
  const connection: McpConnection & { exit(): void } = {
    listTools: async () => tools,
    callTool: vi.fn(async (name: string) => ({ text: `ran ${name}`, isError: false })),
    close: vi.fn(async () => {}),
    onClose: (l) => (closeListener = l),
    exit: () => closeListener?.(),
  };
  return connection;
}

const spec: McpServerSpec = { name: 'github', command: '/bin/gms', args: ['stdio'], env: {} };

describe('McpHost', () => {
  it('starts servers once and builds the catalog', async () => {
    const connection = fakeConnection();
    const connect = vi.fn(async () => connection);
    const host = new McpHost(async () => [spec], connect);

    await Promise.all([host.start(), host.start()]);
    await host.start();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(host.catalogTools.map((t) => t.name)).toEqual(['github__create_branch', 'github__get_me']);
    expect(host.serverStates).toEqual([{ name: 'github', status: 'ready' }]);
  });

  it('routes calls to the server under the tool name it knows', async () => {
    const connection = fakeConnection();
    const host = new McpHost(
      async () => [spec],
      async () => connection,
    );
    await host.start();

    await expect(host.call('github__get_me', {})).resolves.toEqual({ text: 'ran get_me', isError: false });
    await expect(host.call('github__merge_pull_request', {})).resolves.toMatchObject({ isError: true });
  });

  it('drops a server that exits and starts it again on the next use', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const host = new McpHost(async () => [spec], connect);
    await host.start();

    first.exit();
    expect(host.catalogTools).toEqual([]);
    expect(host.serverStates[0]).toMatchObject({ status: 'stopped' });

    await host.start();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(host.catalogTools).toHaveLength(2);
  });

  it('reports a server that fails to start without stopping the others', async () => {
    const other = fakeConnection();
    const host = new McpHost(
      async () => [spec, { ...spec, name: 'other' }],
      async (s) => {
        if (s.name === 'github') throw new Error('bad token');
        return other;
      },
    );
    await host.start();

    expect(host.serverStates).toContainEqual({ name: 'github', status: 'failed', error: 'bad token' });
    // Write tools are only allowed for the github server, so "other" keeps its reads.
    expect(host.catalogTools.map((t) => t.name)).toEqual(['other__get_me']);
  });

  it('closes every server on stop', async () => {
    const connection = fakeConnection();
    const host = new McpHost(
      async () => [spec],
      async () => connection,
    );
    await host.start();
    await host.stop();

    expect(connection.close).toHaveBeenCalled();
    expect(host.catalogTools).toEqual([]);
  });
});

describe('githubServerSpec', () => {
  it('passes only the token and toolsets to the child', () => {
    expect(githubServerSpec('/bin/gms', 'github_pat_x')).toEqual({
      name: 'github',
      command: '/bin/gms',
      args: ['stdio'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'github_pat_x', GITHUB_TOOLSETS },
    });
    expect(githubServerSpec('/bin/gms', undefined)).toBeUndefined();
  });
});
