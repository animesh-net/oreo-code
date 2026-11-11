import type { FunctionTool, ToolCall } from '../ollama/client';

/**
 * The open folder, as the read-only tools see it. Paths are relative to the
 * folder, with forward slashes. The VS Code side lists files without ignored
 * folders (node_modules, .git, build output) and reads unsaved editor text.
 */
export interface Workspace {
  name: string;
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** The checked-out branch, if it's a git repository. */
  branch(): Promise<string | undefined>;
  /** The file in the active editor, if it's in this folder. */
  activeFile(): ActiveFile | undefined;
}

export interface ActiveFile {
  path: string;
  text: string;
  /** The selected text, if any. */
  selection?: string;
}

/** Files never read or searched, even when listed: they may hold secrets. */
const SECRET = [
  /(^|\/)\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /secrets?\.(json|ya?ml)$/i,
];

export const MAX_READ_CHARS = 12_000;
const MAX_LIST = 400;
const MAX_MATCHES = 60;
const MAX_SEARCH_FILE_CHARS = 200_000;

export function isSecretPath(path: string): boolean {
  return SECRET.some((re) => re.test(path));
}

/** Read-only tools offered to a model with supportsTools. Nothing here writes. */
export const WORKSPACE_TOOLS: FunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List files in the open repository (relative paths). Optionally only paths containing the given text, e.g. "src/" or ".test.ts".',
      parameters: {
        type: 'object',
        properties: { contains: { type: 'string', description: 'Only paths that contain this text' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: `Read a file from the open repository, with line numbers. At most ${MAX_READ_CHARS} characters per call; use start_line and end_line for longer files.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path, as list_files shows it' },
          start_line: { type: 'integer', description: 'First line, from 1' },
          end_line: { type: 'integer', description: 'Last line' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: 'Search the text of every file in the open repository (case-insensitive). Returns path:line: text.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Text to find' } },
        required: ['query'],
      },
    },
  },
];

export interface ToolResult {
  /** Shown in the chat, e.g. "Read src/extension.ts". */
  summary: string;
  /** Sent back to the model. */
  content: string;
}

/** Runs one tool call. Errors become a short message for the model, never a throw. */
export async function runWorkspaceTool(ws: Workspace, call: ToolCall): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
  } catch {
    return { summary: `${call.function.name} (bad arguments)`, content: 'Error: arguments were not valid JSON.' };
  }
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  const num = (k: string) => (typeof args[k] === 'number' ? Math.floor(args[k] as number) : undefined);

  switch (call.function.name) {
    case 'list_files': {
      const contains = str('contains');
      const all = (await ws.listFiles()).filter((p) => !contains || p.includes(contains));
      const shown = all.slice(0, MAX_LIST);
      const more =
        all.length > shown.length ? `\n… and ${all.length - shown.length} more; narrow with "contains".` : '';
      return {
        summary: contains ? `Listed files matching "${contains}"` : 'Listed files',
        content: shown.length ? shown.join('\n') + more : 'No files match.',
      };
    }
    case 'read_file': {
      const path = cleanPath(str('path'));
      const known = await knownFile(ws, path);
      if (typeof known === 'string') return { summary: `Couldn't read ${path || 'a file'}`, content: known };
      let text: string;
      try {
        text = await ws.readFile(path);
      } catch (err) {
        return { summary: `Couldn't read ${path}`, content: `Error: ${(err as Error).message}` };
      }
      const lines = text.split('\n');
      const start = Math.max(1, num('start_line') ?? 1);
      const end = Math.min(lines.length, num('end_line') ?? lines.length);
      let out = '';
      let last = start - 1;
      for (let i = start; i <= end; i++) {
        const line = `${i}: ${lines[i - 1]}\n`;
        if (out.length + line.length > MAX_READ_CHARS) break;
        out += line;
        last = i;
      }
      const rest = last < lines.length ? `… ${lines.length - last} more lines; read from start_line ${last + 1}.` : '';
      return {
        summary: `Read ${path}${start > 1 || last < lines.length ? ` (lines ${start}–${last})` : ''}`,
        content: `${path} (${lines.length} lines)\n${out}${rest}`,
      };
    }
    case 'search': {
      const query = str('query').trim();
      if (!query) return { summary: 'Search (empty)', content: 'Error: query is empty.' };
      const needle = query.toLowerCase();
      const matches: string[] = [];
      for (const path of await ws.listFiles()) {
        if (isSecretPath(path)) continue;
        const text = await ws.readFile(path).catch(() => '');
        if (!text || text.length > MAX_SEARCH_FILE_CHARS || text.includes('\0')) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
          if (lines[i].toLowerCase().includes(needle))
            matches.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
        if (matches.length >= MAX_MATCHES) break;
      }
      return {
        summary: `Searched for "${query}"`,
        content: matches.length
          ? matches.join('\n') +
            (matches.length >= MAX_MATCHES ? '\n… more matches; search for something narrower.' : '')
          : 'No matches.',
      };
    }
    default:
      return {
        summary: `Unknown tool ${call.function.name}`,
        content: `Error: there is no tool "${call.function.name}".`,
      };
  }
}

function cleanPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Only files in the listing can be read: no absolute paths, "..", or ignored and secret files. */
async function knownFile(ws: Workspace, path: string): Promise<true | string> {
  if (!path) return 'Error: path is empty.';
  if (isSecretPath(path)) return `Error: ${path} may hold secrets and isn't read.`;
  if (!(await ws.listFiles()).includes(path)) return `Error: ${path} isn't in the repository. Use list_files.`;
  return true;
}
