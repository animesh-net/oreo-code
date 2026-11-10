import type { McpServerSpec } from './host';

/** The tool groups the agent gets: who-am-I, repository contents and branches, pull requests. */
export const GITHUB_TOOLSETS = 'context,repos,pull_requests';

/** The github-mcp-server spec, or undefined when no GitHub token is set. */
export function githubServerSpec(binary: string, token: string | undefined): McpServerSpec | undefined {
  if (!token) return undefined;
  return {
    name: 'github',
    command: binary,
    args: ['stdio'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: token, GITHUB_TOOLSETS },
  };
}
