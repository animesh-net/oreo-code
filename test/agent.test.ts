import { describe, expect, it } from 'vitest';
import { Checkpoint } from '../src/agent/checkpoint';
import { describeProblems, Instructions, newProblems, type Problem } from '../src/agent/instructions';
import {
  detectCheckCommand,
  detectStartCommand,
  appStartIn,
  expectsServer,
  startsApp,
  syntaxCheckCommand,
} from '../src/agent/verify';
import { FIND_SYMBOL_TOOL, runFindSymbol } from '../src/agent/findSymbol';
import {
  AGENT_TEMPERATURE,
  announcesAction,
  claimsChanges,
  MALFORMED_TWICE,
  MAX_AGENT_STEPS,
  MAX_NUDGES,
  malformedProblem,
  runAgent,
  type AgentDeps,
} from '../src/agent/loop';
import { needsApproval } from '../src/agent/policy';
import {
  applyWrite,
  makeDiff,
  prepareWrite,
  closestText,
  commandEnv,
  MAX_REWRITE_CHARS,
  replaceLines,
  rewriteFile,
  findIgnoringWhitespace,
  keepEnds,
  MAX_WRITE_CHARS,
  writePathProblem,
  type CommandResult,
  type PendingWrite,
  type WritableWorkspace,
} from '../src/agent/writeTools';
import { runWorkspaceTool, WORKSPACE_TOOLS } from '../src/agent/workspaceTools';
import { ChatController, fitToContext } from '../src/chat/chatController';
import type { CodeSymbol } from '../src/completion/symbols';
import type { FunctionTool, ModelClient, StreamEvent, ToolCall, WireMessage } from '../src/ollama/client';
import type { AgentStep, ModelInfo, ToWebview } from '../src/shared/protocol';

function memoryWorkspace(initial: Record<string, string>) {
  const files = { ...initial };
  const commands: string[] = [];
  const ws: WritableWorkspace & { files: Record<string, string>; commands: string[] } = {
    files,
    commands,
    name: 'demo',
    root: '/repo/demo',
    listFiles: async () => Object.keys(files).sort(),
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`${p} is missing`);
      return files[p];
    },
    branch: async () => 'main',
    activeFile: () => undefined,
    exists: async (p) => p in files,
    writeFile: async (p, text) => {
      files[p] = text;
    },
    deleteFile: async (p) => {
      delete files[p];
    },
    runCommand: async (command): Promise<CommandResult> => {
      commands.push(command);
      return { exitCode: 0, output: `ran ${command}`, timedOut: false };
    },
  };
  return ws;
}

const call = (name: string, args: unknown, id = 'c1'): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: 'oreo-4b',
  name: 'Oreo 4B',
  provider: 'macbook',
  supportsTools: true,
  thinking: 'switch',
  maxPromptChars: 66_000,
  available: true,
  ...over,
});

/** A client that answers each model call from a script: tool calls, or text. */
function scripted(rounds: (ToolCall[] | string | Error)[]): ModelClient & {
  calls: { tools?: FunctionTool[]; wire: WireMessage[] }[];
} {
  const calls: { tools?: FunctionTool[]; wire: WireMessage[] }[] = [];
  let i = 0;
  return {
    calls,
    listModels: async () => [],
    streamChat: (_model, wire, signal, _effort, tools) => {
      calls.push({ tools, wire: [...wire] });
      const round = rounds[Math.min(i++, rounds.length - 1)];
      return (async function* (): AsyncIterable<StreamEvent> {
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (round instanceof Error) throw round;
        if (typeof round === 'string') yield { type: 'text', text: round };
        else yield { type: 'toolCalls', calls: round };
      })();
    },
  };
}

function deps(
  client: ModelClient,
  ws: WritableWorkspace,
  over: Partial<AgentDeps> = {},
): AgentDeps & { steps: AgentStep[]; approvals: PendingWrite[] } {
  const steps: AgentStep[] = [];
  const approvals: PendingWrite[] = [];
  const wire: WireMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'Fix it' },
  ];
  return {
    steps,
    approvals,
    model: { client, info: model() },
    wire,
    question: 1,
    fit: fitToContext,
    effort: 'none',
    signal: new AbortController().signal,
    readTools: WORKSPACE_TOOLS,
    runRead: (c) => runWorkspaceTool(ws, c),
    workspace: ws,
    approveEdits: () => false,
    requestApproval: async (p) => {
      approvals.push(p);
      return true;
    },
    checkpoint: new Checkpoint(),
    onText: () => {},
    onThinking: () => {},
    onStep: (s) => steps.push(s),
    ...over,
  };
}

