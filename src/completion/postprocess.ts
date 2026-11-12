/** Qwen2.5-Coder's special tokens: generation stops at any of them (a file boundary or the end). */
export const STOP_TOKENS = [
  '<|endoftext|>',
  '<|file_sep|>',
  '<|fim_prefix|>',
  '<|fim_suffix|>',
  '<|fim_middle|>',
  '<|fim_pad|>',
  '<|repo_name|>',
  '<|im_end|>',
] as const;

const MAX_LINES = 12;

export interface TrimContext {
  /** The current line up to the cursor. */
  linePrefix: string;
  /** The rest of the current line after the cursor. */
  lineSuffix: string;
  /** Everything after the cursor, including lineSuffix. */
  suffix: string;
}

/** Whether the cursor sits in the middle of a line, where only that line is completed. */
export function isMidLine(lineSuffix: string): boolean {
  return lineSuffix.trim().length > 0;
}

/**
 * Turns the model's raw output into ghost text: cut at special tokens, one line when the
 * cursor is mid-line, otherwise a short block ending at a blank line or where the code
 * leaves the current block. Text the editor already has after the cursor is not repeated.
 * Returns undefined when nothing useful is left.
 */
export function trimCompletion(raw: string, ctx: TrimContext): string | undefined {
  let text = raw;
  for (const token of STOP_TOKENS) {
    const i = text.indexOf(token);
    if (i >= 0) text = text.slice(0, i);
  }

  if (isMidLine(ctx.lineSuffix)) {
    text = text.split('\n')[0];
    const rest = ctx.lineSuffix.trimEnd();
    if (rest && text.endsWith(rest)) text = text.slice(0, text.length - rest.length);
    text = text.trimEnd();
    return text.trim() ? text : undefined;
  }

  const baseIndent = indentOf(ctx.linePrefix.trim() ? ctx.linePrefix : ctx.linePrefix + 'x');
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length && kept.length < MAX_LINES; i++) {
    const line = lines[i];
    if (i > 0 && !line.trim()) break;
    if (i > 0 && indentOf(line) < baseIndent) {
      // A closing bracket for the block being written ends it; anything else outside is dropped.
      if (/^\s*[)\]}]+[;,]?\s*$/.test(line)) kept.push(line);
      break;
    }
    kept.push(line);
  }

  // Don't repeat the next line the editor already has.
  const nextLine = ctx.suffix
    .split('\n')
    .find((l) => l.trim())
    ?.trim();
  while (kept.length > 1 && nextLine && kept[kept.length - 1].trim() === nextLine) kept.pop();

  const result = kept.join('\n').trimEnd();
  return result.trim() ? result : undefined;
}

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}
