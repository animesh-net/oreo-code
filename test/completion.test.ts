import { describe, expect, it, vi } from 'vitest';
import { BUDGET, estimateTokens, tokensToChars } from '../src/completion/budget';
import { LruCache } from '../src/completion/cache';
import { dedupe, gatherSnippets, type ContextSources } from '../src/completion/context';
import {
  CompletionEngine,
  delay,
  generate,
  KEEP_ALIVE,
  skipReason,
  type CompletionRequest,
} from '../src/completion/engine';
import { GitIgnore } from '../src/completion/gitignore';
import { join, languageOf, resolveImports } from '../src/completion/imports';
import { STOP_TOKENS, trimCompletion } from '../src/completion/postprocess';
import { buildPrompt, keepEnd, keepStart, packSnippets, type Snippet } from '../src/completion/prompt';
import { bestWindows, identifiers, jaccard } from '../src/completion/similarity';
import { extractSymbols, INDEX_LIMITS, SymbolIndex } from '../src/completion/symbols';

const snippet = (path: string, text: string, score: number, startLine = 0): Snippet => ({
  path,
  startLine,
  text,
  score,
  source: 'similar',
});

describe('budget', () => {
  it('fits the 8K context with room to answer', () => {
    const used = BUDGET.prefixTokens + BUDGET.suffixTokens + BUDGET.snippetTokens + BUDGET.outputTokensBlock;
    expect(used).toBeLessThan(BUDGET.contextTokens);
    expect(estimateTokens('a'.repeat(35))).toBe(10);
    expect(tokensToChars(10)).toBe(35);
  });
});

describe('buildPrompt', () => {
  it("uses Qwen2.5-Coder's repository-level fill-in-the-middle format, best snippet last", () => {
    const prompt = buildPrompt({
      repoName: 'oreo-code',
      path: 'src/a.ts',
      prefix: 'const x = ',
      suffix: ';\n',
      snippets: [snippet('src/low.ts', 'low()', 0.1), snippet('src/high.ts', 'high()', 0.9)],
    });
    expect(prompt).toBe(
      '<|repo_name|>oreo-code\n' +
        '<|file_sep|>src/low.ts\nlow()\n' +
        '<|file_sep|>src/high.ts\nhigh()\n' +
        '<|file_sep|>src/a.ts\n<|fim_prefix|>const x = <|fim_suffix|>;\n<|fim_middle|>',
    );
  });

  it('keeps the code nearest the cursor when the file is too long', () => {
    const line = 'x'.repeat(99) + '\n';
    const prompt = buildPrompt({
      repoName: 'r',
      path: 'a.ts',
      prefix: 'FIRST\n' + line.repeat(200) + 'NEAR_PREFIX',
      suffix: 'NEAR_SUFFIX\n' + line.repeat(200) + 'LAST',
      snippets: [],
    });
    expect(prompt).toContain('NEAR_PREFIX<|fim_suffix|>NEAR_SUFFIX');
    expect(prompt).not.toContain('FIRST');
    expect(prompt).not.toContain('LAST');
    expect(prompt.length).toBeLessThan(tokensToChars(BUDGET.prefixTokens + BUDGET.suffixTokens) + 100);
  });

  it('packs snippets best first within the budget and caps each one', () => {
    const big = (c: string) => c.repeat(tokensToChars(BUDGET.snippetMaxTokens) * 3);
    const picked = packSnippets(
      [
        snippet('low', big('l'), 0.1),
        snippet('a', big('a'), 0.9),
        snippet('b', big('b'), 0.8),
        snippet('c', big('c'), 0.7),
        snippet('d', big('d'), 0.6),
        snippet('e', big('e'), 0.5),
      ],
      BUDGET.snippetTokens,
    );
    expect(picked.map((s) => s.path)).toEqual(['a', 'b', 'c', 'd']);
    for (const s of picked) expect(s.text.length).toBeLessThanOrEqual(tokensToChars(BUDGET.snippetMaxTokens));
  });

  it('cuts on whole lines', () => {
    expect(keepEnd('one\ntwo\nthree', 9)).toBe('three');
    expect(keepStart('one\ntwo\nthree', 9)).toBe('one\ntwo');
    expect(keepEnd('short', 10)).toBe('short');
  });
});

describe('similarity', () => {
  it('scores shared identifiers and ignores keywords', () => {
    expect([...identifiers('const userName = getUser(id); return x;')].sort()).toEqual(['getuser', 'id', 'username']);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });

  it('finds the window most like the query, without overlapping repeats', () => {
    const text = [...Array(40).keys()]
      .map((i) => (i >= 25 && i < 30 ? 'invoiceTotal taxRate' : `filler${i}`))
      .join('\n');
    const windows = bestWindows(identifiers('invoiceTotal * taxRate'), text, 2, 10);
    expect(windows[0].text).toContain('invoiceTotal');
    expect(windows[0].startLine).toBeGreaterThanOrEqual(20);
    expect(windows).toHaveLength(1);
  });
});

