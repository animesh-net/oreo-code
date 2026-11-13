import { spawn, spawnSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import type { DiskWorkspace } from './diskWorkspace';

/**
 * Small broken projects and the task to give the agent. `verify` checks the outcome
 * itself, independently of the agent's own checks: it is how a task counts as done.
 */
export interface Fixture {
  name: string;
  files: Record<string, string>;
  task: string;
  verify(ws: DiskWorkspace): Promise<{ passed: boolean; detail: string }>;
}

/** The broken app from the screenshots: a cut-off file, a stray `delete`, and no listener. */
export const BROKEN_SERVER_JS = `import { createServer } from 'http';
import fs from 'fs/promises';

const PORT = parseInt(process.env.PORT, 10) || 3597;

async function serve(request, response) {
    try {
        const fileToServe = request.url === '/' ? 'public/index.html' : \`public\${request.url}\`;
        if (!fs.existsSync(fileToServe)) {
            response.statusCode = 404;
            return false;
        }
        const content = await fs.readFile(fileToServe, 'utf8');
        response.end(content);
        return true;
    } catch (e) {
        console.error(e.message);
        return false;
    delete server
`;

/** A working version of BROKEN_SERVER_JS, for scripted models. */
export const FIXED_SERVER_JS = `import { createServer } from 'http';
import fs from 'fs/promises';

const PORT = parseInt(process.env.PORT, 10) || 3597;

async function serve(request, response) {
    try {
        const fileToServe = request.url === '/' ? 'public/index.html' : \`public\${request.url}\`;
        const content = await fs.readFile(fileToServe, 'utf8');
        response.end(content);
        return true;
    } catch (e) {
        response.statusCode = 404;
        response.end('Not found');
        return false;
    }
}

createServer(serve).listen(PORT, () => console.log(\`Listening on \${PORT}\`));
`;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = netServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

/** Starts `node <entry>` with PORT set, asks for `url`, and stops it. */
async function serves(ws: DiskWorkspace, entry: string, url: string, expect: string) {
  const parse = spawnSync('node', ['--check', entry], { cwd: ws.root, encoding: 'utf8' });
  if (parse.status !== 0)
    return { passed: false, detail: `${entry} doesn't parse: ${parse.stderr.trim().split('\n')[0]}` };
  const port = await freePort();
  const child = spawn('node', [entry], { cwd: ws.root, env: { ...process.env, PORT: String(port) }, stdio: 'pipe' });
  let log = '';
  child.stdout.on('data', (d: Buffer) => (log += d));
  child.stderr.on('data', (d: Buffer) => (log += d));
  try {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const res = await fetch(`http://127.0.0.1:${port}${url}`);
        const body = await res.text();
        return res.status === 200 && body.includes(expect)
          ? { passed: true, detail: `GET ${url} → 200` }
          : { passed: false, detail: `GET ${url} → ${res.status} ${body.slice(0, 80)}` };
      } catch {
        if (child.exitCode !== null) break;
      }
    }
    return {
      passed: false,
      detail: `server didn't answer: ${log.trim().split('\n').slice(-2).join(' | ') || 'no output'}`,
    };
  } finally {
    child.kill('SIGKILL');
  }
}

function runs(ws: DiskWorkspace, command: string) {
  const r = spawnSync('/bin/sh', ['-c', command], { cwd: ws.root, encoding: 'utf8', timeout: 60_000 });
  const out = `${r.stdout}${r.stderr}`.trim().split('\n').slice(-3).join(' | ');
  return { passed: r.status === 0, detail: `${command} → exit ${r.status}${r.status ? `: ${out}` : ''}` };
}

export const FIXTURES: Fixture[] = [
  {
    name: 'broken-server',
    files: {
      'package.json':
        JSON.stringify({ name: 'test', type: 'module', scripts: { start: 'node server/index.js' } }, null, 2) + '\n',
      'server/index.js': BROKEN_SERVER_JS,
      'public/index.html': '<!DOCTYPE html><html><body><h1>Hello, World!</h1></body></html>\n',
    },
    task: 'fix issues in my code so the app runs and serves public/index.html',
    verify: (ws) => serves(ws, 'server/index.js', '/index.html', 'Hello, World!'),
  },
  {
    name: 'python-calc',
    files: {
      'app/__init__.py': '',
      'app/calc.py':
        'def add(a, b)\n    return a + b\n\n\ndef average(values):\n    return sum(values) / len(values) + 1\n',
      'tests/__init__.py': '',
      'tests/test_calc.py':
        'import unittest\nfrom app.calc import add, average\n\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\n    def test_average(self):\n        self.assertEqual(average([2, 4, 6]), 4)\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
    },
    task: 'Fix app/calc.py so the tests pass. Run them with: python3 -m unittest discover -s tests -t .',
    verify: async (ws) => runs(ws, 'python3 -m unittest discover -s tests -t .'),
  },
  {
    name: 'node-tests',
    files: {
      'package.json':
        JSON.stringify({ name: 'slugs', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
      'src/slug.js': "export function slugify(title) {\n  return title.toLowerCase().replace(' ', '-');\n}\n",
      'test/slug.test.js':
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slug.js';\n\ntest('slugify', () => {\n  assert.equal(slugify('Hello Big World'), 'hello-big-world');\n  assert.equal(slugify('  Trim Me  '), 'trim-me');\n});\n",
    },
    task: 'make the tests pass',
    verify: async (ws) => runs(ws, 'npm test'),
  },
];
