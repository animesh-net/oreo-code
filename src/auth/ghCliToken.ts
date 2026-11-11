import { execFile } from 'node:child_process';

/**
 * The token of the GitHub CLI's sign-in (`gh auth token`), if `gh` is installed and
 * signed in. Used only to check for and download Oreo Code releases when the
 * Keychain token can't. VS Code started from the Dock doesn't get the shell's PATH,
 * so Homebrew's folders are added.
 */
export function ghCliToken(): Promise<string | undefined> {
  const path = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? ''].join(':');
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['auth', 'token'],
      { timeout: 5_000, env: { PATH: path, HOME: process.env.HOME ?? '' } },
      (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined),
    );
  });
}
