import { describe, expect, it } from 'vitest';
import { runWorkspaceTool, type Workspace } from '../src/agent/workspaceTools';
import { buildSystemPrompt } from '../src/chat/context';
import type { ToolCall } from '../src/ollama/client';

const files: Record<string, string> = {
  'src/a.ts': 'const x = 1;\nexport function hello() {}\n',
  'src/b.ts': 'import { hello } from "./a";\nhello();\n',
  '.env': 'SECRET=1',
  'README.md': '# Demo\n',
};

function workspace(open?: { path: string; text: string; selection?: string }): Workspace {
  return {
    name: 'demo',
    listFiles: async () => Object.keys(files).sort(),
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`${p} is missing`);
      return files[p];
    },
    branch: async () => 'main',
    activeFile: () => open,
  };
}

const call = (name: string, args: unknown): ToolCall => ({
  id: 'c1',
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

describe('workspace tools', () => {
  it('lists files, optionally filtered', async () => {
    expect((await runWorkspaceTool(workspace(), call('list_files', {}))).content).toContain('src/a.ts');
    const r = await runWorkspaceTool(workspace(), call('list_files', { contains: 'src/' }));
    expect(r.content).toBe('src/a.ts\nsrc/b.ts');
    expect(r.summary).toBe('Listed files matching "src/"');
  });

  it('reads a file with line numbers and line ranges', async () => {
    const all = await runWorkspaceTool(workspace(), call('read_file', { path: './src/a.ts' }));
    expect(all.summary).toBe('Read src/a.ts');
    expect(all.content).toContain('1: const x = 1;\n2: export function hello() {}');
    const part = await runWorkspaceTool(
      workspace(),
      call('read_file', { path: 'src/a.ts', start_line: 2, end_line: 2 }),
    );
    expect(part.content).toContain('2: export function hello() {}');
    expect(part.content).not.toContain('1: const');
  });

  it('refuses files outside the listing and files that may hold secrets', async () => {
    expect((await runWorkspaceTool(workspace(), call('read_file', { path: '../etc/passwd' }))).content).toMatch(
      /isn't in the repository/,
    );
    expect((await runWorkspaceTool(workspace(), call('read_file', { path: '/etc/passwd' }))).content).toMatch(
      /isn't in the repository/,
    );
    expect((await runWorkspaceTool(workspace(), call('read_file', { path: '.env' }))).content).toMatch(/secrets/);
  });

  it('searches every file but secret ones, case-insensitively', async () => {
    const r = await runWorkspaceTool(workspace(), call('search', { query: 'HELLO' }));
    expect(r.content.split('\n')).toEqual([
      'src/a.ts:2: export function hello() {}',
      'src/b.ts:1: import { hello } from "./a";',
      'src/b.ts:2: hello();',
    ]);
    expect((await runWorkspaceTool(workspace(), call('search', { query: 'SECRET' }))).content).toBe('No matches.');
  });

  it('takes a regular expression too, and a query that is not one as plain text', async () => {
    const r = await runWorkspaceTool(workspace(), call('search', { query: 'const x|import \\{' }));
    expect(r.content.split('\n')).toEqual(['src/a.ts:1: const x = 1;', 'src/b.ts:1: import { hello } from "./a";']);
    expect((await runWorkspaceTool(workspace(), call('search', { query: 'hello(' }))).content).toContain('src/b.ts:2');
  });

  it('answers bad arguments and unknown tools with an error message', async () => {
    const bad: ToolCall = { id: 'c', type: 'function', function: { name: 'read_file', arguments: '{oops' } };
    expect((await runWorkspaceTool(workspace(), bad)).content).toMatch(/not valid JSON/);
    expect((await runWorkspaceTool(workspace(), call('write_file', {}))).content).toMatch(/no tool/);
  });
});

describe('system prompt', () => {
  it('names the repository, branch, files and the open file', async () => {
    const prompt = await buildSystemPrompt(workspace({ path: 'src/a.ts', text: 'OPEN TEXT', selection: 'SEL' }), true);
    expect(prompt).toContain('repository "demo" on branch main');
    expect(prompt).toContain('Files (4; ignored folders left out):\n.env\nREADME.md\nsrc/a.ts\nsrc/b.ts');
    expect(prompt).toContain('Open in the editor (for reference; explain it only if asked): src/a.ts');
    expect(prompt).toContain('OPEN TEXT');
    expect(prompt).toContain('SEL');
    expect(prompt).toContain('read_file');
  });

  it('leaves out an open secret file and tells a model without tools to ask', async () => {
    const prompt = await buildSystemPrompt(workspace({ path: '.env', text: 'SECRET=1' }), false);
    expect(prompt).not.toContain('SECRET=1');
    expect(prompt).toContain("You can't open files");
  });

  it('asks for bugs with a trigger and allows finding none, with or without tools', async () => {
    for (const withTools of [true, false]) {
      const prompt = await buildSystemPrompt(workspace(), withTools);
      expect(prompt).toContain('No trigger, no bug.');
      expect(prompt).toContain('Finding no bugs is a good answer.');
    }
    expect(await buildSystemPrompt(workspace(), true)).toContain('read its callers');
  });

  it('puts the answer rules before the snapshot and the reminder after it', async () => {
    const prompt = await buildSystemPrompt(workspace({ path: 'src/a.ts', text: 'OPEN TEXT' }), true);
    const rules = prompt.indexOf("Answer only the user's latest message.");
    expect(rules).toBeGreaterThan(-1);
    expect(rules).toBeLessThan(prompt.indexOf('Files ('));
    expect(prompt).toContain('Never repeat an earlier answer');
    expect(prompt).toContain('Be brief.');
    expect(prompt.endsWith("The files above are reference only. Answer the user's latest message, briefly.")).toBe(
      true,
    );
    expect(prompt.indexOf('OPEN TEXT')).toBeLessThan(prompt.lastIndexOf('reference only'));
  });

  it('gives the answer rules even with no folder open', async () => {
    expect(await buildSystemPrompt(undefined, false)).toContain("Answer only the user's latest message.");
  });

  it('says when no folder is open', async () => {
    expect(await buildSystemPrompt(undefined, true)).toContain('No folder is open');
  });
});