describe('resolveImports', () => {
  const files = [
    'src/chat/controller.ts',
    'src/ollama/models.ts',
    'src/ollama/index.ts',
    'src/util.js',
    'app/services/billing.py',
    'app/services/__init__.py',
    'app/models.py',
    'src/OreoAi.Web/Chat/ChatService.cs',
    'src/OreoAi.Web/Models/OreoModels.cs',
    'src/OreoAi.Web/Program.cs',
  ];

  it('resolves relative TypeScript and JavaScript imports', () => {
    const text = `import { a } from '../ollama/models';\nimport x from '../ollama';\nconst u = require('../util.js');\nimport 'react';`;
    expect(resolveImports('src/chat/controller.ts', text, files)).toEqual([
      'src/ollama/models.ts',
      'src/ollama/index.ts',
      'src/util.js',
    ]);
  });

  it('resolves Python relative and absolute imports', () => {
    const text = 'from . import billing\nfrom ..models import Invoice\nimport app.models\n';
    expect(resolveImports('app/services/tax.py', text, files)).toEqual(['app/services/billing.py', 'app/models.py']);
  });

  it('matches C# usings to the folders that hold the namespace', () => {
    const text = 'using System;\nusing OreoAi.Web.Models;\n';
    expect(resolveImports('src/OreoAi.Web/Chat/ChatService.cs', text, files)).toEqual([
      'src/OreoAi.Web/Models/OreoModels.cs',
    ]);
  });

  it('joins paths and knows the languages', () => {
    expect(join('src/a', '../b/./c')).toBe('src/b/c');
    expect(languageOf('x.tsx')).toBe('js');
    expect(languageOf('x.cs')).toBe('csharp');
    expect(languageOf('x.py')).toBe('python');
    expect(languageOf('x.md')).toBeUndefined();
  });
});

describe('GitIgnore', () => {
  const ignore = new GitIgnore('# comment\n*.log\n/dist\nbuild/\nsecret/**\n!keep.log\n');

  it('ignores what the patterns say and un-ignores negations', () => {
    expect(ignore.ignores('a/b.log')).toBe(true);
    expect(ignore.ignores('keep.log')).toBe(false);
    expect(ignore.ignores('dist/x.js')).toBe(true);
    expect(ignore.ignores('src/dist/x.js')).toBe(false);
    expect(ignore.ignores('pkg/build/x.js')).toBe(true);
    expect(ignore.ignores('build')).toBe(false);
    expect(ignore.ignores('secret/a/b.ts')).toBe(true);
    expect(ignore.ignores('src/a.ts')).toBe(false);
  });
});

describe('symbols', () => {
  it('finds TypeScript definitions', () => {
    const ts = [
      'export class ChatController {',
      '  async send(text: string): Promise<void> {',
      '    if (x) {',
      '  }',
      'export interface Model {}',
      'export type Effort = "low";',
      'export enum Kind { A }',
      'export async function buildPrompt(input: In) {',
      'export const toKey = (a: string) => a;',
    ].join('\n');
    expect(extractSymbols('a.ts', ts).map((s) => [s.name, s.kind, s.line])).toEqual([
      ['ChatController', 'class', 0],
      ['send', 'method', 1],
      ['Model', 'interface', 4],
      ['Effort', 'type', 5],
      ['Kind', 'enum', 6],
      ['buildPrompt', 'function', 7],
      ['toKey', 'function', 8],
    ]);
  });

  it('finds C# and Python definitions', () => {
    const cs = [
      'public sealed partial class ChatService',
      'internal record ModelOption(string Id);',
      'public interface IStore {',
      '    public async Task<string> SendAsync(string text)',
      '    return Foo(x);',
    ].join('\n');
    expect(extractSymbols('a.cs', cs).map((s) => [s.name, s.kind])).toEqual([
      ['ChatService', 'class'],
      ['ModelOption', 'class'],
      ['IStore', 'interface'],
      ['SendAsync', 'method'],
    ]);
    const py = 'class Invoice:\n    def total(self):\n        pass\nasync def fetch():\n';
    expect(extractSymbols('a.py', py).map((s) => [s.name, s.kind])).toEqual([
      ['Invoice', 'class'],
      ['total', 'method'],
      ['fetch', 'function'],
    ]);
    expect(extractSymbols('a.md', '# class Nope')).toEqual([]);
  });

  it('updates, replaces and removes one file at a time', () => {
    const index = new SymbolIndex();
    index.update('a.ts', 'export class Alpha {}\nexport function beta() {}');
    index.update('b.ts', 'export class Alpha {}');
    expect(index.lookup('Alpha').map((s) => s.path)).toEqual(['a.ts', 'b.ts']);
    expect(index.symbolCount).toBe(3);
    index.update('a.ts', 'export class Gamma {}');
    expect(index.lookup('beta')).toEqual([]);
    expect(index.lookup('Alpha').map((s) => s.path)).toEqual(['b.ts']);
    index.remove('b.ts');
    expect(index.lookup('Alpha')).toEqual([]);
    expect(index.fileCount).toBe(1);
    expect(index.symbolCount).toBe(1);
    expect(index.update('big.ts', 'x'.repeat(INDEX_LIMITS.maxFileChars + 1))).toBe(false);
  });
});

