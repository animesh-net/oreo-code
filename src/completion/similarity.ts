/** Words too common in code to say two pieces of it are related. */
const STOP_WORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'new',
  'this',
  'true',
  'false',
  'null',
  'undefined',
  'import',
  'export',
  'from',
  'class',
  'public',
  'private',
  'protected',
  'static',
  'async',
  'await',
  'void',
  'string',
  'number',
  'int',
  'bool',
  'var',
  'def',
  'self',
  'none',
  'using',
  'namespace',
  'the',
  'and',
  'not',
  'in',
  'is',
  'of',
  'to',
  'type',
  'interface',
  'readonly',
  'override',
  'get',
  'set',
]);

/** The identifiers in a piece of code, lower-cased, without keywords and one-letter names. */
export function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const word = m[0].toLowerCase();
    if (word.length > 1 && !STOP_WORDS.has(word)) out.add(word);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface Window {
  startLine: number;
  text: string;
  score: number;
}

/**
 * The windows of `text` (so many lines, overlapping by half) most like the query,
 * best first, scored by Jaccard similarity of their identifiers.
 */
export function bestWindows(query: Set<string>, text: string, take: number, windowLines = 20): Window[] {
  const lines = text.split('\n');
  const step = Math.max(1, Math.floor(windowLines / 2));
  const windows: Window[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const body = lines.slice(start, start + windowLines).join('\n');
    const score = jaccard(query, identifiers(body));
    if (score > 0) windows.push({ startLine: start, text: body, score });
    if (start + windowLines >= lines.length) break;
  }
  windows.sort((a, b) => b.score - a.score);
  // Overlapping windows say the same thing twice; keep the better one.
  const kept: Window[] = [];
  for (const w of windows) {
    if (kept.length >= take) break;
    if (kept.some((k) => Math.abs(k.startLine - w.startLine) < windowLines)) continue;
    kept.push(w);
  }
  return kept;
}
