import { Parser, type Options } from 'acorn';
import jsx from 'acorn-jsx';

/**
 * A syntax check the extension does itself, right after each edit: VS Code's own errors
 * can take longer to arrive than the agent waits for (on a busy 8 GB Mac they often do),
 * and then a broken file reads as "no errors". JavaScript (with JSX), the inline scripts
 * of an HTML page, and JSON are parsed here; other files are left to VS Code.
 */

/** Where a file stops parsing; line counts from 1. */
export interface SyntaxProblem {
  line: number;
  message: string;
}

const JS = /\.(js|mjs|cjs|jsx)$/i;
const HTML = /\.html?$/i;
const JSON_FILE = /\.json$/i;
/** JSON files that allow comments, which JSON.parse doesn't. */
const JSONC = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*|\.eslintrc|\.babelrc)\.json$|(^|\/)\.vscode\//i;

const JsxParser = Parser.extend(jsx());
const BASE: Options = {
  ecmaVersion: 'latest',
  allowHashBang: true,
  allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
};

/** Whether this check knows the file's kind. */
export function checksSyntax(path: string): boolean {
  return JS.test(path) || HTML.test(path) || (JSON_FILE.test(path) && !JSONC.test(path));
}

/** Syntax the parser doesn't know: Flow types, decorators. Such files are left to VS Code. */
const OTHER_DIALECT = /@flow\b|^\s*@[A-Za-z_$][\w$.]*(\(|\s*$)/m;

/** The first syntax error in `text`, or undefined if it parses (or isn't a kind this checks). */
export function syntaxProblem(path: string, text: string): SyntaxProblem | undefined {
  if (JS.test(path)) return OTHER_DIALECT.test(text) ? undefined : jsProblem(text, 0);
  if (HTML.test(path)) return htmlProblem(text);
  if (JSON_FILE.test(path) && !JSONC.test(path)) return jsonProblem(text);
  return undefined;
}

/** As a module first, then as a script (CommonJS can return at the top); the error that gets further wins. */
function jsProblem(text: string, lineOffset: number): SyntaxProblem | undefined {
  const asModule = parseError(text, { ...BASE, sourceType: 'module' });
  if (!asModule) return undefined;
  const asScript = parseError(text, { ...BASE, sourceType: 'script', allowReturnOutsideFunction: true });
  if (!asScript) return undefined;
  const best = asScript.pos > asModule.pos ? asScript : asModule;
  return { line: best.line + lineOffset, message: best.message };
}

function parseError(text: string, options: Options): { line: number; pos: number; message: string } | undefined {
  try {
    JsxParser.parse(text, options);
    return undefined;
  } catch (err) {
    const e = err as { loc?: { line: number }; pos?: number; message?: string };
    if (!e.loc) return { line: 1, pos: 0, message: String(e.message ?? err) };
    // acorn ends its message with "(line:column)"; the line is reported separately.
    return { line: e.loc.line, pos: e.pos ?? 0, message: (e.message ?? '').replace(/\s*\(\d+:\d+\)$/, '') };
  }
}

/** Each inline classic or module script of the page, at its own lines. */
function htmlProblem(text: string): SyntaxProblem | undefined {
  const script = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of text.matchAll(script)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !/^(module|text\/javascript|application\/javascript)$/.test(type)) continue;
    const start = (m.index ?? 0) + m[0].indexOf('>') + 1;
    const lineOffset = text.slice(0, start).split('\n').length - 1;
    const problem = jsProblem(m[2], lineOffset);
    if (problem) return problem;
  }
  return undefined;
}

function jsonProblem(text: string): SyntaxProblem | undefined {
  if (!text.trim()) return undefined;
  try {
    JSON.parse(text);
    return undefined;
  } catch (err) {
    const message = (err as Error).message;
    const at = /position (\d+)/.exec(message);
    const line = at ? text.slice(0, Number(at[1])).split('\n').length : 1;
    return { line, message: message.replace(/\s*\(line \d+ column \d+\)$/, '') };
  }
}