describe('LruCache', () => {
  it('drops the least recently used entry', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(2);
  });
});

describe('trimCompletion', () => {
  it('stops at special tokens', () => {
    for (const token of STOP_TOKENS) {
      expect(trimCompletion(`foo()${token}junk`, { linePrefix: 'x = ', lineSuffix: '', suffix: '' })).toBe('foo()');
    }
  });

  it('completes one line mid-line without repeating what follows the cursor', () => {
    const ctx = { linePrefix: 'call(', lineSuffix: ');', suffix: ');\nnext();' };
    expect(trimCompletion('a, b);\nmore();', ctx)).toBe('a, b');
    expect(trimCompletion('   ', ctx)).toBeUndefined();
  });

  it('ends a block at a blank line or where it leaves the block, keeping its closing bracket', () => {
    const ctx = { linePrefix: '    ', lineSuffix: '', suffix: '\n' };
    expect(trimCompletion('a();\n    b();\n\n    c();', ctx)).toBe('a();\n    b();');
    expect(trimCompletion('a();\n  }\n  other();', ctx)).toBe('a();\n  }');
    expect(trimCompletion('a();\nfunction next() {', ctx)).toBe('a();');
  });

  it("doesn't repeat the next line already in the file", () => {
    const ctx = { linePrefix: '  ', lineSuffix: '', suffix: '\n  return total;\n}' };
    expect(trimCompletion('total += x;\n  return total;', ctx)).toBe('total += x;');
  });
});

describe('gatherSnippets', () => {
  const fileText: Record<string, string> = {
    'src/a.ts': "import { Invoice } from './invoice';\n",
    'src/invoice.ts': 'export class Invoice {\n  total(): number { return 1; }\n}\n',
    'src/tax.ts': 'export function taxRate(invoice: Invoice) {\n  return invoiceTotal * 0.2;\n}\n',
    'src/open.ts': 'const invoiceTotal = sum(lines);\nconst taxed = invoiceTotal * taxRate;\n',
    '.env': 'SECRET=1\nconst invoiceTotal = 1;',
    'gen/out.ts': 'const invoiceTotal = generated;',
    'src/unrelated.ts': 'export const banana = 1;',
  };

  const sources = (symbols?: SymbolIndex, read = vi.fn(async (p: string) => fileText[p])): ContextSources => ({
    listFiles: async () => Object.keys(fileText),
    readFile: read,
    recentFiles: () => ['.env', 'gen/out.ts', 'src/open.ts', 'src/unrelated.ts', 'src/a.ts', 'not/listed.ts'],
    gitignore: () => new GitIgnore('gen/\n'),
    symbols,
  });

  it('collects imports, definitions and similar open code, ranked', async () => {
    const symbols = new SymbolIndex();
    for (const [p, t] of Object.entries(fileText)) symbols.update(p, t);
    const out = await gatherSnippets(
      { path: 'src/a.ts', prefix: fileText['src/a.ts'] + 'const t = invoiceTotal * taxRate(', suffix: ');' },
      sources(symbols),
    );
    const sorted = [...out].sort((a, b) => b.score - a.score);
    expect(sorted[0]).toMatchObject({ path: 'src/invoice.ts' });
    expect(out.map((s) => `${s.source}:${s.path}`)).toEqual(
      expect.arrayContaining(['import:src/invoice.ts', 'symbol:src/tax.ts', 'similar:src/open.ts']),
    );
  });

  it('never reads secret, ignored, unlisted or the current file', async () => {
    const read = vi.fn(async (p: string) => fileText[p]);
    const out = await gatherSnippets(
      { path: 'src/a.ts', prefix: 'const x = invoiceTotal;', suffix: '' },
      sources(undefined, read),
    );
    const readPaths = read.mock.calls.map((c) => c[0]);
    for (const p of ['.env', 'gen/out.ts', 'not/listed.ts', 'src/a.ts']) expect(readPaths).not.toContain(p);
    expect(out.map((s) => s.path)).not.toContain('src/unrelated.ts');
  });

  it('drops overlapping snippets of the same file', () => {
    const kept = dedupe([snippet('a', 'x\ny\nz', 0.2, 0), snippet('a', 'y\nz', 0.9, 1), snippet('b', 'x', 0.1)]);
    expect(kept.map((s) => [s.path, s.score])).toEqual([
      ['a', 0.9],
      ['b', 0.1],
    ]);
  });
});

