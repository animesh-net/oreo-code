import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { smokeRun } from '../src/agent/smoke';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'oreo-smoke-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function run(source: string) {
  await writeFile(path.join(dir, 'app.js'), source);
  return smokeRun({
    cwd: dir,
    command: 'node app.js',
    shell: '/bin/sh',
    env: process.env,
    signal: new AbortController().signal,
    runMs: 2_000,
  });
}

const server = (handler: string) =>
  `require('http').createServer((req, res) => { ${handler} }).listen(process.env.PORT, () => console.log('Listening on port ' + process.env.PORT));`;

describe('smokeRun', () => {
  it('passes a server that answers', async () => {
    const r = await run(server("res.end('hi')"));
    expect(r).toMatchObject({ ok: true, summary: 'started and kept running; GET / answered 200' });
  });

  it('passes a script that finishes cleanly', async () => {
    expect(await run("console.log('done')")).toMatchObject({ ok: true, summary: 'ran and finished (exit 0)' });
  });

  it('fails a crash on start, with its output', async () => {
    const r = await run('server.listen(3000)');
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('crashed (exit 1)');
    expect(r.output).toMatch(/server is not defined/);
  });

  it('fails a server that answers 500', async () => {
    const r = await run(server('res.statusCode = 500; res.end()'));
    expect(r).toMatchObject({ ok: false, summary: 'started, but GET / answered 500' });
  });

  it('fails a server that never answers', async () => {
    const r = await run(server('/* never ends the response */'));
    expect(r).toMatchObject({ ok: false, summary: 'started, but GET / got no answer in 3 s' });
  }, 10_000);

  it('fails a server that crashes on a request', async () => {
    const r = await run(server('setImmediate(() => { throw new Error("boom") })'));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/boom/);
  });

  it('stops the app when the task is stopped', async () => {
    await writeFile(path.join(dir, 'app.js'), 'setInterval(() => {}, 1000)');
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 200);
    await smokeRun({
      cwd: dir,
      command: 'node app.js',
      shell: '/bin/sh',
      env: process.env,
      signal: ac.signal,
      runMs: 5_000,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
