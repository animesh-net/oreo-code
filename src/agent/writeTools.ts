import type { FunctionTool, ToolCall } from '../ollama/client';
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
  /** Files open with unsaved changes, which a command can't see. */
  unsavedFiles?(): string[];
  /** Why the path can't be written (a symbolic link, or outside the folder), or undefined. */
  writeProblem?(path: string): Promise<string | undefined>;
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
/**
 * The largest file an edit or new file may leave. The approval card shows the whole
 * change, never a cut one, so what you approve is exactly what is written.
 */
export const MAX_WRITE_CHARS = 200_000;

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
      const blocked = await ws.writeProblem?.(path);
      if (blocked) return { error: `Error: ${blocked}` };
      let text: string;
      try {
        text = await ws.readFile(path);
      } catch (err) {
        return { error: `Error: ${(err as Error).message}` };
      }
      const found = replaceOnce(text, oldText, newText, path);
      if ('error' in found) return found;
      if (found.text.length > MAX_WRITE_CHARS) return { error: tooLarge(path) };
      return { pending: { kind: 'edit_file', path, oldText, newText, diff: makeDiff(path, text, found.text) } };
    }
    case 'create_file': {
      const path = cleanPath(str('path') ?? '');
      const problem = writePathProblem(path);
      if (problem) return { error: problem };
      const content = str('content') ?? '';
      if (content.length > MAX_WRITE_CHARS) return { error: tooLarge(path) };
      if (await ws.exists(path)) return { error: `Error: ${path} already exists. Use edit_file to change it.` };
      const blocked = await ws.writeProblem?.(path);
      if (blocked) return { error: `Error: ${blocked}` };
      return { pending: { kind: 'create_file', path, content, diff: makeDiff(path, undefined, content) } };
    }
    case 'run_command': {
      const command = (str('command') ?? '').trim();
      if (!command) return { error: 'Error: command is empty.' };
      if (HIDDEN_CHARS.test(command)) {
        return { error: 'Error: the command has hidden or control characters. Send it as plain text.' };
      }
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
  /** The text the task is about to leave in it. */
  after: string;
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
      remember({ path: pending.path, before: text, after: found.text });
      await ws.writeFile(pending.path, found.text);
      remember({ path: pending.path, before: text, after: await settled(ws, pending.path, found.text) });
      return `Edited ${pending.path}.`;
    }
    case 'create_file': {
      if (await ws.exists(pending.path)) return `Error: ${pending.path} already exists.`;
      remember({ path: pending.path, before: undefined, after: pending.content });
      await ws.writeFile(pending.path, pending.content);
      remember({ path: pending.path, before: undefined, after: await settled(ws, pending.path, pending.content) });
      return `Created ${pending.path}.`;
    }
    case 'run_command': {
      const result = await ws.runCommand(pending.command, signal);
      const status = result.timedOut
        ? `Stopped after ${COMMAND_TIMEOUT_MS / 1000} seconds.`
        : result.exitCode === undefined
          ? 'Stopped.'
          : `Exit code ${result.exitCode}.`;
      const unsaved = ws.unsavedFiles?.() ?? [];
      const note = unsaved.length
        ? `\nNote: ${unsaved.join(', ')} ${unsaved.length === 1 ? 'has' : 'have'} unsaved changes in the editor, which this command didn't see.`
        : '';
      return `${status}\n${keepEnds(result.output.trim(), MAX_COMMAND_OUTPUT_CHARS) || '(no output)'}${note}`;
    }
  }
}

/**
 * Cuts long output to its first and last parts: a build or test run reports its
 * failures at the end, so cutting only the end would hide them.
 */
export function keepEnds(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 4);
  const tail = max - head;
  return `${text.slice(0, head)}\n… (${text.length - max} characters cut) …\n${text.slice(-tail)}`;
}

/**
 * The file's text right after a write. Saving an open editor can run format on save,
 * so undo compares against what is really there, not what was sent.
 */
async function settled(ws: WritableWorkspace, path: string, sent: string): Promise<string> {
  try {
    return await ws.readFile(path);
  } catch {
    return sent;
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
  // macOS paths ignore case, so ".GIT/config" is ".git/config"; a nested repository's .git counts too.
  if (parts.some((p) => p.toLowerCase() === '.git')) return 'Error: files in .git are never changed.';
  if (isSecretPath(path)) return `Error: ${path} may hold secrets and isn't changed.`;
  return undefined;
}

function tooLarge(path: string): string {
  return `Error: ${path} would be over ${MAX_WRITE_CHARS} characters; agent mode only writes smaller files.`;
}

export function cleanPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
}

/**
 * Replaces oldText once. A file with Windows line endings (common in .NET repos) is
 * matched and written with \r\n, since models send plain \n.
 */
function replaceOnce(
  text: string,
  oldText: string,
  newText: string,
  path: string,
): { text: string } | { error: string } {
  if (text.includes('\r\n') && !text.includes(oldText) && !oldText.includes('\r')) {
    const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
    return replaceExactlyOnce(text, crlf(oldText), crlf(newText), path);
  }
  return replaceExactlyOnce(text, oldText, newText, path);
}

function replaceExactlyOnce(
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
  return lines.join('\n');
}

/**
 * Characters that can make a command look different from what runs: control
 * characters (other than tab and newline) and Unicode bidirectional overrides.
 */
const HIDDEN_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
