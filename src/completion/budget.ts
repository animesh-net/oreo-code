/**
 * Every size limit of a completion request, in one place. The completion model has an
 * 8K-token context (num_ctx 8192 in oreo-ai's Modelfile); tokens are estimated from
 * characters, which is close enough for code and costs nothing.
 */
export const BUDGET = {
  contextTokens: 8192,
  /** Code above the cursor; the end nearest the cursor is kept. */
  prefixTokens: 2000,
  /** Code below the cursor; the start nearest the cursor is kept. */
  suffixTokens: 1000,
  /** Snippets from other files: imports, symbol definitions, open and recent files. */
  snippetTokens: 2500,
  /** Longest single snippet, so one file can't take the whole snippet budget. */
  snippetMaxTokens: 600,
  /** Tokens generated: a single line when the cursor is mid-line, a short block otherwise. */
  outputTokensLine: 48,
  outputTokensBlock: 128,
  charsPerToken: 3.5,
} as const;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / BUDGET.charsPerToken);
}

export function tokensToChars(tokens: number): number {
  return Math.floor(tokens * BUDGET.charsPerToken);
}
