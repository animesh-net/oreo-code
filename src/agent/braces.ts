/**
 * Which brace is wrong, worked out for the model: a small model told "Unexpected token
 * at line 31" with `} catch (e) {` marked can't see that the `try` was closed by a stray
 * `}` ten lines earlier. Matching every brace in JavaScript can, so the hint names the
 * brace to remove or add.
 */

/** A `{ … }` pair: where it opens, the keyword it belongs to, where it closes (undefined: never). */
interface Block {
  open: number;
  kind: string;
  head: string;
  close?: number;
}

/** Keywords a block can belong to, in the order they're looked for before its `{`. */
const KINDS = ['try', 'catch', 'finally', 'else', 'if', 'for', 'while', 'switch', 'function', 'class', 'do'] as const;

/**
 * The hint for a syntax error at `line` of JavaScript `text`, or undefined when the
 * braces don't explain it.
 */
export function braceHint(text: string, line: number): string | undefined {
  const scan = scanBraces(text);
  if (!scan) return undefined;
  const { blocks, stray } = scan;
  const at = text.split('\n')[line - 1] ?? '';
  const name = (b: Block) => `\`${b.head}\` from line ${b.open}`;

  // `} catch`, `} finally`, `} else`: the block that brace closes must be the try or if.
  const follow = /\}\s*(catch|finally|else)\b/.exec(at);
  if (follow) {
    const word = follow[1];
    const needs = word === 'else' ? 'if' : 'try';
    const closing = blocks.filter((b) => b.close === line).at(-1);
    if (closing && closing.kind !== needs && !(word === 'finally' && closing.kind === 'catch')) {
      // The latest such block that closed before this line without its own catch or else.
      const completes = needs === 'try' ? /\}\s*(catch|finally)\b/ : /\}\s*else\b/;
      const lost = blocks
        .filter((b) => b.kind === needs && b.close !== undefined && b.close < line)
        .filter((b) => !completes.test(text.split('\n')[(b.close as number) - 1] ?? ''))
        .at(-1);
      return lost
        ? `The \`}\` before \`${word}\` on line ${line} closes ${name(closing)}, not a \`${needs}\` block: the ${name(lost)} was already closed by the \`}\` on line ${lost.close}. Remove that extra \`}\` on line ${lost.close}.`
        : `The \`}\` before \`${word}\` on line ${line} closes ${name(closing)}, and no \`${needs} {\` is open before it. Add the missing \`${needs} {\`, or remove the \`${word}\` block.`;
    }
  }
  // A `try` (or `if`) whose block closes without its catch (or else) following, while a
  // `} catch` (or `} else`) comes later: the brace that closed it is the extra one.
  const opened = blocks.find((b) => b.open === line && (b.kind === 'try' || b.kind === 'if'));
  if (opened?.close !== undefined) {
    const lines = text.split('\n');
    const word = opened.kind === 'try' ? 'catch' : 'else';
    const completes = opened.kind === 'try' ? /\}\s*(catch|finally)\b/ : /\}\s*else\b/;
    if (!completes.test(lines[opened.close - 1] ?? '')) {
      const later = lines.findIndex((l, k) => k >= opened.close! && completes.test(l));
      if (later >= 0) {
        return `The ${name(opened)} is closed by the \`}\` on line ${opened.close}, so the \`${word}\` on line ${later + 1} has nothing to follow. Remove that extra \`}\` on line ${opened.close}.`;
      }
    }
  }
  if (stray.length) {
    return `The \`}\` on line ${stray[0]} has no \`{\` to close. Remove it, or add the \`{\` it was meant to close.`;
  }
  const unclosed = blocks.filter((b) => b.close === undefined);
  if (unclosed.length) {
    const b = unclosed.at(-1) as Block;
    return `The ${name(b)} is never closed. Add its \`}\`${unclosed.length > 1 ? ` (${unclosed.length} blocks are left open)` : ''}.`;
  }
  return undefined;
}

/**
 * Every `{ … }` block and every `}` with nothing to close, skipping strings, template
 * literals (with their `${…}`), comments and regular expressions. Undefined if the
 * text ends inside a string or comment, where braces mean nothing.
 */
export function scanBraces(text: string): { blocks: Block[]; stray: number[] } | undefined {
  const blocks: Block[] = [];
  const stray: number[] = [];
  /** Open braces: an index into `blocks`, or -1 for a template literal's `${`. */
  const open: number[] = [];
  let line = 1;
  let i = 0;
  let lastSignificant = '';
  const n = text.length;
  const inTemplate = (): boolean => {
    // Reads a template literal from just after its backtick; returns false if it never ends.
    while (i < n) {
      const c = text[i];
      if (c === '\n') line++;
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        return true;
      }
      if (c === '$' && text[i + 1] === '{') {
        open.push(-1);
        i += 2;
        return true; // back to code; the matching `}` resumes the template
      }
      i++;
    }
    return false;
  };
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return undefined;
      for (let k = i; k < end; k++) if (text[k] === '\n') line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i++;
      lastSignificant = c;
      continue;
    }
    if (c === '`') {
      i++;
      if (!inTemplate()) return undefined;
      lastSignificant = '`';
      continue;
    }
    if (c === '/' && /^$|[=(,:;!&|?{}[+\-*%<>~^]$/.test(lastSignificant)) {
      // A regular expression literal: skip to its closing slash, minding classes.
      i++;
      let inClass = false;
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\') i++;
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) break;
        i++;
      }
      i++;
      lastSignificant = 'regex';
      continue;
    }
    if (c === '{') {
      blocks.push({ open: line, ...kindBefore(text, i) });
      open.push(blocks.length - 1);
    } else if (c === '}') {
      const top = open.pop();
      if (top === undefined) stray.push(line);
      else if (top === -1) {
        i++;
        if (!inTemplate()) return undefined;
        lastSignificant = '`';
        continue;
      } else blocks[top].close = line;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return { blocks, stray };
}

/** What a `{` at `at` belongs to, from the text before it on its statement. */
function kindBefore(text: string, at: number): { kind: string; head: string } {
  let start = at;
  while (start > 0 && !/[;{}]/.test(text[start - 1])) start--;
  // `} catch (e) {` and `} else {` start right after the `}`.
  const before = text.slice(start, at).replace(/\s+/g, ' ').trim();
  const head = (before ? `${before} {` : '{').slice(-60);
  for (const k of KINDS) {
    if (new RegExp(`(^|[^\\w$.])${k}\\b`).test(before)) return { kind: k, head };
  }
  if (/=>\s*$/.test(before)) return { kind: 'function', head };
  if (/\)\s*$/.test(before) && /^[\w$\s.]*(async\s+)?[\w$]+\s*\(/.test(before)) return { kind: 'function', head };
  return { kind: 'block', head };
}