describe('completion engine', () => {
  const req: CompletionRequest = {
    path: 'src/a.ts',
    languageId: 'typescript',
    prefix: 'function add(a, b) {\n  ',
    suffix: '\n}\n',
    hasSelection: false,
  };
  const emptySources: ContextSources = {
    listFiles: async () => [],
    readFile: async () => '',
    recentFiles: () => [],
    gitignore: () => undefined,
  };

  it("asks only the Mac's Ollama, raw, with the completion model and stop tokens, then caches", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ response: 'return a + b;<|endoftext|>' })));
    const engine = new CompletionEngine({
      repoName: () => 'oreo-code',
      ollamaUrl: () => 'http://127.0.0.1:11434',
      model: () => 'qwen2.5-coder:1.5b-base',
      sources: emptySources,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await engine.complete(req, new AbortController().signal)).toBe('return a + b;');
    expect(await engine.complete(req, new AbortController().signal)).toBe('return a + b;');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/api/generate');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'qwen2.5-coder:1.5b-base', raw: true, stream: false, keep_alive: KEEP_ALIVE });
    expect(body.options.num_ctx).toBe(BUDGET.contextTokens); // fits even where the model's default is 4K
    expect(body.options.num_predict).toBe(BUDGET.outputTokensBlock);
    expect(body.options.stop).toEqual([...STOP_TOKENS]);
    expect(body.prompt).toMatch(/^<\|repo_name\|>oreo-code\n/);
    expect(body.prompt).toMatch(/<\|fim_middle\|>$/);
  });

  it('asks for one line when the cursor is mid-line', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ response: 'b' })));
    await generate(
      'http://h',
      'coder',
      'p',
      BUDGET.outputTokensLine,
      new AbortController().signal,
      fetchImpl as unknown as typeof fetch,
    );
    const engine = new CompletionEngine({
      repoName: () => 'r',
      ollamaUrl: () => 'http://h',
      model: () => 'coder',
      sources: emptySources,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await engine.complete({ ...req, prefix: 'add(a, ', suffix: ');' }, new AbortController().signal);
    const body = JSON.parse(String((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(body.options.num_predict).toBe(BUDGET.outputTokensLine);
  });

  it('reports Ollama errors and does nothing without an Ollama address', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    const engine = new CompletionEngine({
      repoName: () => 'r',
      ollamaUrl: () => 'http://h',
      model: () => 'coder',
      sources: emptySources,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(engine.complete(req, new AbortController().signal)).rejects.toThrow('404');
    const none = new CompletionEngine({
      repoName: () => 'r',
      ollamaUrl: () => undefined,
      model: () => 'coder',
      sources: emptySources,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await none.complete(req, new AbortController().signal)).toBeUndefined();
    const noModel = new CompletionEngine({
      repoName: () => 'r',
      ollamaUrl: () => 'http://h',
      model: () => undefined,
      sources: emptySources,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await noModel.complete(req, new AbortController().signal)).toBeUndefined();
  });

  it('skips when off, in a disabled language, without the model, during a Mac chat reply or with a selection', () => {
    const ok = { enabled: true, disabledLanguages: ['markdown'], modelInstalled: true, macChatBusy: false };
    expect(skipReason(req, ok)).toBeUndefined();
    expect(skipReason(req, { ...ok, enabled: false })).toBe('off');
    expect(skipReason({ ...req, languageId: 'markdown' }, ok)).toBe('language');
    expect(skipReason(req, { ...ok, modelInstalled: false })).toBe('model not installed');
    expect(skipReason(req, { ...ok, macChatBusy: true })).toBe('chat busy');
    expect(skipReason({ ...req, hasSelection: true }, ok)).toBe('selection');
  });

  it('debounces until cancelled', async () => {
    const controller = new AbortController();
    const waiting = delay(10_000, controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
    expect(await delay(1, new AbortController().signal)).toBe(true);
  });
});
