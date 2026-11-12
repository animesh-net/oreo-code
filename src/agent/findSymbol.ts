import type { CodeSymbol } from '../completion/symbols';
import type { FunctionTool, ToolCall } from '../ollama/client';
import { isSecretPath, type ToolResult } from './workspaceTools';

const MAX_HITS = 20;

/**
 * Looks up where a class, interface, type, enum, function or method is defined, from
 * the same symbol index inline completion uses (src/completion/symbols.ts). Read-only.
 */
export const FIND_SYMBOL_TOOL: FunctionTool = {
  type: 'function',
  function: {
    name: 'find_symbol',
    description:
      'Find where a class, interface, type, enum, function or method is defined in the open repository, by exact name (e.g. "ChatController"). Returns path:line for each definition; read_file it next. Faster than search for definitions.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The exact name, without parentheses' } },
      required: ['name'],
    },
  },
};

export async function runFindSymbol(
  lookup: (name: string) => Promise<readonly CodeSymbol[]>,
  call: ToolCall,
): Promise<ToolResult> {
  let name = '';
  try {
    const args = JSON.parse(call.function.arguments || '{}') as { name?: unknown };
    if (typeof args.name === 'string') name = args.name.trim().replace(/\(\)$/, '');
  } catch {
    return { summary: 'find_symbol (bad arguments)', content: 'Error: arguments were not valid JSON.' };
  }
  if (!name) return { summary: 'find_symbol (no name)', content: 'Error: name is empty.' };
  const hits = (await lookup(name)).filter((s) => !isSecretPath(s.path));
  const shown = hits.slice(0, MAX_HITS);
  return {
    summary: `Looked up ${name}`,
    content: shown.length
      ? shown.map((s) => `${s.kind} ${s.name} — ${s.path}:${s.line + 1}`).join('\n') +
        (hits.length > shown.length ? `\n… and ${hits.length - shown.length} more.` : '')
      : `No definition of "${name}" found. Try search instead.`,
  };
}
