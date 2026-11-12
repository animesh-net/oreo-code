import { APIError } from 'openai';
import { describe, expect, it } from 'vitest';
import { Checkpoint } from '../src/agent/checkpoint';
import { FIND_SYMBOL_TOOL, runFindSymbol } from '../src/agent/findSymbol';
import { MALFORMED_TWICE, MAX_AGENT_STEPS, malformedProblem, runAgent, type AgentDeps } from '../src/agent/loop';
import { needsApproval } from '../src/agent/policy';
import {
  applyWrite,
  makeDiff,
  prepareWrite,
  keepEnds,
  writePathProblem,
  type CommandResult,
  type PendingWrite,
  type WritableWorkspace,
} from '../src/agent/writeTools';
import { runWorkspaceTool, WORKSPACE_TOOLS } from '../src/agent/workspaceTools';
import { ChatController, fitToContext } from '../src/chat/chatController';
import { isCloudLimitError } from '../src/cloudflare/errors';
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
  defaultRank: 1,
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
    isCloudLimit: isCloudLimitError,
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
    expect(result.reply).toMatch(/Finished after/);
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

  it("moves to the Mac model when Cloudflare's limit is hit mid-task", async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const limit = new APIError(429, { message: 'daily free allocation' }, undefined, undefined);
    const cloud = scripted([[call('list_files', {})], limit]);
    const mac = scripted(['Finished on the Mac.']);
    const moves: string[] = [];
    const d = deps(cloud, ws, {
      model: { client: cloud, info: model({ id: '@cf/x', name: 'Oreo 30B', provider: 'cloudflare' }) },
      fallback: { client: mac, info: model() },
      onMove: (m) => moves.push(m.id),
    });
    const result = await runAgent(d);
    expect(result.reply).toBe('Finished on the Mac.');
    expect(result.model.id).toBe('oreo-4b');
    expect(moves).toEqual(['oreo-4b']);
    expect(d.steps.some((s) => /moved to Oreo 4B/.test(s.title))).toBe(true);
  });

  it('keeps the finished work when only the closing summary fails', async () => {
    const ws = memoryWorkspace({ 'a.ts': 'x' });
    const client = scripted([[call('list_files', {})], '', new Error('summary failed')]);
    const result = await runAgent(deps(client, ws));
    expect(result.reply).toBe('Finished after 1 tool call.');
  });

  it('stops with the error when there is no Mac model to move to', async () => {
    const ws = memoryWorkspace({});
    const limit = new APIError(429, { message: 'rate limited' }, undefined, undefined);
    const cloud = scripted([limit]);
    const d = deps(cloud, ws, {
      model: { client: cloud, info: model({ id: '@cf/x', provider: 'cloudflare' }) },
    });
    await expect(runAgent(d)).rejects.toBe(limit);
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

  it('knows Cloudflare limit errors from other failures', () => {
    expect(isCloudLimitError(new APIError(429, {}, undefined, undefined))).toBe(true);
    expect(isCloudLimitError(new Error('3036: You have used up your daily free allocation'))).toBe(true);
    expect(isCloudLimitError(new APIError(500, {}, undefined, undefined))).toBe(false);
    expect(isCloudLimitError(new Error('fetch failed'))).toBe(false);
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
    // "Approve edits for this task" ends with the task.
    expect(controller.state.approveEdits).toBe(false);
  });

  it('keeps chatting normally with a model that has no tools, even in agent mode', async () => {
    const twoB = model({ id: 'oreo-2b', name: 'Oreo 2B', supportsTools: false, defaultRank: 1 });
    const { controller, client } = await setup(['Plain answer.'], [twoB]);
    await controller.handle({ type: 'setAgentMode', on: true });
    await controller.handle({ type: 'send', text: 'hi' });
    expect(client.calls[0].tools).toBeUndefined();
    expect(controller.state.messages.at(-1)?.content).toBe('Plain answer.');
  });
});
