import * as vscode from 'vscode';
import type { ActiveFile, Workspace } from '../agent/workspaceTools';

/** Folders never listed or read: dependencies, git internals and build output. */
const EXCLUDE =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/coverage/**,**/.next/**,**/bin/**,**/obj/**,**/.venv/**,**/*.vsix}';
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1_000_000;
const LIST_TTL_MS = 30_000;

/** The first open folder, or undefined when none is open. */
export function currentWorkspace(): Workspace | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? new FolderWorkspace(folder) : undefined;
}

let cached: { root: string; at: number; files: Promise<string[]> } | undefined;

class FolderWorkspace implements Workspace {
  readonly name: string;

  constructor(private readonly folder: vscode.WorkspaceFolder) {
    this.name = folder.name;
  }

  listFiles(): Promise<string[]> {
    const root = this.folder.uri.toString();
    if (!cached || cached.root !== root || Date.now() - cached.at > LIST_TTL_MS) {
      const files = Promise.resolve(
        vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, '**/*'), EXCLUDE, MAX_FILES),
      ).then((uris) => uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort());
      cached = { root, at: Date.now(), files };
      return files;
    }
    return cached.files;
  }

  /** Unsaved editor text wins over the file on disk. */
  async readFile(path: string): Promise<string> {
    const uri = vscode.Uri.joinPath(this.folder.uri, ...path.split('/'));
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${path} is over 1 MB.`);
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    if (text.includes('\0')) throw new Error(`${path} is a binary file.`);
    return text;
  }

  async branch(): Promise<string | undefined> {
    try {
      const head = new TextDecoder()
        .decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.folder.uri, '.git', 'HEAD')))
        .trim();
      return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 7);
    } catch {
      return undefined;
    }
  }

  activeFile(): ActiveFile | undefined {
    const editor = vscode.window.activeTextEditor;
    if (
      !editor ||
      vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.toString() !== this.folder.uri.toString()
    ) {
      return undefined;
    }
    const selection = editor.selection.isEmpty ? undefined : editor.document.getText(editor.selection);
    return {
      path: vscode.workspace.asRelativePath(editor.document.uri, false),
      text: editor.document.getText(),
      selection,
    };
  }
}
