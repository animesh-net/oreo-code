import * as vscode from 'vscode';
import { isSecretPath } from '../agent/workspaceTools';
import { CompletionEngine, DEBOUNCE_MS, delay, skipReason, type CompletionSettings } from '../completion/engine';
import { GitIgnore } from '../completion/gitignore';
import { languageOf } from '../completion/imports';
import { INDEX_LIMITS, SymbolIndex, type CodeSymbol } from '../completion/symbols';
import { completionModel } from '../ollama/models';
import type { ViewState } from '../shared/protocol';
import { currentWorkspace } from './vscodeWorkspace';

const RECENT_MAX = 20;
/** Folders never indexed, as in the workspace listing. */
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|out|build|coverage|\.next|bin|obj|\.venv)\//;

/** The symbol index inline completion keeps, shared with agent mode's find_symbol. */
export interface SharedSymbols {
  /** Definitions by exact name; builds the index first if it isn't yet. */
  find(name: string): Promise<readonly CodeSymbol[]>;
}

/**
 * Inline completion (ghost text) from the Mac's completion model, with snippets from
 * the repository: imported files, definitions from the symbol index, and open and
 * recently edited files. Only the Mac's Ollama is called; nothing leaves the Mac.
 */
export function registerInlineCompletion(
  context: vscode.ExtensionContext,
  getState: () => ViewState | undefined,
  onStateChange: vscode.Event<void>,
): SharedSymbols {
  const config = () => vscode.workspace.getConfiguration('oreo.completion');
  const recent: string[] = [];
  const symbols = new SymbolIndex();
  let gitignore: GitIgnore | undefined;
  let gitignoreLoaded: Promise<void> | undefined;
  let indexing: Promise<void> | undefined;

  const relative = (uri: vscode.Uri): string | undefined => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (
      !folder ||
      uri.scheme !== 'file' ||
      vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString()
    ) {
      return undefined;
    }
    return vscode.workspace.asRelativePath(uri, false);
  };
  const touch = (uri: vscode.Uri) => {
    const p = relative(uri);
    if (!p) return;
    const i = recent.indexOf(p);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift(p);
    recent.length = Math.min(recent.length, RECENT_MAX);
  };
  const openTabs = (): string[] => {
    const out: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const p = relative(tab.input.uri);
          if (p && !out.includes(p)) out.push(p);
        }
      }
    }
    return out;
  };

  const loadGitignore = async () => {
    const ws = currentWorkspace();
    try {
      gitignore = ws ? new GitIgnore(await ws.readFile('.gitignore')) : undefined;
    } catch {
      gitignore = new GitIgnore();
    }
  };

  const loadGitignoreOnce = () => (gitignoreLoaded ??= loadGitignore());

  const indexable = (p: string) => !!languageOf(p) && !SKIP_DIRS.test(p) && !isSecretPath(p) && !gitignore?.ignores(p);

  /** Builds the symbol index in the background, a few files at a time; once per workspace. */
  const ensureIndex = () => {
    indexing ??= (async () => {
      const ws = currentWorkspace();
      if (!ws) return;
      await loadGitignoreOnce();
      const files = (await ws.listFiles()).filter(indexable).slice(0, INDEX_LIMITS.maxFiles);
      for (let i = 0; i < files.length; i++) {
        try {
          symbols.update(files[i], await ws.readFile(files[i]));
        } catch {
          // Unreadable or too big: left out.
        }
        // Give the editor room to breathe between batches.
        if (i % 25 === 24) await new Promise((r) => setTimeout(r, 0));
      }
    })();
    return indexing;
  };

  const reindex = async (uri: vscode.Uri) => {
    const p = relative(uri);
    if (!p) return;
    if (p === '.gitignore') {
      gitignoreLoaded = loadGitignore();
      return;
    }
    if (!indexing) return;
    if (!indexable(p)) return symbols.remove(p);
    try {
      symbols.update(p, await currentWorkspace()!.readFile(p));
    } catch {
      symbols.remove(p);
    }
  };

  const engine = new CompletionEngine({
    repoName: () => currentWorkspace()?.name ?? 'workspace',
    ollamaUrl: () => getState()?.ollamaUrl || undefined,
    model: () => completionModel(getState()?.models ?? [])?.id,
    sources: {
      listFiles: async () => (await currentWorkspace()?.listFiles()) ?? [],
      readFile: async (p) => {
        const ws = currentWorkspace();
        if (!ws) throw new Error('No folder is open.');
        return ws.readFile(p);
      },
      recentFiles: () => [...new Set([...recent, ...openTabs()])],
      gitignore: () => gitignore,
      symbols,
    },
  });

  const settings = (): CompletionSettings => {
    const state = getState();
    return {
      enabled: config().get<boolean>('enabled', true),
      disabledLanguages: config().get<string[]>('disabledLanguages', ['plaintext', 'markdown']),
      modelInstalled: !!completionModel(state?.models ?? []),
      macChatBusy: !!state?.busy,
    };
  };

  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _context, token) {
      const path = relative(document.uri);
      if (!path || isSecretPath(path)) return undefined;
      const editor = vscode.window.activeTextEditor;
      const hasSelection = editor?.document === document && !editor.selection.isEmpty;
      const offset = document.offsetAt(position);
      const text = document.getText();
      const req = {
        path,
        languageId: document.languageId,
        prefix: text.slice(0, offset),
        suffix: text.slice(offset),
        hasSelection,
      };
      if (skipReason(req, settings())) return undefined;

      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      try {
        // A new keystroke cancels this request before it reaches Ollama.
        if (!(await delay(DEBOUNCE_MS, controller.signal))) return undefined;
        void ensureIndex();
        await loadGitignoreOnce();
        const completion = await engine.complete(req, controller.signal);
        if (!completion || token.isCancellationRequested) return undefined;
        return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
      } catch {
        // Ollama down or the request cancelled: no ghost text, no error popup while typing.
        return undefined;
      } finally {
        sub.dispose();
      }
    },
  };

  // Status bar: what completion is doing; a click turns it on or off.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  status.command = 'oreo.toggleCompletion';
  const updateStatus = () => {
    const s = settings();
    const name = completionModel(getState()?.models ?? [])?.name ?? '';
    if (!s.enabled) {
      status.text = '$(circle-slash) Completion';
      status.tooltip = 'Oreo Code completion is off. Click to turn it on.';
    } else if (!s.modelInstalled) {
      status.text = '$(warning) Completion';
      status.tooltip =
        'No model on the Mac\'s Ollama can write completions. Pull a Qwen2.5-Coder model, e.g. "ollama pull qwen2.5-coder:1.5b-base", then reload the window.';
    } else {
      status.text = `$(sparkle) ${name}`;
      status.tooltip = `Oreo Code completion from ${name} on the Mac. Click to turn it off.`;
    }
    status.show();
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,cs,py}');
  const gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),
    status,
    watcher,
    gitignoreWatcher,
    watcher.onDidChange(reindex),
    watcher.onDidCreate(reindex),
    watcher.onDidDelete((uri) => {
      const p = relative(uri);
      if (p) symbols.remove(p);
    }),
    gitignoreWatcher.onDidChange(reindex),
    gitignoreWatcher.onDidCreate(reindex),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length) touch(e.document.uri);
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => e && touch(e.document.uri)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      symbols.clear();
      engine.clearCache();
      recent.length = 0;
      indexing = undefined;
      gitignoreLoaded = undefined;
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('oreo.completion')) updateStatus();
    }),
    onStateChange(updateStatus),
    vscode.commands.registerCommand('oreo.toggleCompletion', async () => {
      await config().update('enabled', !config().get<boolean>('enabled', true), vscode.ConfigurationTarget.Global);
    }),
  );
  updateStatus();
  // Build the index a little after start-up, out of the way of activation.
  const timer = setTimeout(() => void ensureIndex(), 5_000);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  return {
    find: async (name) => {
      await ensureIndex();
      return symbols.lookup(name);
    },
  };
}
