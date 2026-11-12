import type { FunctionTool, ToolCall } from '../ollama/client';
import { capResult } from './policy';
import { isSecretPath, type Workspace } from './workspaceTools';

/**
 * The open folder as agent mode's write tools see it: the read-only workspace plus
 * writing, deleting (only to undo a file the task created) and running a command in
 * the folder. Paths are relative, with forward slashes.
 */
export interface WritableWorkspace extends Workspace {
  /** The folder's path, shown on a command's approval card. */
  root?: string;
  /** True if the path exists on disk, listed or not. */
  exists(path: string): Promise<boolean>;
  writeFile(path: string, text: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /** Runs a command line in the folder's root with the user's shell. */
  runCommand(command: string, signal: AbortSignal): Promise<CommandResult>;
}

export interface CommandResult {
  /** Undefined when the command was killed (timeout or Stop). */
  exitCode: number | undefined;
  output: string;
  timedOut: boolean;
}

/** How long a command may run before it is stopped. */
export const COMMAND_TIMEOUT_MS = 120_000;
/** Output sent back to the model; the rest is cut. */
export const MAX_COMMAND_OUTPUT_CHARS = 12_000;
/** How much of a diff the approval card shows. */
export const MAX_DIFF_CHARS = 8_000;

export type WriteToolName = 'edit_file' | 'create_file' | 'run_command';

/** Tools that change the folder: each one goes through approval (src/agent/policy.ts). */
export const WRITE_TOOLS: FunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Change a file in the open repository by replacing one exact piece of text. old_text must appear exactly once in the file, including its indentation; read the file first and copy enough lines to make it unique. The user approves each edit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path, as list_files shows it' },
          old_text: { type: 'string', description: 'The exact text to replace' },
          new_text: { type: 'string', description: 'The text to put in its place' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a new file in the open repository. Fails if the file already exists. The user approves it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path of the new file' },
          content: { type: 'string', description: 'The whole file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: `Run a shell command in the repository's root folder, e.g. "npm test" or "dotnet build". Returns the exit code and output. Stopped after ${COMMAND_TIMEOUT_MS / 1000} seconds. The user approves every command.`,
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The command line to run' } },
        required: ['command'],
      },
    },
  },
];

export function isWriteTool(name: string): name is WriteToolName {
  return WRITE_TOOLS.some((t) => t.function.name === name);
}

/** A write waiting for approval: what it will do, shown on the card before anything changes. */
export type PendingWrite =
  | { kind: 'edit_file'; path: string; oldText: string; newText: string; diff: string }
  | { kind: 'create_file'; path: string; content: string; diff: string }
  | { kind: 'run_command'; command: string };

/** Checks a write tool call and works out what it would change, without changing anything. */
export async function prepareWrite(
  ws: WritableWorkspace,
  call: ToolCall,
): Promise<{ pending: PendingWrite } | { error: string }> {
  let args: Record<string, unknown>;
  try {
    args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
  } catch {
    return { error: 'Error: arguments were not valid JSON.' };
  }
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined);

  switch (call.function.name) {
    case 'edit_file': {
      const path = cleanPath(str('path') ?? '');
      const problem = writePathProblem(path);
      if (problem) return { error: problem };
      const oldText = str('old_text');
      const newText = str('new_text');
      if (!oldText) return { error: 'Error: old_text is empty. Copy the exact text to replace from read_file.' };
      if (newText === undefined) return { error: 'Error: new_text is missing.' };
      if (!(await ws.exists(path))) return { error: `Error: ${path} doesn't exist. Use create_file for a new file.` };
      let text: string;
      try {
        text = await ws.readFile(path);
      } catch (err) {
        return { error: `Error: ${(err as Error).message}` };
      }
      const found = replaceOnce(text, oldText, newText, path);
      if ('error' in found) return found;
      return { pending: { kind: 'edit_file', path, oldText, newText, diff: makeDiff(path, text, found.text) } };
    }
    case 'create_file': {
      const path = cleanPath(str('path') ?? '');
      const problem = writePathProblem(path);
      if (problem) return { error: problem };
      const content = str('content') ?? '';
      if (await ws.exists(path)) return { error: `Error: ${path} already exists. Use edit_file to change it.` };
      return { pending: { kind: 'create_file', path, content, diff: makeDiff(path, undefined, content) } };
    }
    case 'run_command': {
      const command = (str('command') ?? '').trim();
      if (!command) return { error: 'Error: command is empty.' };
      return { pending: { kind: 'run_command', command } };
    }
    default:
      return { error: `Error: there is no tool "${call.function.name}".` };
  }
}

