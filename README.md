# Oreo Code

A VS Code extension for [oreo-ai](https://github.com/animesh-net/oreo-ai). It gives you oreo-ai chat in the VS Code sidebar, and will grow into a coding agent that works on your GitHub repos from the Mac.

All coding work runs on the Mac, inside this extension. The oreo-ai server on the Pi only proxies model calls, issues API tokens and enforces the daily usage cap.

## Status

| Milestone | What it adds                                                               | State        |
| --------- | -------------------------------------------------------------------------- | ------------ |
| M3        | Sidebar chat through the oreo-ai model gateway, sign-in, CI, VSIX releases | Done         |
| M4        | Local `github-mcp-server` (stdio), tool catalog, policy rules              | This release |
| M5        | Agent loop, approval cards, local session history                          | Next         |
| M6        | Local workspace tools (unsaved files, diff-view edits, build/test)         | Planned      |

oreo-ai offers four models: two on Cloudflare Workers AI and two on the MacBook's Ollama. The list is fixed in oreo-ai's config; the extension only offers a dropdown to switch between them. It groups them by where they run, greys out the MacBook models while the MacBook is unreachable, and remembers your last pick.

Chat uses the oreo-ai model gateway (`GET /api/models` and `POST /api/llm/v1/chat/completions`).

## Install

Every build of `main` is published as a prerelease named `main-<run>` with its VSIX attached; the 10 newest are kept. Version tags (`v0.1.0`) are full releases. To install the newest main build, in PowerShell:

```powershell
$tag = gh release list --repo animesh-net/oreo-code --limit 20 --json tagName,isPrerelease --jq '[.[] | select(.isPrerelease)][0].tagName'
gh release download $tag --repo animesh-net/oreo-code --pattern '*.vsix' --dir ~/Downloads --clobber
code --install-extension (Get-ChildItem ~/Downloads/oreo-code-*.vsix | Sort-Object LastWriteTime | Select-Object -Last 1).FullName --force
```

For the latest version-tagged release instead, drop the first line and `$tag`. `--force` replaces the installed build even when the version number is the same.

## Use

1. In oreo-ai, open **Settings → API tokens** and create a token (it starts with `oreo_`).
2. In VS Code, open the **Oreo** view in the activity bar and choose **Sign in**, or run `Oreo: Sign in`.
3. Pick a model and chat. **Stop** keeps the partial reply; a failed reply is discarded and your text goes back into the box.

The token is stored in VS Code SecretStorage, which on macOS is the Keychain. It is never written to settings files.

You need to be on Tailscale to reach the oreo-ai server.

## GitHub tools

The coding agent (next milestone) works on your GitHub repos through GitHub's own MCP server, which runs on this Mac as a child process of the extension. Nothing about GitHub goes through oreo-ai.

1. On GitHub, create a fine-grained token (Settings → Developer settings → Fine-grained tokens). Give it only the repos the agent may work on, with **Contents** and **Pull requests** set to read and write (**Metadata** read is added for you). 90 days is a good expiry.
2. Run `Oreo: Set GitHub token` and paste it. It is stored in the Keychain and passed only to the local `github-mcp-server`.
3. Run `Oreo: Show GitHub tools`. The first time, the extension downloads `github-mcp-server` 2.1.0 for your Mac from GitHub's releases into its own storage, and refuses it unless it matches the SHA-256 in the release's checksums file. The **Oreo** output panel then lists the tools.

The server gets only the `context`, `repos` and `pull_requests` tool groups. Read tools (files, search, branches, commits, pull requests) run straight away. Only four write tools are offered — create a branch, commit files, write one file, and open a pull request — and they will always ask for your approval. The rules are checked in code: new branches must be named `oreo-agent/<name>`, commits go only to `oreo-agent/` branches (never `main` or `master`), and pull requests go from an `oreo-agent/` branch into `main`. Merging, deleting, forking and settings tools are never offered; you merge the pull requests yourself. Long tool results are cut at 20,000 characters.

To use your own build of the server instead, set `oreo.githubMcp.path` to it.

## Settings

| Setting               | Default                     | Purpose                                                                 |
| --------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `oreo.serverUrl`      | `https://ai.animesh.org.in` | Base URL of your oreo-ai server                                         |
| `oreo.githubMcp.path` | (empty)                     | Your own `github-mcp-server` binary; empty downloads the pinned release |

## Commands

| Command                    | What it does                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
| `Oreo: Sign in`            | Stores an oreo-ai API token and loads your models                                 |
| `Oreo: Sign out`           | Removes the stored token                                                          |
| `Oreo: New chat`           | Clears the conversation (also the + button on the view)                           |
| `Oreo: Set GitHub token`   | Stores the GitHub token for the local `github-mcp-server`                         |
| `Oreo: Clear GitHub token` | Removes it                                                                        |
| `Oreo: Show GitHub tools`  | Starts `github-mcp-server` if needed and lists its tools in the Oreo output panel |

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
  auth/githubToken.ts       GitHub token in SecretStorage
  gateway/client.ts         oreo-ai model gateway (OpenAI-compatible) and model list
  gateway/errors.ts         one-sentence error messages for the chat view
  gateway/serverUrl.ts      validates the oreo.serverUrl setting
  chat/chatController.ts    chat state and turns; no vscode imports, unit tested
  views/chatViewProvider.ts webview host, CSP, message relay
  shared/protocol.ts        messages between the extension and the webview
  mcp/githubBinary.ts       pinned github-mcp-server download and checksum check
  mcp/host.ts               starts MCP servers, keeps the tool catalog, routes calls
  mcp/stdioConnect.ts       MCP client over stdio (@modelcontextprotocol/sdk)
  agent/catalog.ts          MCP tools → namespaced function tools, read/write, allowlist
  agent/policy.ts           what runs, what needs approval, what is refused
webview-ui/                 Preact chat UI, bundled to dist/webview.js
test/                       Vitest unit tests
```

## Releasing

1. Bump `version` in `package.json` in a PR and merge it.
2. Tag `main` with the same version, for example `git tag v0.1.0` and `git push origin v0.1.0`.
3. The Release workflow checks the tag matches, runs the checks, and attaches the VSIX to a GitHub release.
