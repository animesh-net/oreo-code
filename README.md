# Oreo Code

A VS Code extension for [oreo-ai](https://github.com/animesh-net/oreo-ai). It gives you oreo-ai chat in the VS Code sidebar, and will grow into a coding agent that works on your GitHub repos from the Mac.

All coding work runs on the Mac, inside this extension. The oreo-ai server on the Pi only proxies model calls, issues API tokens and enforces the daily usage cap.

## Status

| Milestone | What it adds                                                               | State        |
| --------- | -------------------------------------------------------------------------- | ------------ |
| M3        | Sidebar chat through the oreo-ai model gateway, sign-in, CI, VSIX releases | This release |
| M4        | Local `github-mcp-server` (stdio), tool catalog, policy rules              | Next         |
| M5        | Agent loop, approval cards, local session history                          | Planned      |
| M6        | Local workspace tools (unsaved files, diff-view edits, build/test)         | Planned      |

oreo-ai offers four models: two on Cloudflare Workers AI and two on the MacBook's Ollama. The list is fixed in oreo-ai's config; the extension only offers a dropdown to switch between them. It groups them by where they run, greys out the MacBook models while the MacBook is unreachable, and remembers your last pick.

Chat needs the oreo-ai model gateway (`GET /api/models` and `POST /api/llm/v1/chat/completions`). Until that ships in oreo-ai, the extension signs in but shows that the server has no model gateway.

## Install

Releases are private VSIX files attached to GitHub Releases. In PowerShell:

```powershell
gh release download --repo animesh-net/oreo-code --pattern '*.vsix' --dir ~/Downloads
code --install-extension (Get-ChildItem ~/Downloads/oreo-code-*.vsix | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
```

## Use

1. In oreo-ai, open **Settings → API tokens** and create a token (it starts with `oreo_`).
2. In VS Code, open the **Oreo** view in the activity bar and choose **Sign in**, or run `Oreo: Sign in`.
3. Pick a model and chat. **Stop** keeps the partial reply; a failed reply is discarded and your text goes back into the box.

The token is stored in VS Code SecretStorage, which on macOS is the Keychain. It is never written to settings files.

You need to be on Tailscale to reach the oreo-ai server.

## Settings

| Setting          | Default                     | Purpose                         |
| ---------------- | --------------------------- | ------------------------------- |
| `oreo.serverUrl` | `https://ai.animesh.org.in` | Base URL of your oreo-ai server |

## Commands

| Command          | What it does                                            |
| ---------------- | ------------------------------------------------------- |
| `Oreo: Sign in`  | Stores an oreo-ai API token and loads your models       |
| `Oreo: Sign out` | Removes the stored token                                |
| `Oreo: New chat` | Clears the conversation (also the + button on the view) |

## Develop

Requires Node 22.

```powershell
npm ci
npm run check     # typecheck, unit tests, build
npm run watch     # rebuild on change
```

`npm ci` also installs the git hooks: before each commit Prettier formats the staged files and the README links are checked, and commit messages with AI attribution trailers are refused. `npm run format` formats everything.

Press **F5** in VS Code to start an Extension Development Host with the extension loaded. `npm run package` builds a production VSIX in the repo root.

### Layout

```text
src/
  extension.ts              activate(): commands, sidebar view, status bar
  auth/tokenStore.ts        oreo-ai API token in SecretStorage
  gateway/client.ts         oreo-ai model gateway (OpenAI-compatible) and model list
  gateway/errors.ts         one-sentence error messages for the chat view
  gateway/serverUrl.ts      validates the oreo.serverUrl setting
  chat/chatController.ts    chat state and turns; no vscode imports, unit tested
  views/chatViewProvider.ts webview host, CSP, message relay
  shared/protocol.ts        messages between the extension and the webview
webview-ui/                 Preact chat UI, bundled to dist/webview.js
test/                       Vitest unit tests
```

## Releasing

1. Bump `version` in `package.json` in a PR and merge it.
2. Tag `main` with the same version, for example `git tag v0.1.0` and `git push origin v0.1.0`.
3. The Release workflow checks the tag matches, runs the checks, and attaches the VSIX to a GitHub release.
