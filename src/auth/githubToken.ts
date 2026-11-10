import type * as vscode from 'vscode';

const KEY = 'oreo.githubToken';

/**
 * The GitHub token the local github-mcp-server uses, in VS Code SecretStorage (the
 * macOS Keychain). It is passed only to that child process, never to oreo-ai.
 */
export class GithubTokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get(): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(KEY));
  }

  set(token: string): Promise<void> {
    return Promise.resolve(this.secrets.store(KEY, token.trim()));
  }

  clear(): Promise<void> {
    return Promise.resolve(this.secrets.delete(KEY));
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return this.secrets.onDidChange((e) => {
      if (e.key === KEY) listener();
    });
  }
}

/** A fine-grained token starts with "github_pat_"; a classic one with "ghp_". */
export function validateGithubTokenShape(value: string): string | undefined {
  const v = value.trim();
  if (!v) return 'Paste a fine-grained GitHub token (github_pat_…).';
  if (/\s/.test(v)) return 'The token must not contain spaces.';
  if (!v.startsWith('github_pat_') && !v.startsWith('ghp_')) {
    return 'GitHub tokens start with "github_pat_" (fine-grained, recommended) or "ghp_".';
  }
  return undefined;
}
