import type * as vscode from 'vscode';

const KEY = 'oreo.apiToken';

/** The oreo-ai API token, kept in VS Code SecretStorage (the macOS Keychain). */
export class TokenStore {
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

  /** Fires when the token changes, including from another VS Code window. */
  onDidChange(listener: () => void): vscode.Disposable {
    return this.secrets.onDidChange((e) => {
      if (e.key === KEY) listener();
    });
  }
}

/** oreo-ai API tokens start with "oreo_". Returns an error message, or undefined if it looks right. */
export function validateTokenShape(value: string): string | undefined {
  const v = value.trim();
  if (!v) return 'Paste the token from oreo-ai → Settings → API tokens.';
  if (!v.startsWith('oreo_')) return 'oreo-ai API tokens start with "oreo_".';
  if (/\s/.test(v)) return 'The token must not contain spaces.';
  return undefined;
}
