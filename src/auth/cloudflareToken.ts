import type * as vscode from 'vscode';

const KEY = 'oreo.cloudflareToken';

/**
 * The Cloudflare API token for Workers AI, in VS Code SecretStorage (the macOS
 * Keychain). It is sent only to api.cloudflare.com.
 */
export class CloudflareTokenStore {
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

export function validateCloudflareTokenShape(value: string): string | undefined {
  const v = value.trim();
  if (!v) return 'Paste a Cloudflare API token with Workers AI (Read) permission.';
  if (/\s/.test(v)) return 'The token must not contain spaces.';
  return undefined;
}
