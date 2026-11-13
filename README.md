# Oreo Code

A VS Code extension on the Mac that chats with the models on the Mac's own Ollama, in the sidebar. Nothing leaves the Mac.

Part of the Oreo stack: [oreo-ai](https://github.com/animesh-net/oreo-ai) · [oreo-code](https://github.com/animesh-net/oreo-code) · [oreo-cloud](https://github.com/animesh-net/oreo-cloud) · [oreo-monitor](https://github.com/animesh-net/oreo-monitor)

## Architecture

- When VS Code starts, the picker lists every model the Mac's Ollama has at `oreo.ollamaUrl` (`GET /api/tags`), largest first, and keeps that list until VS Code restarts or the setting changes. What each can do comes from Ollama (`POST /api/show`): tools (agent mode), thinking (the Thinking menu), and its context (`num_ctx`, else Ollama's 4K default), which sets how much prompt it gets. Embedding models and Ollama's cloud models (such as `…-cloud`, which run on ollama.com) are left out. Until you pick one, the largest model with tools is used. Models are called straight on Ollama; no sign-in, no server in between.
- Inline completion (ghost text) comes from the smallest Qwen2.5-Coder model on the Mac's Ollama (fill-in-the-middle, e.g. `qwen2.5-coder:1.5b-base`), with an 8K context asked for on each request, about 300 ms after you stop typing. Each request carries snippets from the repo: files the current one imports, definitions of names near the cursor from a local symbol index (TypeScript/JavaScript, C#, Python; updated on save), and the most similar code in open and recently edited files. Secret files and files in `.gitignore` are never read. It pauses while a model is answering in chat. The status bar item shows its state; click it to turn completion on or off.
- When a chat or an agent task fills 95% of the model's context window, the model summarizes the earlier conversation and goes on from the summary, keeping the system prompt, the current question and the newest messages word for word; you still see the whole chat, and a step says it was compacted. Later turns of that chat start from the summary; New chat starts fresh.
- Each folder keeps its own chat across reloads of VS Code or the extension (in VS Code's workspace storage, up to about 1 MB, oldest turns dropped first); New chat clears it. Undo task and a pending approval don't survive a reload.
- Models with tools can read the open workspace (list, search, read; secret files refused). A local `github-mcp-server` over stdio is set up for the GitHub step of the agent, still to come.
- **Agent mode** (the **Agent** button, for a model with tools and a folder open): the model works through a task in up to 15 steps (6 more for each failed check it goes back to fix), finding code (including `find_symbol` from the completion symbol index), editing files (by line number with `replace_lines`, rewriting a small file whole with `write_file`, or replacing exact text), creating files, and running commands in the folder's root, with each step shown in the chat. The **Agent** switch and **Auto-edit** (apply edits without asking; on by default) stay as you set them, also after a reload. Edits and new files apply straight away, shown as diffs in the steps; after each change the model gets the file's latest copy, earlier copies are taken out of its conversation, and a line-number edit or rewrite of a file that changed since it last saw it (by a command or by you) is turned back with the latest copy; with Auto-edit off each one shows its diff for **Approve** or **Reject**. Every command shows the exact command line for approval, and so does every change to a file that decides what runs (`package.json`, lockfiles, `.npmrc`, scripts, hooks, build, CI, tool config and `.vscode` files). If it reaches the step limit mid-way, the reply says so; send "continue" to go on. A reply that only says what it will do next ("I'll remove the duplicate…") doesn't end the task: the model is told to do it. If it claims it changed files when it changed none (and ran no command), it's told so once and asked to make the change; if it still doesn't, the reply ends with a note that the task didn't change any file. It follows the repository's `AGENTS.md`, `CLAUDE.md` and `.github/copilot-instructions.md` (and a folder's own `AGENTS.md`/`CLAUDE.md` when it works there). After each edit it reads VS Code's errors for the file and fixes the ones it added; when it says it's done, it checks the changed files again for any errors left (new or from before) and runs the project's check (`npm run check`/`test`, `dotnet build`, `cargo check` or `go build`, found from the project; without one, it parses the changed Python files with Python's own parser; JavaScript and TypeScript errors come from VS Code itself), then, if the project has a `start` script, starts the app for a few seconds and asks it for `/`, so a crash, an error answer or a request that never answers counts too (and, for an app that serves pages, exiting at once or not answering on its port; a command the model runs to start the app is run the same way, for a few seconds, since a command has to end); it goes back to fix failures up to 3 times and saying plainly if they still fail. All of this is automatic, with nothing to set up; the project check and starting the app each ask once per task before the first run (they run your code), then run on their own. **Stop** ends the task; **Undo task** (kept across New chat) puts back every file the last task that changed files wrote, except one changed again since (commands aren't undone). It never writes in `.git`, secret files, through symbolic links or outside the folder.
- Each message carries the repo's file list and the open file; replies are length-capped and earlier answers go back shortened, so follow-ups answer only what's new.
- Every merge to `main` publishes a VSIX release; the extension updates itself from it.

| Path               | What it is                         |
| ------------------ | ---------------------------------- |
| `src/extension.ts` | Commands, sidebar view, status bar |
| `src/ollama/`      | Ollama client and model discovery  |
| `src/chat/`        | Chat state, turns, tool loop       |
| `src/mcp/`         | Pinned `github-mcp-server` host    |
| `src/agent/`       | Agent loop, tools, approval policy |
| `src/completion/`  | Inline completion and symbol index |
| `src/update/`      | Self-update from GitHub releases   |
| `webview-ui/`      | Preact chat UI                     |
| `test/`            | Vitest unit tests                  |

## Run it

- macOS with VS Code and [Ollama](https://ollama.com)
- GitHub CLI, for the first install below (self-update needs no sign-in)

1. Have at least one model in Ollama: one with tools for agent mode (e.g. `qwen3.5:4b`) and a Qwen2.5-Coder base model for inline completion. For more than a 4K context, set `num_ctx` in the model's Modelfile:

   ```powershell
   ollama pull qwen3.5:4b; ollama pull qwen2.5-coder:1.5b-base
   ```

2. Install the newest release (later releases install themselves):

   ```powershell
   gh release download --repo animesh-net/oreo-code --pattern '*.vsix' --dir ~/Downloads --clobber; code --install-extension (Get-ChildItem ~/Downloads/oreo-code-*.vsix | Sort-Object LastWriteTime | Select-Object -Last 1).FullName --force
   ```

3. Open the **Oreo Code** view in the activity bar and chat. After adding or removing Ollama models, reload the window to list them.
4. Optional, for the GitHub tools: run `Oreo Code: Set GitHub token` with a fine-grained token (**Contents** and **Pull requests** read and write on the repos the agent may use).

| Setting                             | Default                     | What it is                                       |
| ----------------------------------- | --------------------------- | ------------------------------------------------ |
| `oreo.ollamaUrl`                    | `http://127.0.0.1:11434`    | Ollama; the Mac's Tailscale address is tried too |
| `oreo.githubMcp.path`               | (empty)                     | Own `github-mcp-server`; empty downloads it      |
| `oreo.autoUpdate`                   | `true`                      | Install new releases by itself                   |
| `oreo.completion.enabled`           | `true`                      | Inline completion from a Qwen2.5-Coder model     |
| `oreo.completion.disabledLanguages` | `["plaintext", "markdown"]` | Languages without inline completion              |

## Develop

Node 22: `npm ci`, then `npm run check` (typecheck, tests, build); **F5** starts an Extension Development Host and `npm run package` builds a VSIX. `npm run eval` runs agent tasks on small broken projects against the Mac's Ollama (`oreo-4b` unless `OREO_EVAL_MODEL` names another, 3 runs each; `OREO_OLLAMA_URL`, `OREO_EVAL_MODEL`, `OREO_EVAL_RUNS`, `OREO_EVAL_ONLY`; like the extension, it also tries the Mac's Tailscale address) and writes `eval-report.md`. Repo rules are in [CLAUDE.md](CLAUDE.md).

## License

Released under the [MIT License](LICENSE).
