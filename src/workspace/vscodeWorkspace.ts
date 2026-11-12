import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import type { ActiveFile } from '../agent/workspaceTools';
import type { Problem } from '../agent/instructions';
import { smokeRun, type SmokeResult } from '../agent/smoke';
import { COMMAND_TIMEOUT_MS, commandEnv, type CommandResult, type WritableWorkspace } from '../agent/writeTools';

/** Folders never listed or read: dependencies, git internals and build output. */
const EXCLUDE =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/coverage/**,**/.next/**,**/bin/**,**/obj/**,**/.venv/**,**/*.vsix}';
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1_000_000;
const LIST_TTL_MS = 30_000;

/** Output kept from a command, half from its start and half from its end; the model gets less (src/agent/writeTools.ts). */
const MAX_COMMAND_CAPTURE = 200_000;
/** The longest wait for language support to re-check a changed file. */
const PROBLEMS_WAIT_MS = 2_500;
/** Quiet time after the last diagnostics update before reading them. */
const PROBLEMS_SETTLE_MS = 400;
/** How long output may still arrive after the shell exits. */
const EXIT_DRAIN_MS = 1_000;
/** How long a stopped command gets to exit before it is killed outright. */
const KILL_GRACE_MS = 5_000;

/** The first open folder, or undefined when none is open. */
export function currentWorkspace(): WritableWorkspace | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? new FolderWorkspace(folder) : undefined;
}

let cached: { root: string; at: number; files: Promise<string[]> } | undefined;

class FolderWorkspace implements WritableWorkspace {
  readonly name: string;
  readonly root: string;

  constructor(private readonly folder: vscode.WorkspaceFolder) {
    this.name = folder.name;
    this.root = folder.uri.fsPath;
  }

  private uri(path: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folder.uri, ...path.split('/'));
  }

  async problems(path: string, wait: boolean): Promise<Problem[]> {
    const uri = this.uri(path);
    if (wait) {
      try {
        // Open (not show) the file, so its language support checks it.
        await vscode.workspace.openTextDocument(uri);
      } catch {
        return [];
      }
      await new Promise<void>((resolve) => {
        let settle: NodeJS.Timeout | undefined;
        const done = () => {
          sub.dispose();
          clearTimeout(limit);
          if (settle) clearTimeout(settle);
          resolve();
        };
        const sub = vscode.languages.onDidChangeDiagnostics((e) => {
          if (!e.uris.some((u) => u.toString() === uri.toString())) return;
          if (settle) clearTimeout(settle);
          settle = setTimeout(done, PROBLEMS_SETTLE_MS);
        });
        const limit = setTimeout(done, PROBLEMS_WAIT_MS);
      });
    }
    return vscode.languages
      .getDiagnostics(uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
      .map((d) => ({ line: d.range.start.line + 1, message: d.message, source: d.source }));
  }

  unsavedFiles(): string[] {
    const root = this.folder.uri.toString() + '/';
    return vscode.workspace.textDocuments
      .filter((d) => d.isDirty && d.uri.toString().startsWith(root))
      .map((d) => vscode.workspace.asRelativePath(d.uri, false));
  }

  /** lstat, so a symlink counts as existing even when what it points to doesn't. */
  async exists(path: string): Promise<boolean> {
    try {
      await lstat(this.uri(path).fsPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Refuses a write that a symlink would take outside the folder: the file itself
   * may not be a symlink, and its nearest existing folder must resolve inside the
   * folder's real path.
   */
  async writeProblem(path: string): Promise<string | undefined> {
    try {
      await this.assertInside(path);
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  }

  private async assertInside(path: string): Promise<void> {
    const target = this.uri(path).fsPath;
    const root = await realpath(this.root);
    let link = false;
    try {
      link = (await lstat(target)).isSymbolicLink();
    } catch {
      // Doesn't exist yet: a new file.
    }
    if (link) throw new Error(`${path} is a symbolic link; agent mode doesn't write through links.`);
    let dir = nodePath.dirname(target);
    for (;;) {
      try {
        const real = await realpath(dir);
        if (real !== root && !real.startsWith(root + nodePath.sep)) {
          throw new Error(`${path} is outside the open folder (through a symbolic link).`);
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const parent = nodePath.dirname(dir);
        if (parent === dir) throw new Error(`${path} is outside the open folder.`);
        dir = parent;
      }
    }
  }

  /**
   * Writes the whole file. An open editor gets the text as an edit and is saved, so
   * its undo history and unsaved state stay consistent; otherwise the file is written
   * on disk, creating its folders.
   */
  async writeFile(path: string, text: string): Promise<void> {
    await this.assertInside(path);
    const uri = this.uri(path);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), text);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code didn't apply the edit to ${path}.`);
      // Commands the agent runs read the disk, so an edit that isn't saved hasn't happened for them.
      if (!(await open.save())) throw new Error(`VS Code couldn't save ${path}.`);
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    }
    cached = undefined;
  }

  async deleteFile(path: string): Promise<void> {
    await this.assertInside(path);
    await vscode.workspace.fs.delete(this.uri(path), { useTrash: true });
    cached = undefined;
  }

  /**
   * Runs the command line with the user's login shell in the folder's root, as typed
   * in a terminal there, so PATH tools (npm, dotnet) are found. Stopped after
   * COMMAND_TIMEOUT_MS or on Stop.
   */
  smokeRun(command: string, signal: AbortSignal, server: boolean): Promise<SmokeResult> {
    return smokeRun({
      cwd: this.root,
      command,
      shell: process.env.SHELL || '/bin/zsh',
      shellArgs: ['-lc'],
      env: commandEnv(process.env),
      signal,
      server,
    });
  }

  runCommand(command: string, signal: AbortSignal): Promise<CommandResult> {
    return new Promise((resolve) => {
      const shell = process.env.SHELL || '/bin/zsh';
      const child = spawn(shell, ['-lc', command], {
        cwd: this.root,
        env: commandEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so Stop and the timeout end the whole command, not just the shell.
        detached: true,
      });
      // The start and a rolling end of the output: failures are usually reported last.
      let head = '';
      let tail = '';
      let dropped = 0;
      let timedOut = false;
      const half = MAX_COMMAND_CAPTURE / 2;
      const add = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        const room = half - head.length;
        if (room > 0) head += text.slice(0, room);
        tail += text.slice(Math.max(0, room));
        if (tail.length > half) {
          dropped += tail.length - half;
          tail = tail.slice(-half);
        }
      };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const signalGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          child.kill(sig);
        }
      };
      // SIGTERM first; a command that ignores it is killed outright after a grace period.
      let forceTimer: NodeJS.Timeout | undefined;
      const kill = () => {
        signalGroup('SIGTERM');
        forceTimer ??= setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, COMMAND_TIMEOUT_MS);
      signal.addEventListener('abort', kill, { once: true });
      if (signal.aborted) kill();
      let finished = false;
      const done = (exitCode: number | undefined, extra = '') => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        signal.removeEventListener('abort', kill);
        cached = undefined;
        const output = head + (dropped ? `\n… (${dropped} characters cut) …\n` : '') + tail + extra;
        resolve({ exitCode, output, timedOut });
      };
      child.on('error', (err) => done(undefined, err.message));
      child.on('close', (code) => done(code ?? undefined));
      // A background process (e.g. "npm run dev &") can keep the output open after the
      // command itself has ended; finish shortly after the shell exits rather than wait.
      child.on('exit', (code) => setTimeout(() => done(code ?? undefined), EXIT_DRAIN_MS));
    });
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
    const uri = this.uri(path);
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
