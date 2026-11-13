<img src="media/icon.png" alt="Oreo logo" width="96" />

# Oreo Code

A VS Code extension for chatting and coding with the models on your Mac's own [Ollama](https://ollama.com). Nothing leaves the Mac.

## How it works

- **Models:** at start-up it lists the models Ollama has and reads what each can do: tools, thinking, context size. Pick one under the chat box; until you do, the largest with tools is used. Reload the window after pulling a new model.
- **Chat:** ask about the open folder. Each message carries the file list and the open file, and a model with tools can list, search and read files.
- **Agent mode:** with **Agent** on, the model edits files and runs commands to finish a task. It follows the repo's `AGENTS.md` and `CLAUDE.md`, checks its changes for errors, runs the project's check and starts the app before it says it's done. Commands always ask first, and **Undo task** puts back every file it changed.
- **Inline completion:** ghost text as you type, from a Qwen2.5-Coder model, using snippets from the repo.
- **Long chats:** summarized once they fill 95% of the model's context, and kept per folder across reloads.

## Prerequisites

- macOS with VS Code and Ollama
- A model with tools for chat and agent mode, and a Qwen2.5-Coder base model for completion:

  ```powershell
  ollama pull qwen3.5:4b; ollama pull qwen2.5-coder:1.5b-base
  ```

  Ollama runs a model with a 4K context unless its Modelfile sets `num_ctx`; set it higher for longer chats and agent tasks.

- GitHub CLI, for the first install (later releases install themselves)

## Install

```powershell
gh release download --repo animesh-net/oreo-code --pattern '*.vsix' --dir ~/Downloads --clobber; code --install-extension (Get-ChildItem ~/Downloads/oreo-code-*.vsix | Sort-Object LastWriteTime | Select-Object -Last 1).FullName --force
```

Open **Oreo Code** in the activity bar. If Ollama isn't at `http://127.0.0.1:11434`, set `oreo.ollamaUrl`.

## Develop

Node 22: `npm ci`, then `npm run check` (typecheck, tests, build). **F5** starts an Extension Development Host, `npm run package` builds a VSIX and `npm run eval` runs agent tasks against a real model on Ollama. The code's layout and the rules for changing it are in [CLAUDE.md](CLAUDE.md).

## License

Released under the [MIT License](LICENSE).
