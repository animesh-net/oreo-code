import { languageOf } from './imports';

export type SymbolKind = 'class' | 'interface' | 'type' | 'enum' | 'function' | 'method';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  path: string;
  /** Line of the definition, from 0. */
  line: number;
}

const NOT_METHODS = new Set([
  'if',
  'for',
  'foreach',
  'while',
  'switch',
  'catch',
  'using',
  'lock',
  'return',
  'function',
  'constructor',
  'super',
  'typeof',
  'nameof',
  'sizeof',
  'await',
  'new',
  'else',
  'do',
  'try',
  'base',
  'this',
  'fixed',
  'when',
]);

interface Pattern {
  re: RegExp;
  kind: SymbolKind | ((m: RegExpExecArray) => SymbolKind);
  /** Capture group with the name. */
  name: number;
}

const KIND_WORDS: Record<string, SymbolKind> = {
  class: 'class',
  record: 'class',
  struct: 'class',
  interface: 'interface',
  enum: 'enum',
  type: 'type',
};

const PATTERNS: Record<'js' | 'csharp' | 'python', Pattern[]> = {
  js: [
    {
      re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/,
      kind: (m) => KIND_WORDS[m[1]],
      name: 2,
    },
    {
      re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
      kind: 'function',
      name: 1,
    },
    {
      re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
      kind: 'function',
      name: 1,
    },
    {
      re: /^\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/,
      kind: 'method',
      name: 1,
    },
  ],
  csharp: [
    {
      re: /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|internal|private|protected|static|sealed|abstract|partial|readonly|ref|file|unsafe|new)\s+)*(class|interface|struct|enum|record)(?:\s+(?:class|struct))?\s+([A-Za-z_]\w*)/,
      kind: (m) => KIND_WORDS[m[1]],
      name: 2,
    },
    {
      re: /^\s*(?:(?:public|internal|private|protected|static|virtual|override|async|sealed|abstract|extern|unsafe|new|partial)\s+)+(?:[\w<>[\],.?]+\s+)+?([A-Za-z_]\w*)\s*(?:<[^>()]*>)?\s*\(/,
      kind: 'method',
      name: 1,
    },
  ],
  python: [
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', name: 1 },
    { re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: (m) => (m[1] ? 'method' : 'function'), name: 2 },
  ],
};

/** The definitions in one file, found line by line with a few regular expressions per language. */
export function extractSymbols(path: string, text: string): CodeSymbol[] {
  const lang = languageOf(path);
  if (!lang) return [];
  const out: CodeSymbol[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const p of PATTERNS[lang]) {
      const m = p.re.exec(line);
      if (!m) continue;
      const name = m[p.name];
      if (!name || NOT_METHODS.has(name)) continue;
      out.push({ name, kind: typeof p.kind === 'function' ? p.kind(m) : p.kind, path, line: i });
      break;
    }
  }
  return out;
}

export const INDEX_LIMITS = {
  maxFiles: 3000,
  maxSymbols: 50_000,
  /** Bigger files are usually generated or minified. */
  maxFileChars: 200_000,
} as const;

/**
 * Definitions across the workspace, by name, kept in memory. Files are added and
 * replaced one at a time, so a save, create or delete updates only that file.
 */
export class SymbolIndex {
  private readonly byFile = new Map<string, CodeSymbol[]>();
  private readonly byName = new Map<string, CodeSymbol[]>();
  private count = 0;

  get fileCount(): number {
    return this.byFile.size;
  }

  get symbolCount(): number {
    return this.count;
  }

  /** Indexes a file, replacing what it had. Returns false when the index is full or the file too big. */
  update(path: string, text: string): boolean {
    this.remove(path);
    if (text.length > INDEX_LIMITS.maxFileChars || this.byFile.size >= INDEX_LIMITS.maxFiles) return false;
    const symbols = extractSymbols(path, text).slice(0, INDEX_LIMITS.maxSymbols - this.count);
    if (!symbols.length) return true;
    this.byFile.set(path, symbols);
    this.count += symbols.length;
    for (const s of symbols) {
      const list = this.byName.get(s.name);
      if (list) list.push(s);
      else this.byName.set(s.name, [s]);
    }
    return true;
  }

  remove(path: string): void {
    const old = this.byFile.get(path);
    if (!old) return;
    this.byFile.delete(path);
    this.count -= old.length;
    for (const s of old) {
      const list = this.byName.get(s.name)?.filter((x) => x.path !== path);
      if (list?.length) this.byName.set(s.name, list);
      else this.byName.delete(s.name);
    }
  }

  lookup(name: string): readonly CodeSymbol[] {
    return this.byName.get(name) ?? [];
  }

  symbolsIn(path: string): readonly CodeSymbol[] {
    return this.byFile.get(path) ?? [];
  }

  clear(): void {
    this.byFile.clear();
    this.byName.clear();
    this.count = 0;
  }
}
