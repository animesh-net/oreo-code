import { BUDGET, estimateTokens, tokensToChars } from './budget';

/** A piece of another file to show the model, with how useful it is likely to be. */
export interface Snippet {
  path: string;
  /** First line of the snippet in its file, from 0. */
  startLine: number;
  text: string;
  score: number;
  /** Why it was picked, for tests and debugging: import, symbol, similar. */
  source: 'import' | 'symbol' | 'similar';
}

export interface PromptInput {
  repoName: string;
  path: string;
  prefix: string;
  suffix: string;
  snippets: Snippet[];
}

/**
 * Qwen2.5-Coder's repository-level fill-in-the-middle prompt, as in its model card:
 *
 *   <|repo_name|>{repo}\n
 *   <|file_sep|>{path}\n{content}\n          (one per context file)
 *   <|file_sep|>{current path}\n
 *   <|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>
 *
 * Snippets are packed best first into the snippet budget, then written least useful
 * first, so the most useful sits right before the current file.
 */
export function buildPrompt(input: PromptInput): string {
  const prefix = keepEnd(input.prefix, tokensToChars(BUDGET.prefixTokens));
  const suffix = keepStart(input.suffix, tokensToChars(BUDGET.suffixTokens));
  const picked = packSnippets(input.snippets, BUDGET.snippetTokens);
  let out = `<|repo_name|>${input.repoName}\n`;
  for (const s of [...picked].reverse()) out += `<|file_sep|>${s.path}\n${s.text}\n`;
  out += `<|file_sep|>${input.path}\n<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
  return out;
}

/** Best snippets first, each capped, until the budget is used. */
export function packSnippets(snippets: Snippet[], budgetTokens: number): Snippet[] {
  const maxChars = tokensToChars(BUDGET.snippetMaxTokens);
  const picked: Snippet[] = [];
  let used = 0;
  for (const s of [...snippets].sort((a, b) => b.score - a.score)) {
    const text = keepStart(s.text, maxChars);
    // The path line and separators count too.
    const cost = estimateTokens(text) + estimateTokens(s.path) + 4;
    if (used + cost > budgetTokens) continue;
    picked.push({ ...s, text });
    used += cost;
  }
  return picked;
}

/** The last `max` characters, starting on a whole line where possible. */
export function keepEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
}

/** The first `max` characters, ending on a whole line where possible. */
export function keepStart(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return nl > 0 ? cut.slice(0, nl) : cut;
}