describe('write tools', () => {
  it('refuses paths outside the folder, in .git and secret files', () => {
    expect(writePathProblem('/etc/passwd')).toMatch(/not a relative path/);
    expect(writePathProblem('C:/x.txt')).toMatch(/not a relative path/);
    expect(writePathProblem('~/x')).toMatch(/not a relative path/);
    expect(writePathProblem('../outside.ts')).toMatch(/"\.\."/);
    expect(writePathProblem('src/../../x')).toMatch(/"\.\."/);
    expect(writePathProblem('.git/config')).toMatch(/\.git/);
    expect(writePathProblem('.env')).toMatch(/secrets/);
    expect(writePathProblem('config/.env.local')).toMatch(/secrets/);
    expect(writePathProblem('keys/server.pem')).toMatch(/secrets/);
    expect(writePathProblem('src/app.ts')).toBeUndefined();
  });

  it('refuses .git at any depth and in any case, and secret files in any case', () => {
    expect(writePathProblem('.GIT/config')).toMatch(/\.git/);
    expect(writePathProblem('vendor/lib/.git/hooks/pre-commit')).toMatch(/\.git/);
    expect(writePathProblem('.ENV')).toMatch(/secrets/);
    expect(writePathProblem('config/.Env.Local')).toMatch(/secrets/);
  });

  it('keeps the start and the end of long command output, where failures are', () => {
    const out = `${'a'.repeat(100)}${'b'.repeat(100)}FAILED: test x`;
    const kept = keepEnds(out, 80);
    expect(kept.startsWith('aaaa')).toBe(true);
    expect(kept.endsWith('FAILED: test x')).toBe(true);
    expect(kept).toMatch(/characters cut/);
    expect(keepEnds('short', 80)).toBe('short');
  });

  it('edits only when old_text appears exactly once', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'let x = 1;\nlet y = 1;\n' });
    const missing = await prepareWrite(ws, call('edit_file', { path: 'a.ts', old_text: 'z', new_text: 'q' }));
    expect('error' in missing && missing.error).toMatch(/not found/);
    const twice = await prepareWrite(ws, call('edit_file', { path: 'a.ts', old_text: '= 1', new_text: '= 2' }));
    expect('error' in twice && twice.error).toMatch(/appears 2 times/);
    const once = await prepareWrite(
      ws,
      call('edit_file', { path: './a.ts', old_text: 'let y = 1;', new_text: 'let y = 2;' }),
    );
    expect('pending' in once).toBe(true);
    if (!('pending' in once)) return;
    expect(once.pending.kind === 'edit_file' && once.pending.diff).toContain('-let y = 1;\n+let y = 2;');
    expect(ws.files['a.ts']).toBe('let x = 1;\nlet y = 1;\n'); // nothing changes before approval
    const cp = new Checkpoint();
    expect(await applyWrite(ws, once.pending, new AbortController().signal, (e) => cp.remember(e))).toBe(
      'Edited a.ts.',
    );
    expect(ws.files['a.ts']).toBe('let x = 1;\nlet y = 2;\n');
  });

  it('refuses a write too large to show whole on the card', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const big = 'y'.repeat(MAX_WRITE_CHARS + 1);
    const created = await prepareWrite(ws, call('create_file', { path: 'big.ts', content: big }));
    expect('error' in created && created.error).toMatch(/over 200000 characters/);
    const edited = await prepareWrite(ws, call('edit_file', { path: 'a.ts', old_text: 'x', new_text: big }));
    expect('error' in edited && edited.error).toMatch(/over 200000 characters/);
  });

  it('shows the whole change on the card, however long', async () => {
    const ws = memoryWorkspace({});
    const content = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const prepared = await prepareWrite(ws, call('create_file', { path: 'long.ts', content }));
    if (!('pending' in prepared) || prepared.pending.kind !== 'create_file') throw new Error('expected pending');
    expect(prepared.pending.diff).toContain('+line 1999');
  });

  it('refuses a command with hidden or control characters', async () => {
    const ws = memoryWorkspace({});
    for (const command of ['npm test \u202e;rm -rf ~', 'echo hi\u0007', 'ls\u200b']) {
      const r = await prepareWrite(ws, call('run_command', { command }));
      expect('error' in r && r.error).toMatch(/hidden or control characters/);
    }
    expect('pending' in (await prepareWrite(ws, call('run_command', { command: 'npm test &&\n  npm run lint' })))).toBe(
      true,
    );
  });

  it('remembers what is really saved, so format on save does not block undo', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'let  y=1\n' });
    ws.writeFile = async (p, text) => {
      ws.files[p] = text.replace('y=2', 'y = 2'); // a formatter on save
    };
    const prepared = await prepareWrite(ws, call('edit_file', { path: 'a.ts', old_text: 'y=1', new_text: 'y=2' }));
    if (!('pending' in prepared)) throw new Error('expected pending');
    const cp = new Checkpoint();
    await applyWrite(ws, prepared.pending, new AbortController().signal, (e) => cp.remember(e));
    expect(ws.files['a.ts']).toBe('let  y = 2\n');
    expect((await cp.restore(ws)).restored).toEqual(['a.ts']);
    expect(ws.files['a.ts']).toBe('let  y=1\n');
  });

  it('refuses a symbolic link or a path outside the folder before showing a card', async () => {
    const ws = memoryWorkspace({ 'link.ts': 'x' });
    ws.writeProblem = async (p) => (p === 'link.ts' || p.startsWith('out/') ? `${p} is a symbolic link.` : undefined);
    const edit = await prepareWrite(ws, call('edit_file', { path: 'link.ts', old_text: 'x', new_text: 'y' }));
    expect('error' in edit && edit.error).toMatch(/symbolic link/);
    const create = await prepareWrite(ws, call('create_file', { path: 'out/new.ts', content: 'y' }));
    expect('error' in create && create.error).toMatch(/symbolic link/);
  });

  it('edits a file with Windows line endings and keeps them', async () => {
    const ws = memoryWorkspace({ 'Program.cs': 'class A\r\n{\r\n    int x = 1;\r\n}\r\n' });
    const prepared = await prepareWrite(
      ws,
      call('edit_file', {
        path: 'Program.cs',
        old_text: '{\n    int x = 1;',
        new_text: '{\n    int x = 2;\n    int y = 3;',
      }),
    );
    if (!('pending' in prepared)) throw new Error(`expected pending: ${JSON.stringify(prepared)}`);
    await applyWrite(ws, prepared.pending, new AbortController().signal, () => {});
    expect(ws.files['Program.cs']).toBe('class A\r\n{\r\n    int x = 2;\r\n    int y = 3;\r\n}\r\n');
  });

  it("runs commands without VS Code's own environment", () => {
    const env = commandEnv({ PATH: '/usr/bin', HOME: '/Users/a', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '42' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/a', CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' });
  });

  it("tells the model which unsaved files a command couldn't see", async () => {
    const ws = memoryWorkspace({});
    ws.unsavedFiles = () => ['src/a.ts'];
    const prepared = await prepareWrite(ws, call('run_command', { command: 'npm test' }));
    if (!('pending' in prepared)) throw new Error('expected pending');
    expect(await applyWrite(ws, prepared.pending, new AbortController().signal, () => {})).toMatch(
      /src\/a\.ts has unsaved changes in the editor/,
    );
  });

  it('checks an edit again when the file changed after the card was shown', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'one\n' });
    const prepared = await prepareWrite(ws, call('edit_file', { path: 'a.ts', old_text: 'one', new_text: 'two' }));
    if (!('pending' in prepared)) throw new Error('expected pending');
    ws.files['a.ts'] = 'changed\n';
    expect(await applyWrite(ws, prepared.pending, new AbortController().signal, () => {})).toMatch(/not found/);
    expect(ws.files['a.ts']).toBe('changed\n');
  });

  it('refuses to create a file that exists and to edit one that does not', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const exists = await prepareWrite(ws, call('create_file', { path: 'a.ts', content: 'y' }));
    expect('error' in exists && exists.error).toMatch(/already exists/);
    const nope = await prepareWrite(ws, call('edit_file', { path: 'b.ts', old_text: 'x', new_text: 'y' }));
    expect('error' in nope && nope.error).toMatch(/doesn't exist/);
    const secret = await prepareWrite(ws, call('create_file', { path: '.env', content: 'K=1' }));
    expect('error' in secret && secret.error).toMatch(/secrets/);
  });

  it('runs a command and reports its exit code', async () => {
    const ws = memoryWorkspace({});
    const prepared = await prepareWrite(ws, call('run_command', { command: ' npm test ' }));
    if (!('pending' in prepared)) throw new Error('expected pending');
    expect(prepared.pending).toEqual({ kind: 'run_command', command: 'npm test' });
    const out = await applyWrite(ws, prepared.pending, new AbortController().signal, () => {});
    expect(out).toBe('Exit code 0.\nran npm test');
  });

  it('shows a new file as all additions', () => {
    expect(makeDiff('n.ts', undefined, 'a\nb')).toBe('--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b');
  });
});

describe('approval policy', () => {
  it('always asks for a command, and for edits unless approved for the task', () => {
    expect(needsApproval('run_command', false)).toBe(true);
    expect(needsApproval('run_command', true)).toBe(true);
    expect(needsApproval('edit_file', false)).toBe(true);
    expect(needsApproval('create_file', false)).toBe(true);
    expect(needsApproval('edit_file', true)).toBe(false);
    expect(needsApproval('create_file', true)).toBe(false);
  });

  it('always asks for files that decide what runs, even with edits approved', () => {
    for (const path of [
      'package.json',
      'web/package.json',
      '.vscode/tasks.json',
      '.husky/pre-commit',
      '.github/workflows/ci.yml',
      'Makefile',
      'scripts/deploy.sh',
      'src/App/App.csproj',
      'Directory.Build.props',
      'pyproject.toml',
      '.envrc',
      '.npmrc',
      'package-lock.json',
      'web/pnpm-lock.yaml',
      'nuget.config',
      'global.json',
      'requirements-dev.txt',
      'vitest.config.ts',
      'web/vite.config.mjs',
      '.eslintrc.cjs',
      'esbuild.mjs',
    ]) {
      expect(needsApproval('edit_file', true, path)).toBe(true);
      expect(needsApproval('create_file', true, path)).toBe(true);
    }
    expect(needsApproval('edit_file', true, 'src/app.ts')).toBe(false);
  });
});

describe('checkpoint', () => {
  it('restores edited files to their first state and deletes created ones', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'v1' });
    const cp = new Checkpoint();
    cp.remember({ path: 'a.ts', before: 'v1', after: 'v2' });
    ws.files['a.ts'] = 'v2';
    cp.remember({ path: 'a.ts', before: 'v2', after: 'v3' }); // a later edit keeps the original
    ws.files['a.ts'] = 'v3';
    cp.remember({ path: 'new.ts', before: undefined, after: 'created' });
    ws.files['new.ts'] = 'created';
    expect(cp.files).toEqual(['a.ts', 'new.ts']);
    expect(await cp.restore(ws)).toEqual({ restored: ['new.ts', 'a.ts'], changed: [], failed: [] });
    expect(ws.files).toEqual({ 'a.ts': 'v1' });
    expect(cp.isEmpty).toBe(true);
  });

  it("tells when the task first changes a file, so a task without writes keeps the last task's undo", () => {
    let replaced = 0;
    const cp = new Checkpoint(() => replaced++);
    expect(replaced).toBe(0);
    cp.remember({ path: 'a.ts', before: 'v1', after: 'v2' });
    cp.remember({ path: 'b.ts', before: 'v1', after: 'v2' });
    expect(replaced).toBe(1);
  });

  it('leaves a file alone when it changed after the task wrote it', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'v1' });
    const cp = new Checkpoint();
    cp.remember({ path: 'a.ts', before: 'v1', after: 'v2' });
    cp.remember({ path: 'new.ts', before: undefined, after: 'created' });
    ws.files['a.ts'] = 'v2 plus your later work';
    ws.files['new.ts'] = 'created, then edited by you';
    expect(await cp.restore(ws)).toEqual({ restored: [], changed: ['new.ts', 'a.ts'], failed: [] });
    expect(ws.files['a.ts']).toBe('v2 plus your later work');
    expect(ws.files['new.ts']).toBe('created, then edited by you');
  });
});

describe('find_symbol', () => {
  const index: CodeSymbol[] = [
    { name: 'ChatController', kind: 'class', path: 'src/chat/chatController.ts', line: 120 },
    { name: 'Hidden', kind: 'class', path: '.env.ts', line: 0 },
  ];
  const lookup = async (name: string) => index.filter((s) => s.name === name);

  it('returns path:line from the shared index', async () => {
    const r = await runFindSymbol(lookup, call('find_symbol', { name: 'ChatController()' }));
    expect(r.content).toBe('class ChatController — src/chat/chatController.ts:121');
    expect(r.summary).toBe('Looked up ChatController');
  });

  it('says when nothing is found and never lists secret files', async () => {
    expect((await runFindSymbol(lookup, call('find_symbol', { name: 'Hidden' }))).content).toMatch(/No definition/);
    expect((await runFindSymbol(lookup, call('find_symbol', {}))).content).toMatch(/name is empty/);
  });

  it('is offered as a read-only tool', () => {
    expect(FIND_SYMBOL_TOOL.function.name).toBe('find_symbol');
  });
});

