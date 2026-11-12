# Oreo Code

A VS Code extension on the Mac that chats with the Oreo models on the Mac's own Ollama, and two Cloudflare Workers AI models through oreo-ai, in the sidebar.

Part of the Oreo stack: [oreo-ai](https://github.com/animesh-net/oreo-ai) · [oreo-code](https://github.com/animesh-net/oreo-code) · [oreo-cloud](https://github.com/animesh-net/oreo-cloud) · [oreo-monitor](https://github.com/animesh-net/oreo-monitor)

## Architecture

- The picker lists the same models as oreo-ai, largest first: `Oreo 120B`, `Oreo 30B`, `Oreo 4B`, `Oreo 2B`, `Oreo 1.5B`.
- Mac models (`Oreo 4B`, `Oreo 2B`, `Oreo 1.5B`) are called straight on Ollama at `oreo.ollamaUrl`; no sign-in, no server in between. `Oreo 1.5B` is a code-completion model: no thinking and no tools, and only used in chat when you pick it.
- Inline completion (ghost text) comes from `Oreo 1.5B` on the Mac's Ollama, about 300 ms after you stop typing. Each request carries snippets from the repo: files the current one imports, definitions of names near the cursor from a local symbol index (TypeScript/JavaScript, C#, Python; updated on save), and the most similar code in open and recently edited files. Secret files and files in `.gitignore` are never read, and nothing goes to oreo-ai or Cloudflare. It pauses while a Mac model is answering in chat. The status bar item shows its state; click it to turn completion on or off.
- Cloudflare models (`Oreo 120B`, `Oreo 30B`) go through oreo-ai's relay on the Pi at `oreo.cloudUrl`, over Tailscale only; the Pi holds the token. Nothing leaves the Mac unless you pick one.
- Models with tools can read the open workspace (list, search, read; secret files refused). A local `github-mcp-server` over stdio is set up for the GitHub step of the agent, still to come.
- **Agent mode** (the **Agent** button, for `Oreo 120B`, `Oreo 30B` and `Oreo 4B` with a folder open): the model works through a task in up to 15 steps, finding code (including `find_symbol` from the completion symbol index), editing and creating files, and running commands in the folder's root, with each step shown in the chat. Every edit and new file shows its diff for **Approve** or **Reject**, and every command shows the exact command line; **Approve edits for this task** skips the card for edits and new files only, never for files that decide what runs (`package.json`, scripts, hooks, build, CI and `.vscode` files). **Stop** ends the task; **Undo task** puts back every file the last task changed, except one changed again since (commands aren't undone). It never writes in `.git`, secret files, through symbolic links or outside the folder. With a Cloudflare model the files it reads leave the Mac and each step uses Neurons; if Cloudflare's limit is hit mid-task, it moves to `Oreo 4B`.
- Each message carries the repo's file list and the open file; replies are length-capped and earlier answers go back shortened, so follow-ups answer only what's new.
- Every merge to `main` publishes a VSIX release; the extension updates itself from it.

| Path               | What it is                          |
| ------------------ | ----------------------------------- |
| `src/extension.ts` | Commands, sidebar view, status bar  |
| `src/ollama/`      | Ollama client and the model list    |
| `src/cloudflare/`  | Workers AI client via oreo-ai relay |
| `src/chat/`        | Chat state, turns, tool loop        |
| `src/mcp/`         | Pinned `github-mcp-server` host     |
| `src/agent/`       | Agent loop, tools, approval policy  |
| `src/completion/`  | Inline completion and symbol index  |
| `src/update/`      | Self-update from GitHub releases    |
| `webview-ui/`      | Preact chat UI                      |
| `test/`            | Vitest unit tests                   |

## Run it

- macOS with VS Code and [Ollama](https://ollama.com)
- oreo-ai's files in `~/oreo-ai` (for the Modelfiles), from its image as in oreo-ai's README
- GitHub CLI, for the first install below (self-update needs no sign-in)
- Tailscale, for the Cloudflare models

1. Create the Mac models:

   ```powershell
   ollama create oreo-4b -f ~/oreo-ai/ollama/Modelfile.oreo-4b; ollama create oreo-2b -f ~/oreo-ai/ollama/Modelfile.oreo-2b; ollama create oreo-1.5b -f ~/oreo-ai/ollama/Modelfile.oreo-1.5b
   ```

2. Install the newest release (later releases install themselves):

   ```powershell
   gh release download --repo animesh-net/oreo-code --pattern '*.vsix' --dir ~/Downloads --clobber; code --install-extension (Get-ChildItem ~/Downloads/oreo-code-*.vsix | Sort-Object LastWriteTime | Select-Object -Last 1).FullName --force
   ```

3. Open the **Oreo Code** view in the activity bar and chat.
4. Optional, for the GitHub tools: run `Oreo Code: Set GitHub token` with a fine-grained token (**Contents** and **Pull requests** read and write on the repos the agent may use).

| Setting                             | Default                        | What it is                                       |
| ----------------------------------- | ------------------------------ | ------------------------------------------------ |
| `oreo.ollamaUrl`                    | `http://127.0.0.1:11434`       | Ollama; the Mac's Tailscale address is tried too |
| `oreo.cloudUrl`                     | `https://ai.animesh.org.in/v1` | oreo-ai's relay; empty turns Cloudflare off      |
| `oreo.githubMcp.path`               | (empty)                        | Own `github-mcp-server`; empty downloads it      |
| `oreo.autoUpdate`                   | `true`                         | Install new releases by itself                   |
| `oreo.completion.enabled`           | `true`                         | Inline completion from `Oreo 1.5B`               |
| `oreo.completion.disabledLanguages` | `["plaintext", "markdown"]`    | Languages without inline completion              |

## Develop

Node 22: `npm ci`, then `npm run check` (typecheck, tests, build); **F5** starts an Extension Development Host and `npm run package` builds a VSIX. Repo rules are in [CLAUDE.md](CLAUDE.md).

## License

Released under the [MIT License](LICENSE).
