# Oreo Code

A VS Code extension that chats with the Oreo models on your Mac's own [Ollama](https://ollama.com), and optionally two models on Cloudflare Workers AI, in the VS Code sidebar, and will grow into a coding agent that works on your GitHub repos from the Mac.

The extension calls Ollama on the Mac directly, with no sign-in and no oreo-ai server in between. The two Cloudflare models go through oreo-ai's relay on the Pi (`https://ai.animesh.org.in/v1`, reachable over Tailscale only), which holds the Cloudflare token; the extension has no Cloudflare token or account id, and nothing goes to oreo-ai or Cloudflare unless you pick a Cloudflare model. The models themselves come from the Modelfiles in [oreo-ai](https://github.com/animesh-net/oreo-ai)'s `ollama/` folder.

## Status

| Milestone | What it adds                                                       | State                         |
| --------- | ------------------------------------------------------------------ | ----------------------------- |
| M3        | Sidebar chat, CI, VSIX releases (now straight to Ollama)           | Done                          |
| M4        | Local `github-mcp-server` (stdio), tool catalog, policy rules      | Done                          |
| M5        | Agent loop, approval cards, local session history                  | Started: read-only repo tools |
| M6        | Local workspace tools (unsaved files, diff-view edits, build/test) | Started: reads unsaved files  |

The extension offers four models, fixed in `src/ollama/models.ts`, as in oreo-ai:

| Model        | Runs on                                               | Tools | Thinking            | Context |
| ------------ | ----------------------------------------------------- | ----- | ------------------- | ------- |
| Oreo 4B      | This Mac (`oreo-4b`)                                  | Yes   | Off / On            | 32K     |
| Oreo 2B      | This Mac (`oreo-2b`)                                  | No    | Off / On            | 32K     |
| Qwen3 30B    | Cloudflare via oreo-ai (`@cf/qwen/qwen3-30b-a3b-fp8`) | Yes   | Off / On            | 32K     |
| gpt-oss 120B | Cloudflare via oreo-ai (`@cf/openai/gpt-oss-120b`)    | Yes   | Low / Medium / High | 128K    |

The pill in the message box opens a menu grouped into **This Mac** and **Cloudflare via oreo-ai (leaves the Mac)**. It greys out a Mac model Ollama doesn't have (matched as `oreo-4b` or `oreo-4b:latest`) and a Cloudflare model oreo-ai's relay doesn't list, or both when the relay can't be reached or has no Cloudflare set up (**oreo-ai not reachable**), and remembers your last pick. Either side keeps working when the other is down. The Cloudflare models are much stronger at reviewing code than the Mac's small ones, but your question, the repo snapshot and any file they read leave the Mac: they go to the Pi and on to Cloudflare. On the free plan Workers AI allows 10,000 Neurons a day, and oreo-ai rate-limits the relay; a review that reads many files with gpt-oss uses a good share of that.

Chat uses Ollama's own endpoints: `GET <oreo.ollamaUrl>/api/tags` to see which models are installed, and the OpenAI-compatible `POST <oreo.ollamaUrl>/v1/chat/completions`, streamed over SSE. The Cloudflare models use oreo-ai's relay at `oreo.cloudUrl`: `GET <oreo.cloudUrl>/models` to see which models it offers, and `POST <oreo.cloudUrl>/chat/completions`, which oreo-ai passes unchanged to Workers AI's OpenAI-compatible chat with the Pi's Cloudflare token and streams back. No `Authorization` header is needed (network access over Tailscale is the access control). The request is shaped the same way oreo-ai does: Qwen3 is switched off with `/no_think` in the system message, gpt-oss gets `reasoning_effort` (low for Off), and `max_tokens` is 4,096, doubled when the model thinks (oreo-ai caps it at 8,192). The extension host makes these calls, not the webview.

## Install

Every merge to `main` is published as a release with its VSIX attached, numbered in the `major.minor` series set in `package.json`: `v0.2.0`, then `v0.2.1`, `v0.2.2`, … (CI takes one past the newest `v0.2.*` tag and stamps it into the VSIX). To start a new series, change the version in `package.json` to, say, `0.3.0` in a PR; the next build is `v0.3.0`.

Install once by hand, in PowerShell:

```powershell
gh release download --repo animesh-net/oreo-code --pattern '*.vsix' --dir ~/Downloads --clobber; code --install-extension (Get-ChildItem ~/Downloads/oreo-code-*.vsix | Sort-Object LastWriteTime | Select-Object -Last 1).FullName --force
```