describe('agent loop', () => {
  it('reads, edits with approval, then answers', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'let x = 1;\n' });
    const client = scripted([
      [call('read_file', { path: 'a.ts' })],
      [call('edit_file', { path: 'a.ts', old_text: 'x = 1', new_text: 'x = 2' })],
      'Changed x to 2 in a.ts.',
    ]);
    const d = deps(client, ws);
    const result = await runAgent(d);
    expect(result.reply).toBe('Changed x to 2 in a.ts.');
    expect(ws.files['a.ts']).toBe('let x = 2;\n');
    expect(d.approvals.map((p) => p.kind)).toEqual(['edit_file']);
    expect(d.steps.map((s) => s.title)).toEqual(['Read a.ts', 'Edit a.ts']);
    expect(d.checkpoint.files).toEqual(['a.ts']);
    // Each tool result goes back to the model, tied to its call.
    expect(client.calls[2].wire.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('sends a rejection back to the model and changes nothing', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const client = scripted([[call('create_file', { path: 'b.ts', content: 'y' })], 'Okay, left it.']);
    const d = deps(client, ws, { requestApproval: async () => false });
    await runAgent(d);
    expect(ws.files['b.ts']).toBeUndefined();
    expect(d.steps[0]).toMatchObject({ title: 'Create b.ts (rejected)', outcome: 'rejected' });
    const toolMsg = client.calls[1].wire.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/rejected/);
  });

  it('auto-approves edits when switched on, but still asks for every command', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const client = scripted([
      [
        call('edit_file', { path: 'a.ts', old_text: 'x', new_text: 'y' }, 'e1'),
        call('run_command', { command: 'npm test' }, 'r1'),
      ],
      'Done.',
    ]);
    const d = deps(client, ws, { approveEdits: () => true });
    await runAgent(d);
    expect(ws.files['a.ts']).toBe('y');
    expect(d.approvals.map((p) => p.kind)).toEqual(['run_command']);
    expect(ws.commands).toEqual(['npm test']);
  });

  it(`stops at ${MAX_AGENT_STEPS} model calls and withholds tools from the last`, async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const client = scripted([[call('list_files', {})]]);
    const d = deps(client, ws);
    const result = await runAgent(d);
    // The scripted model keeps calling tools; the last call gets no tools, then one summary request.
    expect(client.calls.filter((c) => c.tools).length).toBe(MAX_AGENT_STEPS - 1);
    expect(client.calls.length).toBe(MAX_AGENT_STEPS + 1);
    expect(result.reply).toMatch(new RegExp(`Stopped at the ${MAX_AGENT_STEPS}-step limit before finishing`));
  });

  it('retries once after a malformed tool call, then stops', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const once = scripted([[call('read_file', '{not json')], 'Recovered.']);
    expect((await runAgent(deps(once, ws))).reply).toBe('Recovered.');

    const twice = scripted([[call('no_such_tool', {})], [call('read_file', '[1]')]]);
    await expect(runAgent(deps(twice, ws))).rejects.toThrow(MALFORMED_TWICE);
  });

  it('names a malformed call precisely', () => {
    const names = new Set(['read_file']);
    expect(malformedProblem(call('nope', {}), names)).toMatch(/no tool "nope"/);
    expect(malformedProblem(call('read_file', '{'), names)).toMatch(/not valid JSON/);
    expect(malformedProblem(call('read_file', '"x"'), names)).toMatch(/JSON object/);
    expect(malformedProblem(call('read_file', ''), names)).toBeUndefined();
  });

  it('gives calls without an id, or with a repeated one, their own id', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const client = scripted([
      [call('list_files', {}, ''), call('list_files', {}, 'same'), call('list_files', {}, 'same')],
      'Done.',
    ]);
    const d = deps(client, ws);
    await runAgent(d);
    const ids = d.wire.filter((m) => m.role === 'tool').map((m) => (m.role === 'tool' ? m.tool_call_id : ''));
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(Boolean)).toBe(true);
  });

  it('replaces unparseable arguments in the conversation so the retry is not rejected', async () => {
    const ws = memoryWorkspace({});
    const bad: ToolCall = { id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{oops' } };
    const client = scripted([[bad], 'Done.']);
    const d = deps(client, ws);
    await runAgent(d);
    const sent = client.calls[1].wire.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(sent?.role === 'assistant' && sent.tool_calls?.[0].function.arguments).toBe('{}');
  });

  it('does not run a call the model makes on the last round, which offers no tools', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const edit = call('edit_file', { path: 'a.ts', old_text: 'x', new_text: 'y' });
    const client = scripted([[call('list_files', {})], [edit], 'Summary.']);
    const d = deps(client, ws, { maxSteps: 2 });
    await runAgent(d);
    expect(d.approvals).toHaveLength(0);
    expect(ws.files['a.ts']).toBe('x');
  });

  it('sends a failing tool back to the model instead of ending the task', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const client = scripted([[call('find_symbol', { name: 'X' })], 'Recovered.']);
    const d = deps(client, ws, {
      readTools: [...WORKSPACE_TOOLS, FIND_SYMBOL_TOOL],
      runRead: async () => {
        throw new Error('index broke');
      },
    });
    const result = await runAgent(d);
    expect(result.reply).toBe('Recovered.');
    expect(client.calls[1].wire.some((m) => m.role === 'tool' && m.content === 'Error: index broke')).toBe(true);
  });

  it('keeps the finished work when only the closing summary fails', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const client = scripted([[call('list_files', {})], '', new Error('summary failed')]);
    const result = await runAgent(deps(client, ws));
    expect(result.reply).toBe('Finished after 1 tool call.');
  });

  it('ends cleanly on Stop, even while waiting for approval', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const abort = new AbortController();
    const client = scripted([[call('edit_file', { path: 'a.ts', old_text: 'x', new_text: 'y' })], 'never']);
    const d = deps(client, ws, {
      signal: abort.signal,
      requestApproval: async () => {
        abort.abort();
        return false;
      },
    });
    await expect(runAgent(d)).rejects.toThrow('Stopped.');
    expect(ws.files['a.ts']).toBe('x');
    expect(client.calls).toHaveLength(1);
  });

  it('trims the long arguments of calls already made when the context is full', () => {
    const big = 'z'.repeat(5_000);
    const wire: WireMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Make it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [call('create_file', { path: 'big.ts', content: big }), call('list_files', {}, 'c2')],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'Created big.ts.' },
      { role: 'tool', tool_call_id: 'c2', content: 'big.ts' },
    ];
    fitToContext(wire, 1, 1_000);
    const calls = wire[2].role === 'assistant' ? (wire[2].tool_calls ?? []) : [];
    expect(JSON.parse(calls[0].function.arguments)).toMatchObject({ path: 'big.ts' });
    expect(calls[0].function.arguments.length).toBeLessThan(300);
    expect(calls[1].function.arguments).toBe('{}');
    expect(wire).toHaveLength(5); // the task and every call keep their results
  });
});

