# Oreo Code

A VS Code extension that chats with the Oreo models on your Mac's own [Ollama](https://ollama.com), in the VS Code sidebar, and will grow into a coding agent that works on your GitHub repos from the Mac.

Everything runs on the Mac, inside this extension: it calls Ollama directly, with no API token, no sign-in and no oreo-ai server in between. The models themselves come from the Modelfiles in [oreo-ai](https://github.com/animesh-net/oreo-ai)'s `ollama/` folder.

## Status

| Milestone | What it adds                                                       | State        |
| --------- | ------------------------------------------------------------------ | ------------ |
| M3        | Sidebar chat, CI, VSIX releases (now straight to Ollama)           | Done         |
| M4        | Local `github-mcp-server` (stdio), tool catalog, policy rules      | This release |
| M5        | Agent loop, approval cards, local session history                  | Next         |
| M6        | Local workspace tools (unsaved files, diff-view edits, build/test) | Planned      |

The extension offers two models, fixed in `src/ollama/models.ts`: **Oreo 4B** (`oreo-4b`, can use tools) and **Oreo 2B** (`oreo-2b`). The pill in the message box switches between them, greys out any model Ollama doesn't have (matched as `oreo-4b` or `oreo-4b:latest`), and remembers your last pick.

Chat uses Ollama's own endpoints: `GET <oreo.ollamaUrl>/api/tags` to see which models are installed, and the OpenAI-compatible `POST <oreo.ollamaUrl>/v1/chat/completions`, streamed over SSE. The extension host makes these calls, not the webview.

## Install

Every build of `main` is published as a prerelease named `main-<run>` with its VSIX attached; the 10 newest are kept. Version tags (`v0.1.0`) are full releases. To install the newest main build, in PowerShell:

```powershell
$tag = gh release list --repo animesh-net/oreo-code --limit 20 --json tagName,isPrerelease --jq '[.[] | select(.isPrerelease)][0].tagName'
gh release download $tag --repo animesh-net/oreo-code --pattern '*.vsix' --dir ~/Downloads --clobber
code --install-extension (Get-ChildItem ~/Downloads/oreo-code-*.vsix | Sort-Object LastWriteTime | Select-Object -Last 1).FullName --force
```

For the latest version-tagged release instead, drop the first line and `$tag`. `--force` replaces the installed build even when the version number is the same.

## Use

1. Install [Ollama](https://ollama.com) on the Mac and create the two models from the Modelfiles in oreo-ai's `ollama/` folder:

   ```powershell
   ollama create oreo-4b -f ~/oreo-ai/ollama/Modelfile.oreo-4b
   ollama create oreo-2b -f ~/oreo-ai/ollama/Modelfile.oreo-2b
   ```

2. Point `oreo.ollamaUrl` at Ollama. The default, `http://127.0.0.1:11434`, works when Ollama listens on localhost. If it listens only on the Mac's Tailscale address, set `oreo.ollamaUrl` to `http://<tailscale ip>:11434`, or start Ollama with `OLLAMA_HOST=0.0.0.0` so it also answers on localhost. Changing the setting reloads the model list.
3. Open the **Oreo** view in the activity bar, and chat. As in the Claude app, the message box has the text on top and, below it, a pill showing the model and whether it thinks (for example **Oreo 4B Thinking off**) and a round Send button. The pill opens one menu for the model and for **Thinking**, which offers only what the model takes: both models are qwen3.5, which can only think or not, so it shows **Off** and **On** (each model's style is set once in `src/ollama/models.ts`). The pick is sent with every message as `reasoning_effort`: `none` for Off, and the remembered level for On (medium the first time), which Ollama turns into thinking on. It starts off, because the models are small and slow to think on the M1, and remembers your pick. **Stop** keeps the partial reply; a failed reply is discarded and your text goes back into the box.

If Ollama isn't running, the view says so in one line and offers **Retry**.

## GitHub tools

The coding agent (next milestone) works on your GitHub repos through GitHub's own MCP server, which runs on this Mac as a child process of the extension. Nothing about GitHub goes to Ollama.

1. On GitHub, create a fine-grained token (Settings → Developer settings → Fine-grained tokens). Give it only the repos the agent may work on, with **Contents** and **Pull requests** set to read and write (**Metadata** read is added for you). 90 days is a good expiry.
2. Run `Oreo: Set GitHub token` and paste it. It is stored in the Keychain and passed only to the local `github-mcp-server`.
3. Run `Oreo: Show GitHub tools`. The first time, the extension downloads `github-mcp-server` 2.1.0 for your Mac from GitHub's releases into its own storage, and refuses it unless it matches the SHA-256 in the release's checksums file. The **Oreo** output panel then lists the tools.

The server gets only the `context`, `repos` and `pull_requests` tool groups. Read tools (files, search, branches, commits, pull requests) run straight away. Only four write tools are offered — create a branch, commit files, write one file, and open a pull request — and they will always ask for your approval. The rules are checked in code: new branches must be named `oreo-agent/<name>`, commits go only to `oreo-agent/` branches (never `main` or `master`), and pull requests go from an `oreo-agent/` branch into `main`. Merging, deleting, forking and settings tools are never offered; you merge the pull requests yourself. Long tool results are cut at 20,000 characters.

To use your own build of the server instead, set `oreo.githubMcp.path` to it.

## Settings

| Setting               | Default                  | Purpose                                                                   |
| --------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `oreo.ollamaUrl`      | `http://127.0.0.1:11434` | Base URL of Ollama; use `http://<tailscale ip>:11434` if it listens there |
| `oreo.githubMcp.path` | (empty)                  | Your own `github-mcp-server` binary; empty downloads the pinned release   |

## Commands

| Command                    | What it does                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
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
  auth/githubToken.ts       GitHub token in SecretStorage
  ollama/models.ts          the two Oreo models, named once, and which Ollama has
  ollama/client.ts          Ollama's /api/tags and OpenAI-compatible /v1 chat
  ollama/errors.ts          one-sentence error messages for the chat view
  ollama/url.ts             validates the oreo.ollamaUrl setting
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
