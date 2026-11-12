import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Problem } from '../../src/agent/instructions';
import { COMMAND_TIMEOUT_MS, commandEnv, type CommandResult, type WritableWorkspace } from '../../src/agent/writeTools';

/** Folders a project listing leaves out, as VS Code's does. */
const SKIPPED = new Set(['node_modules', '.git', '__pycache__', '.venv']);

/**
 * A real folder on disk standing in for VS Code's workspace: files are read and written
 * on disk, commands really run, and `problems` stands in for VS Code's error list by
 * parsing JavaScript with `node --check` and Python with its own parser.
 */
export class DiskWorkspace implements WritableWorkspace {
  readonly name: string;

  constructor(readonly root: string) {
    this.name = path.basename(root);
  }

  /** A new temporary folder holding `files`. */
  static async create(files: Record<string, string>): Promise<DiskWorkspace> {
    const root = await mkdtemp(path.join(tmpdir(), 'oreo-e2e-'));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
    }
    return new DiskWorkspace(root);
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  private abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (SKIPPED.has(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
        else out.push(rel);
      }
    };
    await walk(this.root, '');
    return out.sort();
  }

  async readFile(rel: string): Promise<string> {
    return readFile(this.abs(rel), 'utf8');
  }

  async branch(): Promise<string | undefined> {
    return undefined;
  }

  activeFile(): undefined {
    return undefined;
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await lstat(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  async writeProblem(rel: string): Promise<string | undefined> {
    const target = this.abs(rel);
    const root = await realpath(this.root);
    try {
      if ((await lstat(target)).isSymbolicLink()) return `${rel} is a symbolic link.`;
    } catch {
      // New file.
    }
    let dir = path.dirname(target);
    for (;;) {
      try {
        const real = await realpath(dir);
        return real === root || real.startsWith(root + path.sep) ? undefined : `${rel} is outside the open folder.`;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) return `${rel} is outside the open folder.`;
        dir = parent;
      }
    }
  }

  async writeFile(rel: string, text: string): Promise<void> {
    const problem = await this.writeProblem(rel);
    if (problem) throw new Error(problem);
    await mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await writeFile(this.abs(rel), text);
  }

  async deleteFile(rel: string): Promise<void> {
    await rm(this.abs(rel), { force: true });
  }

  async problems(rel: string): Promise<Problem[]> {
    const file = this.abs(rel);
    let result;
    if (/\.(js|mjs|cjs)$/.test(rel)) result = spawnSync('node', ['--check', file], { encoding: 'utf8' });
    else if (/\.py$/.test(rel)) {
      result = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])', file], {
        encoding: 'utf8',
      });
    } else return [];
    if (result.status === 0 || result.error) return [];
    const out = `${result.stderr}`;
    const line = Number(/:(\d+)\s*\n/.exec(out)?.[1] ?? /line (\d+)/.exec(out)?.[1] ?? 1);
    const message =
      /(SyntaxError|IndentationError|TabError): .*/.exec(out)?.[0] ?? out.trim().split('\n').at(-1) ?? 'error';
    return [{ line, message }];
  }

  runCommand(command: string, signal: AbortSignal): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: this.root,
        env: commandEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let output = '';
      let timedOut = false;
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, COMMAND_TIMEOUT_MS);
      signal.addEventListener('abort', kill, { once: true });
      child.stdout.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr.on('data', (d: Buffer) => (output += d.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', kill);
        resolve({ exitCode: code ?? undefined, output, timedOut });
      });
    });
  }
}