describe('agent mode in the chat', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function setup(rounds: (ToolCall[] | string)[], models: ModelInfo[] = [model()]) {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const client = scripted(rounds);
    client.listModels = async () => models;
    const posted: ToWebview[] = [];
    const controller = new ChatController({
      getOllamaUrl: () => 'http://127.0.0.1:11434',
      getLastModel: () => undefined,
      rememberModel: () => {},
      getEffort: () => undefined,
      rememberEffort: () => {},
      createClient: () => client,
      getWorkspace: () => ws,
      getWritableWorkspace: () => ws,
      findSymbol: async () => [],
      post: (m) => posted.push(m),
    });
    await controller.refresh();
    return { ws, client, controller, posted };
  }

  it('offers find_symbol and the write tools only in agent mode', async () => {
    const { controller, client } = await setup(['Hi.', 'Hi again.']);
    expect(controller.state).toMatchObject({ agentMode: false, hasFolder: true });
    await controller.handle({ type: 'send', text: 'hello' });
    expect(client.calls[0].tools?.map((t) => t.function.name)).toEqual(['list_files', 'read_file', 'search']);

    await controller.handle({ type: 'setAgentMode', on: true });
    await controller.handle({ type: 'send', text: 'do it' });
    expect(client.calls[1].tools?.map((t) => t.function.name)).toEqual([
      'list_files',
      'read_file',
      'search',
      'find_symbol',
      'edit_file',
      'replace_lines',
      'write_file',
      'create_file',
      'run_command',
    ]);
  });

  it('waits on the approval card, applies on Approve, and Undo puts the file back', async () => {
    const { ws, controller } = await setup([
      [call('edit_file', { path: 'a.ts', old_text: 'x', new_text: 'y' })],
      'Changed a.ts.',
    ]);
    await controller.handle({ type: 'setAgentMode', on: true });
    await controller.handle({ type: 'setApproveEdits', on: false });
    const task = controller.handle({ type: 'send', text: 'change x' });
    for (let i = 0; i < 20 && !controller.state.approval; i++) await tick();
    const approval = controller.state.approval;
    expect(approval).toMatchObject({ kind: 'edit_file', title: 'Edit a.ts' });
    expect(approval?.detail).toContain('-x\n+y');
    expect(ws.files['a.ts']).toBe('x');

    await controller.handle({ type: 'approval', id: approval!.id + 1, approved: true }); // stale id: ignored
    expect(controller.state.approval).toBeDefined();
    await controller.handle({ type: 'approval', id: approval!.id, approved: true });
    await task;
    expect(ws.files['a.ts']).toBe('y');
    const last = controller.state.messages.at(-1);
    expect(last?.content).toBe('Changed a.ts.');
    expect(last?.steps?.map((s) => s.title)).toEqual(['Edit a.ts']);
    expect(controller.state.undoFiles).toEqual(['a.ts']);

    await controller.handle({ type: 'undoTask' });
    expect(ws.files['a.ts']).toBe('x');
    expect(controller.state.undoFiles).toBeUndefined();
    expect(controller.state.messages.at(-1)?.content).toMatch(/put back 1 file \(a\.ts\)/);
  });

  it('New chat during a task keeps the old turn out of the new chat, and keeps Undo', async () => {
    const { ws, controller } = await setup([
      [call('edit_file', { path: 'a.ts', old_text: 'x', new_text: 'y' })],
      [call('run_command', { command: 'npm test' })],
      'never',
    ]);
    await controller.handle({ type: 'setAgentMode', on: true });
    await controller.handle({ type: 'setApproveEdits', on: true });
    const task = controller.handle({ type: 'send', text: 'change x' });
    for (let i = 0; i < 20 && !controller.state.approval; i++) await tick();
    expect(ws.files['a.ts']).toBe('y'); // the edit was applied; the command is waiting
    controller.newChat();
    await task;
    expect(controller.state.messages).toEqual([]);
    expect(controller.state.undoFiles).toEqual(['a.ts']);
    await controller.handle({ type: 'undoTask' });
    expect(ws.files['a.ts']).toBe('x');
  });

  it('shows the command and folder on the card, and Stop rejects it', async () => {
    const { ws, controller } = await setup([[call('run_command', { command: 'rm -rf build' })], 'never']);
    await controller.handle({ type: 'setAgentMode', on: true });
    await controller.handle({ type: 'setApproveEdits', on: true });
    const task = controller.handle({ type: 'send', text: 'clean' });
    for (let i = 0; i < 20 && !controller.state.approval; i++) await tick();
    expect(controller.state.approval).toMatchObject({ kind: 'run_command', detail: 'rm -rf build', cwd: '/repo/demo' });
    await controller.handle({ type: 'stop' });
    await task;
    expect(ws.commands).toEqual([]);
    expect(controller.state.approval).toBeUndefined();
    expect(controller.state.busy).toBe(false);
    // Your settings stay as you set them.
    expect(controller.state).toMatchObject({ agentMode: true, approveEdits: true });
  });

  it('applies edits without asking by default, and remembers the Agent switch and the box', async () => {
    const saved: { agentMode: boolean; approveEdits: boolean }[] = [];
    const { ws, controller } = await setup([
      [call('edit_file', { path: 'a.ts', old_text: 'x', new_text: 'y' })],
      'Changed.',
    ]);
    (
      controller as unknown as { deps: { rememberAgentSettings: (s: (typeof saved)[0]) => void } }
    ).deps.rememberAgentSettings = (s) => saved.push(s);
    expect(controller.state).toMatchObject({ agentMode: false, approveEdits: true });
    await controller.handle({ type: 'setAgentMode', on: true });
    await controller.handle({ type: 'send', text: 'change x' });
    expect(ws.files['a.ts']).toBe('y'); // no card
    expect(controller.state.agentMode).toBe(true); // still on after the reply
    await controller.handle({ type: 'setApproveEdits', on: false });
    expect(saved).toEqual([
      { agentMode: true, approveEdits: true },
      { agentMode: true, approveEdits: false },
    ]);
  });

  it('starts with the agent settings you saved last time', () => {
    const controller = new ChatController({
      getOllamaUrl: () => '',
      getLastModel: () => undefined,
      rememberModel: () => {},
      getEffort: () => undefined,
      rememberEffort: () => {},
      createClient: () => scripted([]),
      post: () => {},
      getAgentSettings: () => ({ agentMode: true, approveEdits: false }),
    });
    expect(controller.state).toMatchObject({ agentMode: true, approveEdits: false });
  });

  it('keeps chatting normally with a model that has no tools, even in agent mode', async () => {
    const twoB = model({ id: 'oreo-2b', name: 'Oreo 2B', supportsTools: false });
    const { controller, client } = await setup(['Plain answer.'], [twoB]);
    await controller.handle({ type: 'setAgentMode', on: true });
    await controller.handle({ type: 'send', text: 'hi' });
    expect(client.calls[0].tools).toBeUndefined();
    expect(controller.state.messages.at(-1)?.content).toBe('Plain answer.');
  });
});

