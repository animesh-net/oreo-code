/**
 * Where a failure happened in the repository's own code, from a check's or a run's
 * output: Node prints `file:///…/server/index.js:31` above a SyntaxError, a stack
 * trace has `at serve (/…/server/index.js:12:5)`, Python `File "app/calc.py", line 4`.
 * Small models miss that line among the runtime's frames, so the failing lines are
 * shown to them numbered, with the failing one marked.
 */

/** Lines shown around the failing one, on each side. */
const AROUND = 4;

const SITES = [
  // Node and most stack traces: path:line or path:line:column, maybe as a file:// URL.
  /(?:file:\/\/)?((?:[A-Za-z]:)?[^\s()'"`:]+\.[A-Za-z0-9]+):(\d+)(?::\d+)?/g,
  // Python tracebacks.
  /File "([^"]+)", line (\d+)/g,
];

/** The first place in `output` that is a line of a file in `files`, or undefined. */
export function failureSite(output: string, files: readonly string[]): { path: string; line: number } | undefined {
  const found: { at: number; path: string; line: number }[] = [];
  for (const pattern of SITES) {
    for (const m of output.matchAll(pattern)) {
      const path = repoPath(m[1], files);
      const line = Number(m[2]);
      if (path && line > 0) found.push({ at: m.index ?? 0, path, line });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return found[0] && { path: found[0].path, line: found[0].line };
}

/** The repository file a printed path names: itself, or the longest file it ends with. */
function repoPath(printed: string, files: readonly string[]): string | undefined {
  const p = printed.replace(/\\/g, '/');
  if (p.includes('node_modules/') || p.startsWith('node:')) return undefined;
  if (files.includes(p)) return p;
  return files.filter((f) => p.endsWith(`/${f}`)).sort((a, b) => b.length - a.length)[0];
}

/** The numbered lines around `line` of `text`, the failing one marked with ">". */
export function linesAround(path: string, text: string, line: number): string {
  const lines = text.split('\n');
  const from = Math.max(1, line - AROUND);
  const to = Math.min(lines.length, line + AROUND);
  const shown = [];
  for (let n = from; n <= to; n++) shown.push(`${n === line ? '>' : ' '} ${n}: ${lines[n - 1]}`);
  return `It fails at line ${line} of ${path}:\n${shown.join('\n')}`;
}