/** Something the checkpoint must remember before a file changes. */
export interface BeforeWrite {
  path: string;
  /** The file's text before the task touched it; undefined if the task creates it. */
  before: string | undefined;
}

/**
 * Carries out an approved write. An edit is checked again against the file as it is
 * now, so a change made since the card was shown can't be overwritten blindly.
 * `remember` is called before a file changes, for undo.
 */
export async function applyWrite(
  ws: WritableWorkspace,
  pending: PendingWrite,
  signal: AbortSignal,
  remember: (entry: BeforeWrite) => void,
): Promise<string> {
  switch (pending.kind) {
    case 'edit_file': {
      const text = await ws.readFile(pending.path);
      const found = replaceOnce(text, pending.oldText, pending.newText, pending.path);
      if ('error' in found) return found.error;
      remember({ path: pending.path, before: text });
      await ws.writeFile(pending.path, found.text);
      return `Edited ${pending.path}.`;
    }
    case 'create_file': {
      if (await ws.exists(pending.path)) return `Error: ${pending.path} already exists.`;
      remember({ path: pending.path, before: undefined });
      await ws.writeFile(pending.path, pending.content);
      return `Created ${pending.path}.`;
    }
    case 'run_command': {
      const result = await ws.runCommand(pending.command, signal);
      const status = result.timedOut
        ? `Stopped after ${COMMAND_TIMEOUT_MS / 1000} seconds.`
        : result.exitCode === undefined
          ? 'Stopped.'
          : `Exit code ${result.exitCode}.`;
      return capResult(`${status}\n${result.output.trim() || '(no output)'}`, MAX_COMMAND_OUTPUT_CHARS);
    }
  }
}

/** One line for the chat and the approval card. */
export function describeWrite(pending: PendingWrite): string {
  switch (pending.kind) {
    case 'edit_file':
      return `Edit ${pending.path}`;
    case 'create_file':
      return `Create ${pending.path}`;
    case 'run_command':
      return `Run ${pending.command}`;
  }
}

/**
 * Where the write tools may write: a relative path inside the folder, never outside
 * it, never in .git, never a file that may hold secrets.
 */
export function writePathProblem(path: string): string | undefined {
  if (!path) return 'Error: path is empty.';
  if (/^([a-zA-Z]:)?\//.test(path) || path.startsWith('~')) {
    return `Error: ${path} is not a relative path inside the repository.`;
  }
  const parts = path.split('/');
  if (parts.some((p) => p === '..' || p === '.')) return `Error: ${path} may not use "." or "..".`;
  if (parts.some((p) => p === '')) return `Error: ${path} is not a valid path.`;
  if (parts[0] === '.git') return 'Error: files in .git are never changed.';
  if (isSecretPath(path)) return `Error: ${path} may hold secrets and isn't changed.`;
  return undefined;
}

export function cleanPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
}

function replaceOnce(
  text: string,
  oldText: string,
  newText: string,
  path: string,
): { text: string } | { error: string } {
  const first = text.indexOf(oldText);
  if (first < 0) {
    return { error: `Error: old_text was not found in ${path}. Read the file again and copy the text exactly.` };
  }
  let count = 0;
  for (let i = first; i >= 0; i = text.indexOf(oldText, i + 1)) count++;
  if (count > 1) {
    return { error: `Error: old_text appears ${count} times in ${path}. Include more lines so it is unique.` };
  }
  return { text: text.slice(0, first) + newText + text.slice(first + oldText.length) };
}

/**
 * A unified diff of one change: the lines that differ with up to three lines of
 * context, enough for the approval card. Plain text; the webview shows it as text.
 */
export function makeDiff(path: string, before: string | undefined, after: string): string {
  const a = before === undefined ? [] : before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ctx = 3;
  const from = Math.max(0, start - ctx);
  const toA = Math.min(a.length, endA + ctx);
  const toB = Math.min(b.length, endB + ctx);
  const lines = [
    `--- ${before === undefined ? '/dev/null' : `a/${path}`}`,
    `+++ b/${path}`,
    `@@ -${a.length ? from + 1 : 0},${toA - from} +${from + 1},${toB - from} @@`,
    ...a.slice(from, start).map((l) => ` ${l}`),
    ...a.slice(start, endA).map((l) => `-${l}`),
    ...b.slice(start, endB).map((l) => `+${l}`),
    ...a.slice(endA, toA).map((l) => ` ${l}`),
  ];
  const diff = lines.join('\n');
  return diff.length > MAX_DIFF_CHARS
    ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (${diff.length - MAX_DIFF_CHARS} more characters)`
    : diff;
}
