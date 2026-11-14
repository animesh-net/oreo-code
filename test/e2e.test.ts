import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelClient, StreamEvent, ToolCall } from '../src/ollama/client';
import type { ModelInfo } from '../src/shared/protocol';
import { DiskWorkspace } from './support/diskWorkspace';
import { BROKEN_SERVER_JS, FIXED_SERVER_JS, FIXTURES, type Fixture } from './support/fixtures';
import { runTask } from './support/runTask';

/**
 * End to end: the real ChatController and agent loop on real projects on disk, with
 * real commands and parsers. The model is scripted to act like Oreo 4B did in use:
 * reading with cat, leaving code out, mangling spacing, announcing without acting,
 * claiming fixes it didn't make. Each task must end with the fixture's own check passing.
 */

const OREO_4B: ModelInfo = {
  id: 'oreo-4b',
  name: 'Oreo 4B',
  provider: 'macbook',
  supportsTools: true,
  thinking: 'switch',
  maxPromptChars: 66_000,
  available: true,
};

let n = 0;
const call = (name: string, args: unknown): ToolCall => ({
  id: `c${++n}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

/** A model that answers each call from a script: tool calls, or text. Records what it was sent. */
function scripted(rounds: (ToolCall[] | string)[]) {
  const sent: { role: string; content: string }[][] = [];
  let i = 0;
  const client: ModelClient = {
    listModels: async () => [OREO_4B],
    streamChat: (_model, wire) => {
      sent.push(wire.map((m) => ({ role: m.role, content: m.content })));
      const round = rounds[Math.min(i++, rounds.length - 1)];
      return (async function* (): AsyncIterable<StreamEvent> {
        if (typeof round === 'string') yield { type: 'text', text: round };
        else yield { type: 'toolCalls', calls: round };
      })();
    },
  };
  return { client, sent, calls: () => i };
}

const fixture = (name: string) => FIXTURES.find((f) => f.name === name) as Fixture;
const open: DiskWorkspace[] = [];
async function workspace(name: string) {
  const ws = await DiskWorkspace.create(fixture(name).files);
  open.push(ws);
  return ws;
}
afterEach(async () => {
  for (const ws of open.splice(0)) await ws.dispose();
});

describe('agent mode end to end, on disk', () => {
  it('fixes the broken server app the way Oreo 4B tries it, and the app serves the page', async () => {
    const ws = await workspace('broken-server');
    const before = await fixture('broken-server').verify(ws);
    expect(before.passed).toBe(false);

    const { client, sent } = scripted([
      [call('run_command', { command: 'cat server/index.js' })], // refused: use read_file
      [call('read_file', { path: 'server/index.js' })],
      [
        call('write_file', {
          path: 'server/index.js',
          content: "import { createServer } from 'http';\n// ... rest of the file unchanged\n",
        }),
      ], // refused
      [call('write_file', { path: 'server/index.js', content: FIXED_SERVER_JS })],
      'Fixed server/index.js: removed the existsSync check, closed the function and started the server.',
    ]);
    const run = await runTask({ ws, client, modelId: 'oreo-4b', task: fixture('broken-server').task });

    expect(run.error).toBeUndefined();
    expect(sent[1].at(-1)?.content).toMatch(/use read_file/);
    expect(sent[3].at(-1)?.content).toMatch(/leaves code out/);
    expect(run.steps.map((s) => s.title)).toContain('Checked 1 changed file: no errors');
    expect(run.approvals).toEqual(['Run npm start']); // Auto-edit; only starting the app asks
    expect(run.steps.at(-1)?.title).toMatch(
      /^Started the app with `npm start`: started and kept running; GET \/ answered 200/,
    );
    expect(await fixture('broken-server').verify(ws)).toMatchObject({ passed: true });

    // Undo puts the broken file back on disk.
    await run.controller.handle({ type: 'undoTask' });
    expect(await readFile(path.join(ws.root, 'server/index.js'), 'utf8')).toBe(BROKEN_SERVER_JS);
  });

  it('fixes it by line numbers, carrying on after an announcement, with the error check in between', async () => {
    const ws = await workspace('broken-server');
    const { client, sent } = scripted([
      [call('read_file', { path: 'server/index.js' })],
      "I'll remove the broken existsSync check.", // announced, not done: told to go on
      [call('replace_lines', { path: 'server/index.js', start_line: 9, end_line: 12, new_text: '' })],
      [
        call('replace_lines', {
          path: 'server/index.js',
          start_line: 15,
          end_line: 15,
          new_text: '    }\n}\n\ncreateServer(serve).listen(PORT);',
        }),
      ],
      'Removed the existsSync check, closed serve() and started the server.',
    ]);
    const run = await runTask({ ws, client, modelId: 'oreo-4b', task: fixture('broken-server').task });

    expect(sent[2].at(-1)?.content).toMatch(/didn't do it/);
    // After the first change the file still doesn't parse, and the result says so with the new numbering.
    const afterFirst = sent[3].at(-1)?.content ?? '';
    expect(afterFirst).toMatch(/Lines after this change moved by -4/);
    // Still broken after the first edit: the parser says where, at once, whatever VS Code has listed.
    expect(afterFirst).toMatch(/Syntax error in server\/index\.js at line \d+: Unexpected token[\s\S]*> \d+: /);
    expect(run.steps.map((s) => s.title)).toContain('Checked 1 changed file: no errors');
    expect(await fixture('broken-server').verify(ws)).toMatchObject({ passed: true });
  });

  it('starts the app and sends back a fix that parses but hangs on a request', async () => {
    const ws = await workspace('broken-server');
    // Keeps fs.existsSync, which fs/promises doesn't have: the request throws, the catch
    // never ends the response, and the browser would wait forever.
    const parsesButHangs = BROKEN_SERVER_JS.replace(
      '    delete server\n',
      '    }\n}\n\ncreateServer(serve).listen(PORT, () => console.log(`Listening on ${PORT}`));\n',
    );
    const { client, sent } = scripted([
      [call('read_file', { path: 'server/index.js' })],
      [call('write_file', { path: 'server/index.js', content: parsesButHangs })],
      'Closed serve() and started the server.',
      [call('write_file', { path: 'server/index.js', content: FIXED_SERVER_JS })],
      'Removed the existsSync check; a missing file now answers 404.',
    ]);
    const run = await runTask({ ws, client, modelId: 'oreo-4b', task: fixture('broken-server').task });

    expect(run.error).toBeUndefined();
    expect(sent[3].at(-1)?.content).toMatch(
      /Starting the app with `npm start` failed: it started, but GET \/ got no answer/,
    );
    expect(sent[3].at(-1)?.content).toMatch(/existsSync is not a function/);
    expect(run.approvals).toEqual(['Run npm start']); // asked once; the second run went on its own
    expect(run.steps.at(-1)?.title).toMatch(/GET \/ answered 200/);
    expect(await fixture('broken-server').verify(ws)).toMatchObject({ passed: true });
  }, 30_000);

  it('runs the app when the model starts it itself, and gives more steps to fix what the check found', async () => {
    const ws = await workspace('broken-server');
    // What Oreo 4B did in the eval: a fix that never calls listen, starting the server by
    // hand with "&" and with the start script itself, then a fix that crashes on import.
    const noListen = FIXED_SERVER_JS.replace(
      /createServer\(serve\)\.listen[^\n]*/,
      'export const server = createServer(serve);',
    );
    const badImport = FIXED_SERVER_JS.replace(
      "import fs from 'fs/promises';",
      "import { existsSync, readFile } from 'fs/promises';\nconst fs = { readFile };",
    );
    const { client, sent } = scripted([
      [call('read_file', { path: 'server/index.js' })],
      [call('write_file', { path: 'server/index.js', content: noListen })],
      [call('run_command', { command: 'npm start &' })], // run for a few seconds: exits at once
      [call('write_file', { path: 'server/index.js', content: badImport })],
      [call('run_command', { command: 'node server/index.js 2>&1 || true' })], // the start script: crashes
      'Fixed the server.', // the run check finds the crash and sends it back
      ...Array.from({ length: 12 }, () => [call('read_file', { path: 'package.json' })]), // past the 15 steps
      [call('write_file', { path: 'server/index.js', content: FIXED_SERVER_JS })],
      'Imported fs/promises as a whole again.',
    ]);
    const run = await runTask({ ws, client, modelId: 'oreo-4b', task: fixture('broken-server').task });

    expect(run.error).toBeUndefined();
    expect(sent[3].at(-1)?.content).toMatch(
      /^Error: Started `npm start` for a few seconds, then stopped it: it exited at once/,
    );
    expect(sent[5].at(-1)?.content).toMatch(
      /^Error: Started `node server\/index\.js` for a few seconds[\s\S]*existsSync/,
    );
    expect(sent[6].at(-1)?.content).toMatch(/Starting the app with `npm start` failed: it crashed/);
    // Approved: the two starts by hand, then the run check's own once.
    expect(run.approvals).toEqual(['Run npm start', 'Run node server/index.js', 'Run npm start']);
    expect(run.steps.at(-1)?.title).toMatch(/GET \/ answered 200/);
    expect(await fixture('broken-server').verify(ws)).toMatchObject({ passed: true });
  }, 60_000);

  it('edits from the latest copy when a command changed the file after it was read', async () => {
    const ws = await workspace('broken-server');
    // A command (like a formatter) adds a header line, moving every line down by one.
    const addHeader = `node -e "const f='server/index.js',fs=require('fs');fs.writeFileSync(f,'// server\\n'+fs.readFileSync(f,'utf8'))"`;
    const { client, sent } = scripted([
      [call('read_file', { path: 'server/index.js' })],
      [call('run_command', { command: addHeader })],
      [call('replace_lines', { path: 'server/index.js', start_line: 9, end_line: 12, new_text: '' })], // old numbers: refused
      [call('replace_lines', { path: 'server/index.js', start_line: 10, end_line: 13, new_text: '' })],
      [
        call('replace_lines', {
          path: 'server/index.js',
          start_line: 16,
          end_line: 16,
          new_text: '    }\n}\n\ncreateServer(serve).listen(PORT);',
        }),
      ],
      'Removed the existsSync check, closed serve() and started the server.',
    ]);
    const run = await runTask({ ws, client, modelId: 'oreo-4b', task: fixture('broken-server').task });

    expect(run.error).toBeUndefined();
    expect(sent[3].at(-1)?.content).toMatch(
      /^Error: server\/index\.js changed since you last saw it[\s\S]*1: \/\/ server\n/,
    );
    // The second edit's result has the file as it now is, numbered for the next one.
    expect(sent[4].at(-1)?.content).toMatch(/The latest copy of server\/index\.js[\s\S]*16:     delete server/);
    expect(await readFile(path.join(ws.root, 'server/index.js'), 'utf8')).toMatch(/^\/\/ server\n/);
    expect(await fixture('broken-server').verify(ws)).toMatchObject({ passed: true });
  }, 30_000);

  it('shows the failing lines when the app crashes, and again when the model rewrites the file unchanged', async () => {
    const ws = await workspace('broken-server');
    // Parses, but crashes on start: the server is never defined.
    const crashes = FIXED_SERVER_JS.replace(
      /createServer\(serve\)\.listen[^\n]*/,
      'server.listen(PORT, () => console.log(`Listening on ${PORT}`));',
    );
    const crashLine = crashes.split('\n').findIndex((l) => l.startsWith('server.listen')) + 1;
    const { client, sent } = scripted([
      [call('read_file', { path: 'server/index.js' })],
      [call('write_file', { path: 'server/index.js', content: crashes })],
      'Fixed the server.', // the run check: crashed, with the failing line shown
      [call('write_file', { path: 'server/index.js', content: crashes })], // the same text again
      [call('write_file', { path: 'server/index.js', content: FIXED_SERVER_JS })],
      'Started the server with createServer.',
    ]);
    const run = await runTask({ ws, client, modelId: 'oreo-4b', task: fixture('broken-server').task });

    expect(run.error).toBeUndefined();
    const failed = sent[3].at(-1)?.content ?? '';
    expect(failed).toMatch(/Starting the app with `npm start` failed: it crashed/);
    expect(failed).toContain(`It fails at line ${crashLine} of server/index.js:\n`);
    expect(failed).toContain(`> ${crashLine}: server.listen(PORT`);
    const unchanged = sent[4].at(-1)?.content ?? '';
    expect(unchanged).toMatch(/^Error: that is exactly what server\/index\.js already has, so nothing changed/);
    expect(unchanged).toContain(`> ${crashLine}: server.listen(PORT`);
    expect(await fixture('broken-server').verify(ws)).toMatchObject({ passed: true });
  }, 30_000);

  it('catches a syntax error at once and before finishing even when VS Code reports nothing', async () => {
    const ws = await workspace('broken-server');
    ws.problems = async () => []; // VS Code still busy: its list says nothing about the edit
    const strayBrace = FIXED_SERVER_JS.replace(/^createServer\(serve\)/m, '}\ncreateServer(serve)');
    const { client, sent } = scripted([
      [call('read_file', { path: 'server/index.js' })],
      [call('write_file', { path: 'server/index.js', content: strayBrace })],
      'Fixed the server.', // ignores the warning: the end check sends it back
      [call('write_file', { path: 'server/index.js', content: FIXED_SERVER_JS })],
      'Removed the stray brace.',
    ]);
    const run = await runTask({ ws, client, modelId: 'oreo-4b', task: fixture('broken-server').task });

    expect(run.error).toBeUndefined();
    const afterEdit = sent[2].at(-1)?.content ?? '';
    expect(afterEdit).toMatch(
      /Syntax error in server\/index\.js at line \d+: Unexpected token\. Fix it before going on\./,
    );
    expect(afterEdit).not.toMatch(/No errors reported/);
    expect(sent[3].at(-1)?.content).toMatch(/Syntax error in server\/index\.js at line \d+/);
    expect(run.steps.map((s) => s.title)).toContain('Syntax error left in server/index.js');
    expect(await fixture('broken-server').verify(ws)).toMatchObject({ passed: true });
  }, 30_000);

  it("doesn't let a fix that leaves the file broken end the task", async () => {
    const ws = await workspace('broken-server');
    const { client, sent } = scripted([
      [call('read_file', { path: 'server/index.js' })],
      [call('replace_lines', { path: 'server/index.js', start_line: 9, end_line: 12, new_text: '' })],
      'Fixed the server.', // still doesn't parse: sent back
      [
        call('replace_lines', {
          path: 'server/index.js',
          start_line: 15,
          end_line: 15,
          new_text: '    }\n}\n\ncreateServer(serve).listen(PORT);',
        }),
      ],
      'Closed the function and started the server.',
    ]);
    const run = await runTask({ ws, client, modelId: 'oreo-4b', task: fixture('broken-server').task });

    expect(sent[3].at(-1)?.content).toMatch(/Not done yet[\s\S]*server\/index\.js/);
    expect(run.reply).not.toMatch(/checks still fail/);
    expect(await fixture('broken-server').verify(ws)).toMatchObject({ passed: true });
  });

  it('fixes the Python app: a syntax error, then a bug the tests find', async () => {
    const ws = await workspace('python-calc');
    const test = 'python3 -m unittest discover -s tests -t .';
    const { client, sent } = scripted([
      [call('read_file', { path: 'app/calc.py' })],
      [
        call('replace_lines', {
          path: 'app/calc.py',
          start_line: 1,
          end_line: 2,
          new_text: 'def add(a, b):\nreturn a + b',
        }),
      ], // lost the indent
      [call('replace_lines', { path: 'app/calc.py', start_line: 2, end_line: 2, new_text: '    return a + b' })],
      [call('run_command', { command: test })],
      [
        call('replace_lines', {
          path: 'app/calc.py',
          start_line: 6,
          end_line: 6,
          new_text: '    return sum(values) / len(values)',
        }),
      ],
      [call('run_command', { command: test })],
      'Fixed the def line and average(); all tests pass.',
    ]);
    const run = await runTask({ ws, client, modelId: 'oreo-4b', task: fixture('python-calc').task });

    expect(sent[2].at(-1)?.content).toMatch(
      /Errors in app\/calc\.py after this change[\s\S]*IndentationError|expected an indented block/,
    );
    expect(sent[4].at(-1)?.content).toMatch(/Exit code 1[\s\S]*FAIL/);
    expect(sent[6].at(-1)?.content).toMatch(/Exit code 0/);
    expect(run.approvals).toEqual([`Run ${test}`, `Run ${test}`]);
    expect(run.steps.some((s) => /Checked the syntax of the changed Python files: passed/.test(s.title))).toBe(true);
    expect(await fixture('python-calc').verify(ws)).toMatchObject({ passed: true });
  });

  it('fixes the Node project: a mangled edit applies, the project check catches a half fix', async () => {
    const ws = await workspace('node-tests');
    const { client, sent } = scripted([
      [call('read_file', { path: 'src/slug.js' })],
      // Spacing tidied ("replace(' ','-')"), as a small model copies it.
      [
        call('edit_file', {
          path: 'src/slug.js',
          old_text: "return title.toLowerCase( ).replace(' ','-');",
          new_text: "return title.toLowerCase().replace(/ /g, '-');",
        }),
      ],
      'Fixed slugify.', // the project check (npm run test) still fails on "  Trim Me  "
      [
        call('edit_file', {
          path: 'src/slug.js',
          old_text: "return title.toLowerCase().replace(/ /g, '-');",
          new_text: "return title.trim().toLowerCase().split(/\\s+/).join('-');",
        }),
      ],
      'slugify now trims and joins words with dashes; the tests pass.',
    ]);
    const run = await runTask({ ws, client, modelId: 'oreo-4b', task: fixture('node-tests').task });

    expect(run.approvals).toEqual(['Run npm run test']); // asked once; the second run went on its own
    expect(sent[3].at(-1)?.content).toMatch(/Not done yet[\s\S]*npm run test` failed/);
    expect(run.steps.filter((s) => /Ran the project check `npm run test`/.test(s.title)).map((s) => s.outcome)).toEqual(
      ['error', 'ok'],
    );
    expect(await fixture('node-tests').verify(ws)).toMatchObject({ passed: true });
  });

  it('questions a fix the model only claims, and it makes it', async () => {
    const ws = await workspace('node-tests');
    const { client, sent } = scripted([
      [call('search', { query: 'slugify' })],
      'Files changed:\n- src/slug.js — fixed slugify.', // nothing changed
      [
        call('write_file', {
          path: 'src/slug.js',
          content:
            "export function slugify(title) {\n  return title.trim().toLowerCase().split(/\\s+/).join('-');\n}\n",
        }),
      ],
      'Rewrote slugify in src/slug.js.',
    ]);
    const run = await runTask({ ws, client, modelId: 'oreo-4b', task: fixture('node-tests').task });
    expect(sent[2].at(-1)?.content).toMatch(/no file has been changed in this task/);
    expect(run.reply).not.toMatch(/didn't change any file/);
    expect(await fixture('node-tests').verify(ws)).toMatchObject({ passed: true });
  });

  it('never writes through a symbolic link out of the project', async () => {
    const ws = await workspace('node-tests');
    const outside = await mkdtemp(path.join(tmpdir(), 'oreo-outside-'));
    try {
      await symlink(outside, path.join(ws.root, 'out'));
      const { client, sent } = scripted([
        [call('create_file', { path: 'out/evil.js', content: 'x' })],
        'Could not create it.',
      ]);
      await runTask({ ws, client, modelId: 'oreo-4b', task: 'create out/evil.js' });
      expect(sent[1].at(-1)?.content).toMatch(/outside the open folder/);
      await expect(readFile(path.join(outside, 'evil.js'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
