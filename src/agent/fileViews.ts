import type { WireMessage } from '../ollama/client';
import { MAX_READ_CHARS } from './workspaceTools';
import { cleanPath } from './writeTools';

/** Starts the latest copy of a file added to an edit's result. */
export const LATEST_COPY = 'The latest copy of';

/** Tools whose calls and results hold a copy of a file, or line numbers from one. */
const COPY_TOOLS = new Set(['read_file', 'edit_file', 'replace_lines', 'write_file', 'create_file']);

/** Where instructions start in a read_file result (src/agent/loop.ts `withInstructions`). */
const INSTRUCTIONS = '\n\nInstructions for this part of the repository';

/**
 * A whole file numbered like read_file, or undefined if it's too long for one read.
 * The line count includes the empty last line of a file ending in a newline, as read_file does.
 */
export function numberedCopy(path: string, text: string): string | undefined {
  const lines = text.split('\n');
  const body = lines.map((l, i) => `${i + 1}: ${l}\n`).join('');
  return body.length > MAX_READ_CHARS ? undefined : `${path} (${lines.length} lines)\n${body}`;
}

/** The text after an edit's result, giving the model the file as it now is. */
export function latestCopyNote(path: string, text: string): string {
  const copy = numberedCopy(path, text);
  return copy
    ? `\n\n${LATEST_COPY} ${path}, with these line numbers (earlier copies are out of date):\n${copy}`
    : `\n\n${path} is too long to show whole: read it again with read_file before changing other lines, as line numbers may have moved.`;
}

/**
 * Takes earlier copies of `path` out of the conversation once it has changed, so the
 * model works from the latest one: read_file results and copies in edit results are
 * replaced with a note, and whole-file arguments of earlier calls are dropped. Called
 * before the new result is added; `whole` says whether that result has a full copy.
 */
export function retireCopies(wire: WireMessage[], path: string, whole: boolean): void {
  const calls = new Map<string, string>();
  for (const m of wire) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const t of m.tool_calls) {
      if (!COPY_TOOLS.has(t.function.name)) continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(t.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof args.path !== 'string' || cleanPath(args.path) !== path) continue;
      calls.set(t.id, t.function.name);
      if (typeof args.content === 'string' && args.content.length > 0) {
        t.function.arguments = JSON.stringify({ path: args.path, note: 'older copy removed' });
      }
    }
  }
  const note = whole
    ? `(An older copy of ${path}, removed: the file changed since. Its latest copy is further down.)`
    : `(This copy of ${path} may be out of date: the file changed since. Read it again.)`;
  for (const m of wire) {
    if (m.role !== 'tool' || !m.tool_call_id) continue;
    const name = calls.get(m.tool_call_id);
    if (!name) continue;
    if (name === 'read_file') {
      if (m.content.startsWith('(') || m.content.startsWith('Error')) continue;
      const at = m.content.indexOf(INSTRUCTIONS);
      m.content = whole ? note + (at >= 0 ? m.content.slice(at) : '') : `${note}\n${m.content}`;
    } else {
      const at = m.content.indexOf(`\n\n${LATEST_COPY} ${path},`);
      if (at < 0) continue;
      const end = m.content.indexOf(INSTRUCTIONS, at);
      m.content = `${m.content.slice(0, at)}\n\n${note}${end >= 0 ? m.content.slice(end) : ''}`;
    }
  }
}