describe('repository instructions and checks', () => {
  it('reads the root instruction files once, and a folder’s own the first time the agent works there', async () => {
    const ws = memoryWorkspace({
      'AGENTS.md': 'Use tabs.',
      'CLAUDE.md': 'Run npm run check.',
      'src/web/AGENTS.md': 'No jQuery.',
      'src/web/app.ts': 'x',
      '.env': 'SECRET=1',
    });
    const ins = new Instructions(ws, 10_000);
    expect(await ins.root()).toBe('--- AGENTS.md ---\nUse tabs.\n\n--- CLAUDE.md ---\nRun npm run check.');
    expect(await ins.forPath('src/web/app.ts')).toBe('--- src/web/AGENTS.md ---\nNo jQuery.');
    expect(await ins.forPath('src/web/other.ts')).toBe('');
    expect(await ins.root()).toBe('');
  });

  it('keeps instruction files within the budget', async () => {
    const ws = memoryWorkspace({ 'AGENTS.md': 'a'.repeat(5_000), 'CLAUDE.md': 'b'.repeat(5_000) });
    const text = await new Instructions(ws, 6_000).root();
    expect(text.length).toBeLessThan(6_200);
    expect(text).toMatch(/rest of CLAUDE\.md cut/);
  });

  it('reports only the errors a change added', () => {
    const before = [{ line: 3, message: 'old problem' }];
    const after = [
      { line: 9, message: 'old problem' },
      { line: 4, message: "';' expected.", source: 'ts' },
    ];
    expect(newProblems(before, after)).toEqual([{ line: 4, message: "';' expected.", source: 'ts' }]);
    expect(describeProblems('a.ts', before, after)).toBe(
      "Errors in a.ts after this change. Fix them before going on:\n- line 4: ';' expected. (ts)\nIt also still has errors from before this task:\n- line 9: old problem",
    );
    expect(describeProblems('a.ts', before, [{ line: 1, message: 'old problem' }])).toBe(
      "a.ts still has errors from before this task. Fix them if they're part of the task:\n- line 1: old problem",
    );
    expect(describeProblems('a.ts', [], [])).toBe('No errors reported for a.ts.');
  });

  it("doesn't end a task while a changed file still has an error, even one that was there before", async () => {
    // The edit loses a closing brace in a file that already lacked one: same message, so
    // only counting new errors would have said "no new errors".
    const ws = memoryWorkspace({ 'server/index.js': 'function a() {\n  run();\n' });
    const missing = [{ line: 3, message: "'}' expected." }];
    const errors: Record<string, Problem[]> = { 'server/index.js': missing };
    ws.writeFile = async (p, text) => {
      ws.files[p] = text;
      errors[p] = text.trimEnd().endsWith('}') ? [] : missing;
    };
    const client = scripted([
      [call('edit_file', { path: 'server/index.js', old_text: '  run();', new_text: '  start();' })],
      'Done.',
      [call('edit_file', { path: 'server/index.js', old_text: '  start();', new_text: '  start();\n}' }, 'c2')],
      'Closed the function.',
    ]);
    const d = deps(client, ws, { approveEdits: () => true, problems: async (p) => errors[p] ?? [] });
    const result = await runAgent(d);
    expect(d.steps.map((s) => s.title)).toContain('Checked 1 changed file: 1 error left');
    expect(client.calls[2].wire.at(-1)?.content).toMatch(/still has errors from before this task[\s\S]*'}' expected/);
    expect(ws.files['server/index.js']).toBe('function a() {\n  start();\n}\n');
    expect(result.reply).toMatch(/Closed the function\.$/);
  });

  it('finds the project check from its files', () => {
    const pkg = (scripts: object) => JSON.stringify({ scripts });
    expect(detectCheckCommand(['package.json'], pkg({ test: 'vitest', check: 'tsc' }))).toBe('npm run check');
    expect(detectCheckCommand(['package.json', 'pnpm-lock.yaml'], pkg({ test: 'x' }))).toBe('pnpm run test');
    expect(detectCheckCommand(['package.json', 'yarn.lock'], pkg({ build: 'x' }))).toBe('yarn build');
    expect(detectCheckCommand(['App.sln', 'src/App/App.csproj'], undefined)).toBe('dotnet build');
    expect(detectCheckCommand(['Cargo.toml'], undefined)).toBe('cargo check');
    expect(detectCheckCommand(['go.mod'], undefined)).toBe('go build ./...');
    expect(detectCheckCommand(['README.md'], undefined)).toBeUndefined();
    expect(detectCheckCommand(['package.json'], pkg({ start: 'node .' }))).toBeUndefined();
  });

  it('finds how to start the app, skipping watch modes', () => {
    const pkg = (scripts: object) => JSON.stringify({ scripts });
    expect(detectStartCommand(['package.json'], pkg({ start: 'node server/index.js' }))).toBe('npm start');
    expect(detectStartCommand(['package.json', 'pnpm-lock.yaml'], pkg({ start: 'node .' }))).toBe('pnpm start');
    expect(detectStartCommand(['package.json', 'yarn.lock'], pkg({ start: 'node .' }))).toBe('yarn start');
    expect(detectStartCommand(['package.json'], pkg({ start: 'nodemon index.js' }))).toBeUndefined();
    expect(detectStartCommand(['package.json'], pkg({ start: 'node --watch .' }))).toBeUndefined();
    expect(detectStartCommand(['package.json'], pkg({ test: 'vitest' }))).toBeUndefined();
    expect(detectStartCommand(['package.json'], '{not json')).toBeUndefined();
    expect(detectStartCommand(['main.py'], undefined)).toBeUndefined();
  });

  it('tells a server app from one that just runs', () => {
    expect(expectsServer('fix issues in my code so the app runs and serves public/index.html', undefined)).toBe(true);
    expect(expectsServer('make it listen on port 8080', undefined)).toBe(true);
    expect(expectsServer('fix the failing slugify test', JSON.stringify({ dependencies: { express: '^4' } }))).toBe(
      true,
    );
    expect(expectsServer('fix the failing slugify test', JSON.stringify({ dependencies: { lodash: '^4' } }))).toBe(
      false,
    );
    expect(expectsServer('rename the variable', '{not json')).toBe(false);
    expect(startsApp('npm start')).toBe(true);
    expect(startsApp('yarn run start')).toBe(true);
    expect(startsApp('npm run start:prod')).toBe(false);
    expect(startsApp('npm test')).toBe(false);
  });

  it('knows a command that starts the app, under the noise models add', () => {
    const script = 'node server/index.js';
    expect(appStartIn('npm start &', script)).toBe('npm start');
    expect(appStartIn('npm run start', undefined)).toBe('npm run start');
    expect(appStartIn('node server/index.js 2>&1 || true', script)).toBe('node server/index.js');
    expect(appStartIn('nohup node other.js &', script)).toBe('node other.js');
    expect(appStartIn('node other.js', script)).toBeUndefined();
    expect(appStartIn('npm test', script)).toBeUndefined();
    expect(appStartIn('pkill node; npm start &', script)).toBeUndefined();
    expect(appStartIn('sleep 2 && curl localhost:3597', script)).toBeUndefined();
  });

  it('shows a change the errors it added, so the model fixes them', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'let x = 1;' });
    const errors: Record<string, Problem[]> = { 'a.ts': [] };
    const client = scripted([
      [call('edit_file', { path: 'a.ts', old_text: '1;', new_text: '1' })],
      [call('edit_file', { path: 'a.ts', old_text: '= 1', new_text: '= 1;' }, 'c2')],
      'Fixed.',
    ]);
    ws.writeFile = async (p, text) => {
      ws.files[p] = text;
      errors[p] = text.endsWith(';') ? [] : [{ line: 1, message: "';' expected." }];
    };
    const d = deps(client, ws, { approveEdits: () => true, problems: async (p) => errors[p] ?? [] });
    const result = await runAgent(d);
    const first = client.calls[1].wire.filter((m) => m.role === 'tool').at(-1)?.content;
    expect(first).toMatch(/Errors in a\.ts after this change[\s\S]*line 1: ';' expected\./);
    expect(result.reply).toBe('Fixed.');
    expect(d.steps.some((s) => /Checked 1 changed file: no errors/.test(s.title))).toBe(true);
  });

  it("doesn't let the task end while the project check fails, and says so if it never passes", async () => {
    const ws = memoryWorkspace({ 'a.ts': 'v0' });
    let passes = false;
    ws.runCommand = async (command) => {
      ws.commands.push(command);
      return { exitCode: passes ? 0 : 1, output: passes ? 'ok' : 'FAIL a.test.ts', timedOut: false };
    };
    const edit = (from: string, to: string, id: string) => [
      call('edit_file', { path: 'a.ts', old_text: from, new_text: to }, id),
    ];
    const client = scripted([
      edit('v0', 'v1', 'c1'),
      'Done.',
      edit('v1', 'v2', 'c2'),
      'Done again.',
      edit('v2', 'v3', 'c3'),
      'Done again.',
      edit('v3', 'v4', 'c4'),
      'Done!',
    ]);
    const d = deps(client, ws, { approveEdits: () => true, checkCommand: 'npm test' });
    const result = await runAgent(d);
    expect(ws.commands).toEqual(['npm test', 'npm test', 'npm test', 'npm test']);
    // Asked once, before the first run; the later runs go on their own.
    expect(d.approvals).toEqual([{ kind: 'run_command', command: 'npm test' }]);
    expect(client.calls[2].wire.at(-1)?.content).toMatch(/Not done yet[\s\S]*FAIL a\.test\.ts/);
    expect(result.reply).toMatch(/The checks still fail, so this isn't working yet/);

    passes = true;
    ws.commands.length = 0;
    const again = scripted([edit('v4', 'v5', 'c1'), 'Done.']);
    const ok = await runAgent(deps(again, ws, { approveEdits: () => true, checkCommand: 'npm test' }));
    expect(ws.commands).toEqual(['npm test']);
    expect(ok.reply).toBe('Done.');
  });

  it('skips the project check for the task when you reject it, but still checks for errors', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const client = scripted([[call('edit_file', { path: 'a.ts', old_text: 'x', new_text: 'y' })], 'Done.']);
    const d = deps(client, ws, {
      approveEdits: () => true,
      checkCommand: 'npm test',
      problems: async () => [],
      requestApproval: async () => false,
    });
    const result = await runAgent(d);
    expect(ws.commands).toEqual([]);
    expect(result.reply).toBe('Done.');
    expect(d.steps.map((s) => s.title)).toEqual(
      expect.arrayContaining(['Checked 1 changed file: no errors', 'Skipped the project check `npm test` (rejected)']),
    );
  });

  it('stops checking when the model answers a failure without changing anything', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    ws.runCommand = async (command) => {
      ws.commands.push(command);
      return { exitCode: 1, output: 'already broken on main', timedOut: false };
    };
    const client = scripted([
      [call('edit_file', { path: 'a.ts', old_text: 'x', new_text: 'y' })],
      'Done.',
      'That failure was there before my change.',
    ]);
    const result = await runAgent(deps(client, ws, { approveEdits: () => true, checkCommand: 'npm test' }));
    expect(ws.commands).toEqual(['npm test']);
    expect(client.calls).toHaveLength(3);
    expect(result.reply).toMatch(/there before my change[\s\S]*The checks still fail/);
  });

  it('accepts old_text copied with read_file line numbers', async () => {
    const ws = memoryWorkspace({ 'server/start.js': 'const a = 1;\nconst b = 2;\n' });
    const prepared = await prepareWrite(
      ws,
      call('edit_file', {
        path: 'server/start.js',
        old_text: '1: const a = 1;\n2: const b = 2;',
        new_text: '1: const a = 1;\n2: const b = 3;',
      }),
    );
    if (!('pending' in prepared)) throw new Error(`expected pending: ${JSON.stringify(prepared)}`);
    await applyWrite(ws, prepared.pending, new AbortController().signal, () => {});
    expect(ws.files['server/start.js']).toBe('const a = 1;\nconst b = 3;\n');
    const missing = await prepareWrite(
      ws,
      call('edit_file', { path: 'server/start.js', old_text: 'nope', new_text: 'x' }),
    );
    expect('error' in missing && missing.error).toMatch(/without the "12: " line numbers/);
  });

  it('skips npm scripts that watch or serve, which never end', () => {
    const pkg = JSON.stringify({ scripts: { check: 'tsc --watch', test: 'vitest run' } });
    expect(detectCheckCommand(['package.json'], pkg)).toBe('npm run test');
  });

  it('skips the checks when the task changed nothing', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const client = scripted([[call('list_files', {})], 'Nothing to change.']);
    await runAgent(deps(client, ws, { checkCommand: 'npm test' }));
    expect(ws.commands).toEqual([]);
  });

  it('adds a folder’s instructions to the first file read there', async () => {
    const ws = memoryWorkspace({ 'src/AGENTS.md': 'Prefer async.', 'src/a.ts': 'x' });
    const ins = new Instructions(ws, 10_000);
    const client = scripted([[call('read_file', { path: 'src/a.ts' })], 'Read it.']);
    await runAgent(deps(client, ws, { instructionsFor: (p) => ins.forPath(p) }));
    expect(client.calls[1].wire.at(-1)?.content).toMatch(/follow them:\n--- src\/AGENTS\.md ---\nPrefer async\./);
  });
});