After that the extension updates itself: 15 seconds after VS Code starts and every 6 hours it asks GitHub for the newest release and, if it's newer, downloads and installs it and offers **Reload**. **Check for updates** in the Oreo Code panel's **…** menu (or `Oreo Code: Check for updates` in the Command Palette) checks straight away. The Extensions view never offers updates for it, as it isn't installed from the Marketplace. The repository is private, so this uses the GitHub token from `Oreo Code: Set GitHub token` (it needs **Contents (read)** on `animesh-net/oreo-code`) or, if that is missing or can't see the repository, the GitHub CLI's sign-in (`gh auth token`). If an automatic check fails, it says why once per session; details go to the **Oreo Code** output panel. Turn it off with `oreo.autoUpdate`.

## Use

1. Install [Ollama](https://ollama.com) on the Mac and create the two models from the Modelfiles in oreo-ai's `ollama/` folder:

   ```powershell
   ollama create oreo-4b -f ~/oreo-ai/ollama/Modelfile.oreo-4b
   ollama create oreo-2b -f ~/oreo-ai/ollama/Modelfile.oreo-2b
   ```

2. Leave `oreo.ollamaUrl` at its default, `http://127.0.0.1:11434`. If nothing answers there, the extension looks for Ollama at the same port on the Mac's Tailscale address (any `100.64.0.0/10` address on its network interfaces, found without the `tailscale` command), which is where oreo-ai's `scripts/oreo-ai.sh models` makes it listen, and uses the first that answers. It looks again each time the model list loads (start-up, **Retry**, a settings change), so it follows Ollama when it moves. Set `oreo.ollamaUrl` to another address only if Ollama is elsewhere; a non-local address is used as given. Changing the setting reloads the model list.
3. Open the **Oreo Code** view in the activity bar, and chat. As in the Claude app, the message box has the text on top and, below it, a pill showing the model and whether it thinks (for example **Oreo 4B Thinking off**) and a round Send button. The pill opens one menu for the model and for **Thinking**, which offers only what the model takes: both models are qwen3.5, which can only think or not, so it shows **Off** and **On** (each model's style is set once in `src/ollama/models.ts`). The pick is sent with every message as `reasoning_effort`: `none` for Off, and the remembered level for On (medium the first time), which Ollama turns into thinking on. It starts off, because the models are small and slow to think on the M1, and remembers your pick. **Stop** keeps the partial reply; a failed reply is discarded and your text goes back into the box.
4. Ask about the open repository. Every message carries a snapshot of it: the folder name, the branch, its file list (without `node_modules`, `.git`, build output and `files.exclude`) and the file in the active editor with any selection. **Oreo 4B**, **Qwen3 30B** and **gpt-oss 120B** can also use three read-only tools while it answers: `list_files`, `search` and `read_file` (with line numbers, 12,000 characters at a time, unsaved editor text first). Each one it uses is shown above its reply, for example **→ Read src/extension.ts**. `search` takes plain text or a regular expression such as `TODO|FIXME`. While the model thinks, the reply shows **Thinking…**. It gets up to 8 rounds of tools, then must answer; if a reply still ends empty (a thinking model sometimes stops after its tools), it is asked once more with thinking off, and if that is empty too the turn fails and your text goes back into the box. Ollama cuts a prompt longer than the context silently, so the prompt is kept under about 72,000 characters (200,000 for gpt-oss, with its 128K context): the oldest earlier messages go first, then the oldest tool results are replaced by a note. It can't change files; it suggests changes as code. Files that may hold secrets (`.env*`, keys, `.npmrc`, `secrets.*`) are never read, searched or sent. **Oreo 2B** can't use tools, so it sees only the snapshot and asks you to open other files.
5. Replies are rendered as Markdown: headings, lists, tables, code blocks and links. Raw HTML in a reply is shown as text, images aren't loaded, and only `http` and `https` links work.
6. The Cloudflare models need nothing set up in the extension: with the Mac on Tailscale and oreo-ai's Cloudflare set up on the Pi, they appear in the pill's menu. `oreo.cloudUrl` points at the relay (default `https://ai.animesh.org.in/v1`; it must be `http` or `https`, with no query string, and trailing slashes are dropped). Leave it empty to turn the Cloudflare models off. Changing it reloads the model list. If the relay can't be reached, a failed reply says `Can't reach oreo-ai at <url>. Is the Mac on Tailscale?`.

If Ollama isn't running, the view says so in one line and offers **Retry**. Ollama gets 10 minutes to start answering (loading the model and reading a long prompt can take minutes on an 8 GB M1); a reply that has started is never cut off. If it doesn't start in time, the view says so and suggests Thinking off, Oreo 2B or a new chat.

## GitHub tools

The coding agent (next milestone) works on your GitHub repos through GitHub's own MCP server, which runs on this Mac as a child process of the extension. Nothing about GitHub goes to Ollama.

1. On GitHub, create a fine-grained token (Settings → Developer settings → Fine-grained tokens). Give it only the repos the agent may work on, with **Contents** and **Pull requests** set to read and write (**Metadata** read is added for you). 90 days is a good expiry.
2. Run `Oreo Code: Set GitHub token` and paste it. It is stored in the Keychain and passed only to the local `github-mcp-server`.
3. Run `Oreo Code: Show GitHub tools`. The first time, the extension downloads `github-mcp-server` 2.1.0 for your Mac from GitHub's releases into its own storage, and refuses it unless it matches the SHA-256 in the release's checksums file. The **Oreo Code** output panel then lists the tools.

The server gets only the `context`, `repos` and `pull_requests` tool groups. Read tools (files, search, branches, commits, pull requests) run straight away. Only four write tools are offered — create a branch, commit files, write one file, and open a pull request — and they will always ask for your approval. The rules are checked in code: new branches must be named `oreo-agent/<name>`, commits go only to `oreo-agent/` branches (never `main` or `master`), and pull requests go from an `oreo-agent/` branch into `main`. Merging, deleting, forking and settings tools are never offered; you merge the pull requests yourself. Long tool results are cut at 20,000 characters.

To use your own build of the server instead, set `oreo.githubMcp.path` to it.

## Settings

| Setting               | Default                        | Purpose                                                                                               |
| --------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `oreo.ollamaUrl`      | `http://127.0.0.1:11434`       | Base URL of Ollama; on a local address the Mac's Tailscale address is tried too                       |
| `oreo.githubMcp.path` | (empty)                        | Your own `github-mcp-server` binary; empty downloads the pinned release                               |
| `oreo.autoUpdate`     | `true`                         | Install new releases from GitHub by itself and offer a reload                                         |
| `oreo.cloudUrl`       | `https://ai.animesh.org.in/v1` | oreo-ai's Workers AI relay on the Pi (Tailscale only) for the Cloudflare models; empty turns them off |

## Commands

| Command                         | What it does                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `Oreo Code: New chat`           | Clears the conversation (also the + button on the view)                                |
| `Oreo Code: Set GitHub token`   | Stores the GitHub token for the local `github-mcp-server`                              |
| `Oreo Code: Clear GitHub token` | Removes it                                                                             |
| `Oreo Code: Show GitHub tools`  | Starts `github-mcp-server` if needed and lists its tools in the Oreo Code output panel |
| `Oreo Code: Check for updates`  | Installs the newest release now, if there is one (also in the view's … menu)           |

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
  ollama/url.ts             validates the oreo.ollamaUrl and oreo.cloudUrl settings, finds the Tailscale fallback
  cloudflare/client.ts      Workers AI chat through oreo-ai's relay: its model list, thinking per model, <think> filter
  cloudflare/errors.ts      one-sentence error messages for the relay
  chat/chatController.ts    chat state, turns and the tool loop; no vscode imports, unit tested
  chat/context.ts           the repo snapshot sent as the system prompt
  views/chatViewProvider.ts webview host, CSP, message relay
  shared/protocol.ts        messages between the extension and the webview
  mcp/githubBinary.ts       pinned github-mcp-server download and checksum check
  mcp/host.ts               starts MCP servers, keeps the tool catalog, routes calls
  mcp/stdioConnect.ts       MCP client over stdio (@modelcontextprotocol/sdk)
  agent/catalog.ts          MCP tools → namespaced function tools, read/write, allowlist
  agent/policy.ts           what runs, what needs approval, what is refused
  agent/workspaceTools.ts   read-only list_files, read_file and search; secret files refused
  workspace/vscodeWorkspace.ts  the open folder: files, unsaved text, branch, active editor
  update/releases.ts        finds and downloads a newer release from GitHub
webview-ui/                 Preact chat UI (markdown.ts renders replies safely), bundled to dist/webview.js
test/                       Vitest unit tests
```

## Releasing

Merging to `main` releases: CI builds the VSIX, numbers it (see [Install](#install)) and publishes `v<version>` with generated notes. Installed copies pick it up within 6 hours, or at once with `Oreo Code: Check for updates`. For a new minor or major series, change `version` in `package.json` in the PR.
