import { isSecretPath } from '../agent/workspaceTools';
import { BUDGET, tokensToChars } from './budget';
import type { GitIgnore } from './gitignore';
import { resolveImports } from './imports';
import type { Snippet } from './prompt';
import { bestWindows, identifiers } from './similarity';
import type { SymbolIndex } from './symbols';

/** What the gatherer may read: only listed, non-secret, non-ignored files. */
export interface ContextSources {
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** Open tabs and recently edited files, most recent first. */
  recentFiles(): string[];
  gitignore(): GitIgnore | undefined;
  symbols?: SymbolIndex;
}

export interface CursorContext {
  path: string;
  prefix: string;
  suffix: string;
}

export const GATHER_LIMITS = {
  importedFiles: 8,
  recentFiles: 10,
  definitions: 6,
  windowsPerFile: 2,
  windowLines: 20,
  /** Lines of a definition shown, from its first line. */
  definitionLines: 30,
  /** Lines around the cursor that say what the code is about. */
  queryLinesBefore: 20,
  queryLinesAfter: 5,
  /** A window this unlike the cursor's code isn't worth its tokens. */
  minSimilarity: 0.08,
} as const;

/** Whether completion may read a file at all. */
export function mayRead(path: string, listed: Set<string>, ignore: GitIgnore | undefined): boolean {
  return listed.has(path) && !isSecretPath(path) && !ignore?.ignores(path);
}

/**
 * Snippets from other files that are likely to help complete the code at the cursor,
 * scored so that imports and definitions of nearby names beat merely similar code.
 * Never reads the current file (it is the prompt itself), secret files, files git
 * ignores or anything outside the workspace listing.
 */
export async function gatherSnippets(
  cursor: CursorContext,
  sources: ContextSources,
  signal?: AbortSignal,
): Promise<Snippet[]> {
  const files = await sources.listFiles();
  const listed = new Set(files);
  const ignore = sources.gitignore();
  const allowed = (p: string) => p !== cursor.path && mayRead(p, listed, ignore);

  const before = cursor.prefix.split('\n').slice(-GATHER_LIMITS.queryLinesBefore).join('\n');
  const after = cursor.suffix.split('\n').slice(0, GATHER_LIMITS.queryLinesAfter).join('\n');
  const query = identifiers(`${before}\n${after}`);

  const texts = new Map<string, string | undefined>();
  const read = async (p: string) => {
    if (!texts.has(p)) {
      if (signal?.aborted) return undefined;
      try {
        texts.set(p, await sources.readFile(p));
      } catch {
        texts.set(p, undefined);
      }
    }
    return texts.get(p);
  };

  const snippets: Snippet[] = [];
  const whole = `${cursor.prefix}${cursor.suffix}`;

  // 1. Files the current file imports: their parts most like the code at the cursor.
  const imported = resolveImports(cursor.path, whole, files).filter(allowed).slice(0, GATHER_LIMITS.importedFiles);
  for (const p of imported) {
    const text = await read(p);
    if (!text) continue;
    const windows = bestWindows(query, text, GATHER_LIMITS.windowsPerFile, GATHER_LIMITS.windowLines);
    if (!windows.length) {
      // Nothing shared yet: the top of the file still shows what it exports.
      const top = text.split('\n').slice(0, GATHER_LIMITS.windowLines).join('\n');
      snippets.push({ path: p, startLine: 0, text: top, score: 0.4, source: 'import' });
    }
    for (const w of windows)
      snippets.push({ path: p, startLine: w.startLine, text: w.text, score: 0.5 + w.score, source: 'import' });
  }

  // 2. Definitions of names used near the cursor, from the symbol index.
  if (sources.symbols) {
    const nearby = [...new Set(`${before}\n${after}`.match(/[A-Za-z_$][\w$]{2,}/g) ?? [])];
    const local = new Set(sources.symbols.symbolsIn(cursor.path).map((s) => s.name));
    let added = 0;
    // Type-like names (capitalised) first: they say most about what can be written.
    nearby.sort((a, b) => Number(/^[A-Z]/.test(b)) - Number(/^[A-Z]/.test(a)));
    for (const name of nearby) {
      if (added >= GATHER_LIMITS.definitions) break;
      if (local.has(name)) continue;
      const def = sources.symbols.lookup(name).find((s) => allowed(s.path));
      if (!def) continue;
      const text = await read(def.path);
      if (!text) continue;
      const lines = text.split('\n');
      const start = Math.max(0, def.line - 1);
      const body = lines.slice(start, start + GATHER_LIMITS.definitionLines).join('\n');
      const typeLike = def.kind === 'class' || def.kind === 'interface' || def.kind === 'type' || def.kind === 'enum';
      snippets.push({ path: def.path, startLine: start, text: body, score: typeLike ? 0.7 : 0.6, source: 'symbol' });
      added++;
    }
  }

  // 3. Open and recently edited files: their parts most like the code at the cursor.
  const recent = sources.recentFiles().filter(allowed).slice(0, GATHER_LIMITS.recentFiles);
  for (const p of recent) {
    const text = await read(p);
    if (!text) continue;
    for (const w of bestWindows(query, text, GATHER_LIMITS.windowsPerFile, GATHER_LIMITS.windowLines)) {
      if (w.score < GATHER_LIMITS.minSimilarity) continue;
      snippets.push({ path: p, startLine: w.startLine, text: w.text, score: w.score, source: 'similar' });
    }
  }

  return dedupe(snippets).map((s) => ({ ...s, text: s.text.slice(0, tokensToChars(BUDGET.snippetMaxTokens)) }));
}

/** Overlapping pieces of the same file: the better-scored one stays. */
export function dedupe(snippets: Snippet[]): Snippet[] {
  const sorted = [...snippets].sort((a, b) => b.score - a.score);
  const kept: Snippet[] = [];
  for (const s of sorted) {
    const end = s.startLine + s.text.split('\n').length;
    const overlaps = kept.some((k) => {
      if (k.path !== s.path) return false;
      const kEnd = k.startLine + k.text.split('\n').length;
      return s.startLine < kEnd && k.startLine < end;
    });
    if (!overlaps) kept.push(s);
  }
  return kept;
}
