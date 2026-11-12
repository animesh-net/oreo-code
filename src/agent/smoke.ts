import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { keepEnds } from './writeTools';

/** How long the app runs to show it starts and answers. */
export const SMOKE_RUN_MS = 8_000;
const PROBE_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_CHARS = 4_000;

export interface SmokeResult {
  ok: boolean;
  /** One line for the step: "started and answered GET / with 200", "crashed (exit 1)". */
  summary: string;
  output: string;
}

/** A port printed by the app ("Listening on http://localhost:3000", "port 8080"). */
const PRINTED_PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})\b|\bport\s*:?\s*(\d{2,5})\b/i;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

/**
 * Starts the app (e.g. `npm start`) for a few seconds to see that it runs: a crash or
 * a non-zero exit fails; a server is asked for `/` on the port it prints (or the PORT
 * it was given) and fails on a 5xx answer, no answer, or by crashing on the request. The whole
 * process group is killed afterwards.
 */
export async function smokeRun(opts: {
  cwd: string;
  command: string;
  shell: string;
  /** e.g. ['-lc'] for the user's login shell, so PATH matches their terminal. */
  shellArgs?: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  runMs?: number;
}): Promise<SmokeResult> {
  const port = await freePort();
  const child = spawn(opts.shell, [...(opts.shellArgs ?? ['-c']), opts.command], {
    cwd: opts.cwd,
    env: { ...opts.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr.on('data', (d: Buffer) => (output += d.toString()));
  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => {
    child.on('close', (code) => {
      exitCode = code ?? -1;
      resolve();
    });
    child.on('error', (err) => {
      output += err.message;
      exitCode = -1;
      resolve();
    });
  });
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  };
  opts.signal.addEventListener('abort', stop, { once: true });
  const wait = (ms: number) => Promise.race([exited, new Promise((r) => setTimeout(r, ms))]);
  const result = (ok: boolean, summary: string): SmokeResult => ({
    ok,
    summary,
    output: keepEnds(output.trim(), MAX_OUTPUT_CHARS) || '(no output)',
  });
  try {
    // Probe as soon as the app prints its port; otherwise give it the whole time.
    const until = Date.now() + (opts.runMs ?? SMOKE_RUN_MS);
    while (exitCode === null && Date.now() < until && !PRINTED_PORT.test(output)) await wait(250);
    if (exitCode === null && PRINTED_PORT.test(output)) await wait(300);
    if (exitCode !== null) {
      return exitCode === 0 ? result(true, 'ran and finished (exit 0)') : result(false, `crashed (exit ${exitCode})`);
    }
    const printed = PRINTED_PORT.exec(output);
    const target = Number(printed?.[1] ?? printed?.[2] ?? port);
    let answer: string;
    try {
      const res = await fetch(`http://127.0.0.1:${target}/`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      await res.text();
      answer = `GET / answered ${res.status}`;
      if (res.status >= 500) return result(false, `started, but ${answer}`);
    } catch (err) {
      // Something listening that never answers is a hang (a request that's never ended);
      // nothing listening may just be an app that isn't a server, or uses another port.
      if ((err as Error).name === 'TimeoutError') {
        return result(false, `started, but GET / got no answer in ${PROBE_TIMEOUT_MS / 1000} s`);
      }
      answer = 'nothing answered on a port';
    }
    // A request can crash a server that started fine.
    await wait(500);
    if (exitCode !== null && exitCode !== 0) return result(false, `crashed after a request (exit ${exitCode})`);
    return result(true, `started and kept running; ${answer}`);
  } finally {
    opts.signal.removeEventListener('abort', stop);
    stop();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1_000))]);
  }
}
