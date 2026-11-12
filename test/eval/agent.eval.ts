import { writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { OllamaClient } from '../../src/ollama/client';
import { DiskWorkspace } from '../support/diskWorkspace';
import { FIXTURES } from '../support/fixtures';
import { runTask } from '../support/runTask';

/**
 * Live eval: each fixture task, several times, against a real model on Ollama, through
 * the real controller and agent loop in a throwaway copy of the project (every card
 * approved). A run passes when the fixture's own check passes afterwards.
 *
 *   npm run eval                                  # oreo-4b, 3 runs per task
 *   OREO_EVAL_MODEL=oreo-2b OREO_EVAL_RUNS=5 npm run eval
 *   OREO_EVAL_ONLY=broken-server npm run eval
 *
 * Writes eval-report.md with every run's steps and reply.
 */
const model = process.env.OREO_EVAL_MODEL ?? 'oreo-4b';
const runs = Number(process.env.OREO_EVAL_RUNS ?? 3);
const ollamaUrl = process.env.OREO_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const only = process.env.OREO_EVAL_ONLY?.split(',');
const fixtures = FIXTURES.filter((f) => !only || only.includes(f.name));

interface Result {
  fixture: string;
  run: number;
  passed: boolean;
  detail: string;
  seconds: number;
  steps: number;
  approvals: number;
  transcript: string;
}
const results: Result[] = [];

describe(`agent eval: ${model} at ${ollamaUrl}, ${runs} run(s) per task`, () => {
  for (const fixture of fixtures) {
    for (let run = 1; run <= runs; run++) {
      it(`${fixture.name} #${run}`, async () => {
        const ws = await DiskWorkspace.create(fixture.files);
        const started = Date.now();
        try {
          const outcome = await runTask({
            ws,
            client: new OllamaClient(ollamaUrl),
            modelId: model,
            task: fixture.task,
            ollamaUrl,
          });
          const check = await fixture.verify(ws);
          results.push({
            fixture: fixture.name,
            run,
            passed: check.passed,
            detail: check.detail,
            seconds: Math.round((Date.now() - started) / 1000),
            steps: outcome.steps.length,
            approvals: outcome.approvals.length,
            transcript: [
              ...outcome.steps.map(
                (s) =>
                  `- [${s.outcome ?? 'ok'}] ${s.title}${s.detail ? `\n\n  \`\`\`\n  ${s.detail.replace(/\n/g, '\n  ')}\n  \`\`\`` : ''}`,
              ),
              '',
              `Reply: ${outcome.reply || '(none)'}`,
              ...(outcome.error ? [`Error: ${outcome.error}`] : []),
            ].join('\n'),
          });
          expect(check.passed, check.detail).toBe(true);
        } finally {
          await ws.dispose();
        }
      });
    }
  }
});

afterAll(async () => {
  const rows = fixtures.map((f) => {
    const mine = results.filter((r) => r.fixture === f.name);
    const passed = mine.filter((r) => r.passed).length;
    const avg = (k: 'seconds' | 'steps') =>
      mine.length ? Math.round(mine.reduce((n, r) => n + r[k], 0) / mine.length) : 0;
    return `| ${f.name} | ${passed}/${mine.length} | ${avg('steps')} | ${avg('seconds')}s |`;
  });
  const total = results.filter((r) => r.passed).length;
  const table = [
    `Model: ${model}, ${runs} run(s) per task. Passed ${total}/${results.length}.`,
    '',
    '| Task | Passed | Avg steps | Avg time |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
  console.log(`\n${table}\n`);
  const details = results
    .map(
      (r) =>
        `## ${r.fixture} #${r.run}: ${r.passed ? 'passed' : 'FAILED'} (${r.detail}, ${r.seconds}s)\n\n${r.transcript}`,
    )
    .join('\n\n');
  await writeFile('eval-report.md', `# Agent eval\n\n${table}\n\n${details}\n`);
  console.log('Full transcripts: eval-report.md');
});
