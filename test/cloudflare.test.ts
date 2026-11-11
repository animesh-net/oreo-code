import { APIConnectionError, APIError } from 'openai';
import { describe, expect, it } from 'vitest';
import { CloudflareClient, MAX_OUTPUT_TOKENS, thinkFilter } from '../src/cloudflare/client';
import { describeCloudflareError } from '../src/cloudflare/errors';
import type { StreamEvent } from '../src/ollama/client';

const QWEN = '@cf/qwen/qwen3-30b-a3b-fp8';
const GPT = '@cf/openai/gpt-oss-120b';

function sse(...deltas: unknown[]): Response {
  const body =
    deltas.map((d) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`).join('') +
    'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function run(model: string, effort: 'none' | 'low' | 'medium' | 'high', ...deltas: unknown[]) {
  let url = '';
  let auth = '';
  let body: Record<string, unknown> = {};
  const client = new CloudflareClient('acc123', 'cf-token', async (input, init) => {
    url = String(input);
    auth = new Headers(init?.headers).get('authorization') ?? '';
    body = JSON.parse(String(init?.body));
    return sse(...deltas);
  });
  const events: StreamEvent[] = [];
  for await (const e of client.streamChat(
    model,
    [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
    ],
    new AbortController().signal,
    effort,
  )) {
    events.push(e);
  }
  return { url, auth, body, events };
}

describe('CloudflareClient', () => {
  it('calls the account’s Workers AI endpoint with the token', async () => {
    const { url, auth } = await run(QWEN, 'none', { content: 'ok' });
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1/chat/completions');
    expect(auth).toBe('Bearer cf-token');
  });

  it('turns Qwen3 thinking off with /no_think in the system message, and leaves it out for On', async () => {
    const off = await run(QWEN, 'none', { content: 'ok' });
    expect((off.body.messages as { content: string }[])[0].content).toBe('SYS\n\n/no_think');
    expect(off.body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(off.body.reasoning_effort).toBeUndefined();
    const on = await run(QWEN, 'medium', { content: 'ok' });
    expect((on.body.messages as { content: string }[])[0].content).toBe('SYS');
    expect(on.body.max_tokens).toBe(MAX_OUTPUT_TOKENS * 2);
  });

  it.each([
    ['none', 'low'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
  ] as const)('sends gpt-oss the effort %s as reasoning_effort %s, never /no_think', async (effort, sent) => {
    const { body } = await run(GPT, effort, { content: 'ok' });
    expect(body.reasoning_effort).toBe(sent);
    expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS * 2);
    expect(JSON.stringify(body.messages)).not.toContain('/no_think');
  });

  it("marks Workers AI's reasoning_content as thinking and drops a leading <think> block", async () => {
    const { events } = await run(
      QWEN,
      'medium',
      { reasoning_content: 'hmm' },
      { content: '<thi' },
      { content: 'nk>plan</think>\n\nAnswer' },
      { content: ' here.' },
    );
    expect(events).toEqual([{ type: 'thinking' }, { type: 'text', text: 'Answer' }, { type: 'text', text: ' here.' }]);
  });
});

describe('thinkFilter', () => {
  it('passes text with no think block straight through', () => {
    const f = thinkFilter();
    expect([f('Hello'), f(' there')]).toEqual(['Hello', ' there']);
  });

  it('drops an empty think block', () => {
    const f = thinkFilter();
    expect([f('<think>\n\n</think>\n\nHi')]).toEqual(['Hi']);
  });
});

describe('describeCloudflareError', () => {
  it('words a refused token, the daily limit and no network', () => {
    expect(describeCloudflareError(APIError.generate(401, {}, undefined, new Headers()))).toMatch(
      /Set Cloudflare token/,
    );
    expect(describeCloudflareError(APIError.generate(429, {}, undefined, new Headers()))).toMatch(/10,000 Neurons/);
    expect(describeCloudflareError(new APIConnectionError({ message: 'x' }))).toMatch(/internet connection/);
  });
});