describe('announced but not done', () => {
  it('knows a reply that announces a step from one that finishes', () => {
    expect(
      announcesAction("I found two createServer calls. I'll remove the duplicated createServer call at line 16."),
    ).toBe(true);
    expect(announcesAction("I'll create clean working versions of both server files:")).toBe(true);
    expect(announcesAction('Let me fix the import next.')).toBe(true);
    expect(announcesAction('I removed the duplicate call; the server starts on port 8080.')).toBe(false);
    expect(announcesAction('Should I also rename the helper?')).toBe(false);
    expect(announcesAction('')).toBe(false);
  });

  it('tells the model to carry out what it announced, then finishes', async () => {
    const ws = memoryWorkspace({ 'server/start.js': 'a\na\n' });
    const client = scripted([
      [call('read_file', { path: 'server/start.js' })],
      "I'll remove the duplicated line.",
      [call('edit_file', { path: 'server/start.js', old_text: 'a\na\n', new_text: 'a\n' }, 'c2')],
      'Removed the duplicate.',
    ]);
    const result = await runAgent(deps(client, ws, { approveEdits: () => true }));
    expect(ws.files['server/start.js']).toBe('a\n');
    expect(client.calls[2].wire.at(-1)?.content).toMatch(/didn't do it/);
    expect(result.reply).toMatch(/Removed the duplicate\.$/);
  });

  it('stops nudging after a few tries', async () => {
    const ws = memoryWorkspace({});
    const client = scripted(["I'll do it."]);
    await runAgent(deps(client, ws));
    expect(client.calls).toHaveLength(1 + MAX_NUDGES);
  });
});

describe('claims changes it never made', () => {
  it('knows a reply that claims changes', () => {
    expect(claimsChanges('Files changed:\n- server/index.js — fixed HTTP creation')).toBe(true);
    expect(claimsChanges("I've updated the handler to use async.")).toBe(true);
    expect(claimsChanges('The duplicate call has been removed.')).toBe(true);
    expect(claimsChanges('The bug is on line 6: the handler is inside the options object.')).toBe(false);
    expect(claimsChanges('No changes made: the code is already correct.')).toBe(false);
    expect(claimsChanges('Nothing has been changed yet.')).toBe(false);
    expect(claimsChanges('No files changed.')).toBe(false);
    expect(claimsChanges('In the last task I fixed the import.')).toBe(false);
    expect(claimsChanges('No files changed. I fixed the import in a.js.')).toBe(true);
    // A dot in a file name doesn't end a sentence; the next sentence isn't part of this one.
    expect(claimsChanges('Earlier, in server/index.js I fixed the import.')).toBe(false);
    expect(claimsChanges('I fixed a.js. The bug was there before.')).toBe(true);
    expect(claimsChanges("I didn't touch b.js, but I fixed a.js.")).toBe(true);
  });

  it("doesn't question a claim after a command ran, which may have changed files", async () => {
    const ws = memoryWorkspace({});
    const client = scripted([[call('run_command', { command: 'npm install' })], 'I updated your dependencies.']);
    const result = await runAgent(deps(client, ws));
    expect(client.calls).toHaveLength(2);
    expect(result.reply).toBe('I updated your dependencies.');
  });

  it('tells the model no file was changed, and it makes the change', async () => {
    const ws = memoryWorkspace({ 'server/index.js': 'bad' });
    const client = scripted([
      [call('search', { query: 'error' })],
      'Files changed:\n- server/index.js — fixed the handler.',
      [call('edit_file', { path: 'server/index.js', old_text: 'bad', new_text: 'good' }, 'c2')],
      'Fixed the handler in server/index.js.',
    ]);
    const result = await runAgent(deps(client, ws, { approveEdits: () => true }));
    expect(ws.files['server/index.js']).toBe('good');
    expect(client.calls[2].wire.at(-1)?.content).toMatch(/no file has been changed in this task/);
    expect(result.reply).not.toMatch(/Note: this task/);
  });

  it('asks once, then says plainly that nothing changed if the model keeps claiming it did', async () => {
    const ws = memoryWorkspace({ 'a.js': 'x' });
    const client = scripted(['Files changed: a.js — fixed.']);
    const result = await runAgent(deps(client, ws));
    expect(client.calls).toHaveLength(2);
    expect(result.reply).toMatch(/Note: this task didn't change any file\.$/);
  });

  it('leaves a real report of changes alone', async () => {
    const ws = memoryWorkspace({ 'a.js': 'x' });
    const client = scripted([
      [call('edit_file', { path: 'a.js', old_text: 'x', new_text: 'y' })],
      "I've updated a.js.",
    ]);
    const result = await runAgent(deps(client, ws, { approveEdits: () => true }));
    expect(client.calls).toHaveLength(2);
    expect(result.reply).toBe("I've updated a.js.");
  });
});

describe('edits with tidied spacing', () => {
  const tight =
    'const s=createServer(async(req,res)=>{try{const f=await readFile(`public${req.url}`);return true}catch(e){respondWithNotFound(res)}});\nexport default s;\n';

  it('applies an edit whose old_text differs only in whitespace, when it is unique', async () => {
    const ws = memoryWorkspace({ 'server/index.js': tight });
    const prepared = await prepareWrite(
      ws,
      call('edit_file', {
        path: 'server/index.js',
        old_text: 'return true } catch (e) { respondWithNotFound(res) }',
        new_text: 'return true } catch (e) { res.writeHead(404); res.end() }',
      }),
    );
    if (!('pending' in prepared)) throw new Error(`expected pending: ${JSON.stringify(prepared)}`);
    await applyWrite(ws, prepared.pending, new AbortController().signal, () => {});
    expect(ws.files['server/index.js']).toContain('return true } catch (e) { res.writeHead(404); res.end() }});');
    expect(ws.files['server/index.js']).toContain('export default s;');
  });

  it('refuses a loose match that appears more than once, or is too short to trust', async () => {
    const ws = memoryWorkspace({ 'a.js': 'let total = a + b;\nlet total = a + b;\nx=1;\n' });
    const twice = await prepareWrite(
      ws,
      call('edit_file', { path: 'a.js', old_text: 'let total=a+b;', new_text: 'y' }),
    );
    expect('error' in twice && twice.error).toMatch(/appears 2 times/);
    const short = await prepareWrite(ws, call('edit_file', { path: 'a.js', old_text: 'x = 1;', new_text: 'x = 2;' }));
    expect('error' in short && short.error).toMatch(/not found/);
  });

  it('shows the closest real text when old_text is not found', async () => {
    const ws = memoryWorkspace({ 'server/index.js': tight });
    const r = await prepareWrite(
      ws,
      call('edit_file', {
        path: 'server/index.js',
        old_text: 'catch(err){ respondWithNotFound(response) }',
        new_text: 'x',
      }),
    );
    expect('error' in r && r.error).toMatch(/closest text in the file \(lines 1–1\)[\s\S]*respondWithNotFound\(res\)/);
    expect(findIgnoringWhitespace('a b c d e f g h i j k l m', 'abcdefghijklm')).toEqual([{ start: 0, end: 25 }]);
    expect(closestText('alpha\nbeta', 'gamma delta')).toBeUndefined();
  });

  it('names the file in a failed edit step', async () => {
    const ws = memoryWorkspace({ 'a.js': 'x' });
    const client = scripted([
      [call('edit_file', { path: 'a.js', old_text: 'nothing like it', new_text: 'y' })],
      'Gave up.',
    ]);
    const d = deps(client, ws);
    await runAgent(d);
    expect(d.steps[0].title).toBe("Couldn't edit file a.js");
  });
});

describe('loose edits keep the file tidy', () => {
  it("moves the new lines to the file's indentation", async () => {
    const ws = memoryWorkspace({
      'a.py': 'def f():\n        if ready_to_go:\n                go_now()\n        return 1\n',
    });
    const prepared = await prepareWrite(
      ws,
      call('edit_file', {
        path: 'a.py',
        old_text: '    if ready_to_go:\n        go_now()',
        new_text: '    if ready_to_go:\n        go_now()\n        stop_now()',
      }),
    );
    if (!('pending' in prepared)) throw new Error(`expected pending: ${JSON.stringify(prepared)}`);
    await applyWrite(ws, prepared.pending, new AbortController().signal, () => {});
    expect(ws.files['a.py']).toBe(
      'def f():\n        if ready_to_go:\n                go_now()\n                stop_now()\n        return 1\n',
    );
  });

  it('keeps tabs in a tab-indented file, also for a deeper new level', async () => {
    const ws = memoryWorkspace({ 'c.go': 'func f() {\n\tif readyToGo {\n\t\tgoNow()\n\t}\n}\n' });
    const prepared = await prepareWrite(
      ws,
      call('edit_file', {
        path: 'c.go',
        old_text: '    if readyToGo {\n        goNow()',
        new_text: '    if readyToGo {\n        goNow()\n        if late {\n            hurry()\n        }',
      }),
    );
    if (!('pending' in prepared)) throw new Error(`expected pending: ${JSON.stringify(prepared)}`);
    await applyWrite(ws, prepared.pending, new AbortController().signal, () => {});
    expect(ws.files['c.go']).toBe(
      'func f() {\n\tif readyToGo {\n\t\tgoNow()\n\t\tif late {\n\t\t\thurry()\n\t\t}\n\t}\n}\n',
    );
  });

  it('removes whole lines when the edit deletes them', async () => {
    const ws = memoryWorkspace({ 'b.js': 'a();\n  removeTheOldThing(  1 );\nb();\n' });
    const prepared = await prepareWrite(
      ws,
      call('edit_file', { path: 'b.js', old_text: 'removeTheOldThing(1);', new_text: '' }),
    );
    if (!('pending' in prepared)) throw new Error('expected pending');
    await applyWrite(ws, prepared.pending, new AbortController().signal, () => {});
    expect(ws.files['b.js']).toBe('a();\nb();\n');
  });
});

describe('step limit, file-reading commands and the syntax check', () => {
  it('sends commands that only read files back to read_file', async () => {
    const ws = memoryWorkspace({});
    for (const command of ['cat server/index.js', 'tail -5 server/start.js', 'ls -la public', 'grep -n foo a.js']) {
      const r = await prepareWrite(ws, call('run_command', { command }));
      expect('error' in r && r.error).toMatch(/use read_file/);
    }
    for (const command of [
      'npm start 2>&1 | head -50',
      'node server/start.js',
      'cat a.log | grep ERR',
      'cat node_modules/express/package.json',
      'ls .venv/lib',
      'head -20 /etc/hosts',
    ]) {
      expect('pending' in (await prepareWrite(ws, call('run_command', { command })))).toBe(true);
    }
  });

  it('refuses a server sent to the background, since run_command waits for it and stops it', async () => {
    const ws = memoryWorkspace({});
    for (const command of [
      'npm start &',
      'node server/index.js & ',
      'nohup node server.js',
      'pkill node; npm start &',
    ]) {
      const r = await prepareWrite(ws, call('run_command', { command }));
      expect('error' in r && r.error).toMatch(/don't start the app or a server yourself/);
    }
    for (const command of ['npm run build && npm test', 'make 2>&1', 'echo a && echo b']) {
      expect('pending' in (await prepareWrite(ws, call('run_command', { command })))).toBe(true);
    }
  });

  it('builds one plain parse-only command for changed Python files, for any shell', () => {
    expect(syntaxCheckCommand(['app/main.py', "it's.py", 'README.md'])).toBe(
      "python3 -c 'import ast,sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]' 'app/main.py' 'it'\\''s.py'",
    );
    expect(syntaxCheckCommand(['server/start.js', 'App.jsx', 'README.md'])).toBeUndefined();
  });

  it('still checks Python syntax when you reject the project check', async () => {
    const ws = memoryWorkspace({ 'a.py': 'x = 1' });
    const client = scripted([[call('edit_file', { path: 'a.py', old_text: 'x = 1', new_text: 'x = 2' })], 'Done.']);
    const d = deps(client, ws, {
      approveEdits: () => true,
      checkCommand: 'pytest',
      requestApproval: async () => false,
    });
    await runAgent(d);
    expect(ws.commands).toHaveLength(1);
    expect(ws.commands[0]).toMatch(/^python3 -c .*'a\.py'$/);
    expect(d.steps.map((s) => s.title)).toEqual(
      expect.arrayContaining([
        'Skipped the project check `pytest` (rejected)',
        'Checked the syntax of the changed Python files: passed',
      ]),
    );
  });

  it('skips the Python syntax check when python3 is not installed', async () => {
    const ws = memoryWorkspace({ 'a.py': 'x = 1' });
    ws.runCommand = async (command) => {
      ws.commands.push(command);
      return { exitCode: 127, output: 'python3: command not found', timedOut: false };
    };
    const client = scripted([[call('edit_file', { path: 'a.py', old_text: 'x = 1', new_text: 'x = 2' })], 'Done.']);
    const d = deps(client, ws, { approveEdits: () => true });
    const result = await runAgent(d);
    expect(result.reply).toBe('Done.');
    expect(d.steps.some((s) => /Skipped the Python syntax check/.test(s.title))).toBe(true);
  });

  it('checks the syntax without a card when the project has no check, and sends failures back', async () => {
    const ws = memoryWorkspace({ 'app/start.py': 'bad(' });
    let fixed = false;
    ws.runCommand = async (command) => {
      ws.commands.push(command);
      return fixed
        ? { exitCode: 0, output: '', timedOut: false }
        : { exitCode: 1, output: 'SyntaxError: missing )', timedOut: false };
    };
    const client = scripted([
      [call('edit_file', { path: 'app/start.py', old_text: 'bad(', new_text: 'bad(x' })],
      'Done.',
      [call('edit_file', { path: 'app/start.py', old_text: 'bad(x', new_text: 'bad(x)' }, 'c2')],
      'Fixed the call.',
    ]);
    const origWrite = ws.writeFile;
    ws.writeFile = async (p, t) => {
      await origWrite(p, t);
      fixed = t === 'bad(x)';
    };
    const d = deps(client, ws, { approveEdits: () => true });
    const result = await runAgent(d);
    expect(ws.commands).toHaveLength(2);
    expect(ws.commands[0]).toMatch(/ast\.parse.*'app\/start\.py'/);
    expect(d.approvals).toEqual([]);
    expect(client.calls[2].wire.at(-1)?.content).toMatch(/Python couldn't parse a changed file[\s\S]*SyntaxError/);
    expect(result.reply).toMatch(/Fixed the call\.$/);
  });

  it('says so when the task stops at the step limit mid-way', async () => {
    const ws = memoryWorkspace({ 'a.js': 'x' });
    const client = scripted([
      [call('list_files', {})],
      [call('list_files', {}, 'c2')],
      "Let me check what's actually needed:",
    ]);
    const result = await runAgent(deps(client, ws, { maxSteps: 3 }));
    expect(result.reply).toMatch(/Stopped at the 3-step limit before finishing\. Send "continue" to go on\.$/);
  });

  it('adds no note when the last step is a real answer', async () => {
    const ws = memoryWorkspace({ 'a.js': 'x' });
    const client = scripted([[call('list_files', {})], 'All good: nothing to change.']);
    const result = await runAgent(deps(client, ws, { maxSteps: 2 }));
    expect(result.reply).toBe('All good: nothing to change.');
  });
});

describe('edits a small model can make', () => {
  const file = 'line one\nline two\nline three\nline four\n';

  it('replaces lines by number and reports the new numbering', () => {
    const r = replaceLines(file, 'a.txt', 2, 3, 'TWO\nTWO-B\nTHREE');
    if ('error' in r) throw new Error(r.error);
    expect(r.text).toBe('line one\nTWO\nTWO-B\nTHREE\nline four\n');
    expect(r.report).toBe(
      'Lines 1–6 of a.txt now:\n1: line one\n2: TWO\n3: TWO-B\n4: THREE\n5: line four\n6: \nLines after this change moved by +1.',
    );
  });

  it('inserts with end_line = start_line - 1, deletes with "", and strips copied line numbers', () => {
    const ins = replaceLines(file, 'a.txt', 2, 1, 'inserted');
    expect('text' in ins && ins.text).toBe('line one\ninserted\nline two\nline three\nline four\n');
    const del = replaceLines(file, 'a.txt', 2, 3, '');
    expect('text' in del && del.text).toBe('line one\nline four\n');
    const numbered = replaceLines(file, 'a.txt', 4, 4, '4: line FOUR');
    expect('text' in numbered && numbered.text).toBe('line one\nline two\nline three\nline FOUR\n');
    const crlf = replaceLines('a\r\nb\r\n', 'w.cs', 2, 2, 'B\nC');
    expect('text' in crlf && crlf.text).toBe('a\r\nB\r\nC\r\n');
  });

  it('numbers lines as read_file does, so the last line it showed can be edited', async () => {
    // read_file shows "file (5 lines)" for a 4-line file ending in a newline: line 5 is empty.
    const ws = memoryWorkspace({ 'a.txt': file });
    const shown = await runWorkspaceTool(ws, call('read_file', { path: 'a.txt' }));
    expect(shown.content).toMatch(/^a\.txt \(5 lines\)/);
    const onLast = replaceLines(file, 'a.txt', 5, 5, 'line five');
    expect('text' in onLast && onLast.text).toBe('line one\nline two\nline three\nline four\nline five\n');
    const afterLast = replaceLines(file, 'a.txt', 6, 5, 'line six');
    expect('text' in afterLast && afterLast.text).toBe('line one\nline two\nline three\nline four\n\nline six\n');
    const replaceFour = replaceLines(file, 'a.txt', 4, 4, 'FOUR');
    expect('text' in replaceFour && replaceFour.text).toBe('line one\nline two\nline three\nFOUR\n');
  });

  it('refuses line numbers that are not in the file', () => {
    const r = replaceLines(file, 'a.txt', 7, 8, 'x');
    expect('error' in r && r.error).toMatch(/has 5 lines; lines 7–8 aren't in it/);
    expect('error' in replaceLines(file, 'a.txt', 'two', 3, 'x')).toBe(true);
  });

  it('rewrites a small file whole, keeping its line endings, and refuses left-out code', () => {
    const r = rewriteFile('a\r\nb\r\n', 'w.cs', 'x\ny');
    expect('text' in r && r.text).toBe('x\r\ny\r\n');
    for (const content of [
      'import x;\n// ... rest of the file unchanged',
      'a();\n...\nb();',
      '# existing code here\nprint(1)',
    ]) {
      expect(rewriteFile('old', 'a.js', content)).toMatchObject({ error: expect.stringMatching(/leaves code out/) });
    }
    expect(rewriteFile('x'.repeat(MAX_REWRITE_CHARS + 1), 'big.js', 'y')).toMatchObject({
      error: expect.stringMatching(/too many to rewrite whole/),
    });
    expect('text' in rewriteFile('old', 'a.js', 'const total = items.length; // spread ...rest')).toBe(true);
  });

  it('applies replace_lines through the usual edit flow, with Undo and the new numbering for the model', async () => {
    const ws = memoryWorkspace({ 'server/index.js': 'function a() {\n  run(\n}\n' });
    const client = scripted([
      [call('replace_lines', { path: 'server/index.js', start_line: 2, end_line: 2, new_text: '  run();' })],
      'Fixed the call on line 2.',
    ]);
    const d = deps(client, ws, { approveEdits: () => true });
    const result = await runAgent(d);
    expect(ws.files['server/index.js']).toBe('function a() {\n  run();\n}\n');
    expect(client.calls[1].wire.at(-1)?.content).toMatch(
      /Edited server\/index\.js\.\nLines 1–4 of server\/index\.js now:\n1: function a\(\) \{\n2:   run\(\);/,
    );
    expect(d.steps[0].title).toBe('Edit server/index.js');
    expect(result.reply).toBe('Fixed the call on line 2.');
    expect(await d.checkpoint.restore(ws)).toMatchObject({ restored: ['server/index.js'] });
    expect(ws.files['server/index.js']).toBe('function a() {\n  run(\n}\n');
  });

  it('keeps only the latest copy of a file the agent edits again and again', async () => {
    const ws = memoryWorkspace({ 'a.js': 'one();\ntwo();\nthree();\n' });
    const client = scripted([
      [call('read_file', { path: 'a.js' })],
      [call('replace_lines', { path: 'a.js', start_line: 1, end_line: 1, new_text: 'zero();\none();' }, 'c2')],
      [call('write_file', { path: 'a.js', content: 'zero();\none();\ntwo();\nTHREE();\n' }, 'c3')],
      [call('replace_lines', { path: 'a.js', start_line: 2, end_line: 2, new_text: 'ONE();' }, 'c4')],
      'Done.',
    ]);
    const d = deps(client, ws, { approveEdits: () => true });
    await runAgent(d);
    expect(ws.files['a.js']).toBe('zero();\nONE();\ntwo();\nTHREE();\n');
    const tool = (id: string) => d.wire.find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';
    // Every earlier copy points to the latest one; only the last result carries a copy.
    expect(tool('c1')).toBe(
      '(An older copy of a.js, removed: the file changed since. Its latest copy is further down.)',
    );
    expect(tool('c2')).toMatch(/^Edited a\.js\.[\s\S]*\(An older copy of a\.js, removed/);
    expect(tool('c2')).not.toMatch(/The latest copy/);
    expect(tool('c3')).not.toMatch(/THREE/);
    expect(tool('c4')).toMatch(
      /The latest copy of a\.js, with these line numbers \(earlier copies are out of date\):\na\.js \(5 lines\)\n1: zero\(\);\n2: ONE\(\);\n3: two\(\);\n4: THREE\(\);\n5: \n$/,
    );
    // The whole-file argument of the earlier rewrite is gone too.
    const rewrite = d.wire
      .flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []) : []))
      .find((t) => t.id === 'c3');
    expect(JSON.parse(rewrite?.function.arguments ?? '{}')).toEqual({ path: 'a.js', note: 'older copy removed' });
  });

  it('compacts with the model in use, shows a step and has the model read files again', async () => {
    const ws = memoryWorkspace({ 'a.js': 'one();\ntwo();\n' });
    ws.runCommand = async () => {
      ws.files['a.js'] = '// formatted\none();\ntwo();\n';
      return { exitCode: 0, output: '', timedOut: false };
    };
    const client = scripted([
      [call('read_file', { path: 'a.js' })],
      [call('run_command', { command: 'npm run format' }, 'c2')],
      // After compacting, the model's copy is gone: an edit isn't checked against it.
      [call('replace_lines', { path: 'a.js', start_line: 3, end_line: 3, new_text: 'TWO();' }, 'c3')],
      'Done.',
    ]);
    const compacted: string[] = [];
    const d = deps(client, ws, {
      approveEdits: () => true,
      compact: async (wire, question, model) => {
        if (wire.length < 6) return undefined;
        compacted.push(model.info.id);
        wire.splice(1, question - 1);
        return 1;
      },
    });
    await runAgent(d);
    expect(compacted).toEqual([d.model.info.id, d.model.info.id]);
    expect(d.steps.map((s) => s.title)).toContain('Compacted the conversation to fit the context window');
    expect(ws.files['a.js']).toBe('// formatted\none();\nTWO();\n');
  });

  it('shows the latest copy instead of editing a file that changed since the agent saw it', async () => {
    const ws = memoryWorkspace({ 'a.js': 'one();\ntwo();\n' });
    ws.runCommand = async () => {
      ws.files['a.js'] = '// formatted\none();\ntwo();\n'; // a formatter adds a line on top
      return { exitCode: 0, output: '', timedOut: false };
    };
    const client = scripted([
      [call('read_file', { path: 'a.js' })],
      [call('run_command', { command: 'npm run format' }, 'c2')],
      [call('replace_lines', { path: 'a.js', start_line: 2, end_line: 2, new_text: 'TWO();' }, 'c3')], // old numbering
      [call('replace_lines', { path: 'a.js', start_line: 3, end_line: 3, new_text: 'TWO();' }, 'c4')],
      'Done.',
    ]);
    const d = deps(client, ws, { approveEdits: () => true });
    await runAgent(d);
    expect(client.calls[3].wire.at(-1)?.content).toMatch(
      /^Error: a\.js changed since you last saw it[\s\S]*Nothing was changed[\s\S]*1: \/\/ formatted\n2: one\(\);\n3: two\(\);/,
    );
    expect(ws.files['a.js']).toBe('// formatted\none();\nTWO();\n');
  });

  it('still asks before rewriting a file that decides what runs', async () => {
    const ws = memoryWorkspace({ 'package.json': '{"scripts":{"test":"vitest"}}' });
    const client = scripted([
      [call('write_file', { path: 'package.json', content: '{"scripts":{"test":"node evil.js"}}' })],
      'Done.',
    ]);
    const d = deps(client, ws, { approveEdits: () => true });
    await runAgent(d);
    expect(d.approvals.map((p) => p.kind)).toEqual(['edit_file']);
  });

  it('asks the model for steady output in agent mode', async () => {
    const ws = memoryWorkspace({});
    const temps: (number | undefined)[] = [];
    const client = scripted(['Hi.']);
    const inner = client.streamChat;
    client.streamChat = (m, w, s, e, t, temperature) => {
      temps.push(temperature);
      return inner(m, w, s, e, t);
    };
    await runAgent(deps(client, ws));
    expect(temps).toEqual([AGENT_TEMPERATURE]);
  });
});
