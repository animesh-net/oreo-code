import { APIConnectionError, APIError } from 'openai';
import { describe, expect, it } from 'vitest';
import { CloudflareClient, MAX_OUTPUT_TOKENS, thinkFilter } from '../src/cloudflare/client';
import { describeCloudflareError, RelayHttpError } from '../src/cloudflare/errors';
import type { StreamEvent } from '../src/ollama/client';

const QWEN = '@cf/qwen/qwen3-30b-a3b-fp8';
const GPT = '@cf/openai/gpt-oss-120b';
const RELAY = 'https://ai.animesh.org.in/v1';

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
  const client = new CloudflareClient(RELAY, async (input, init) => {
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
  it("calls oreo-ai's relay with only a placeholder key", async () => {
    const { url, auth, body } = await run(QWEN, 'none', { content: 'ok' });
    expect(url).toBe(`${RELAY}/chat/completions`);
    expect(auth).toBe('Bearer oreo-ai');
    expect(body.model).toBe(QWEN);
    expect(body.stream).toBe(true);
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

describe('CloudflareClient.listModels', () => {
  function client(respond: () => Response | Promise<Response>) {
    const urls: string[] = [];
    const c = new CloudflareClient(RELAY, async (input) => {
      urls.push(String(input));
      return respond();
    });
    return { c, urls };
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('marks both cloud models available when the relay lists them', async () => {
    const { c, urls } = client(() => json(200, { object: 'list', data: [{ id: QWEN }, { id: GPT }] }));
    const models = await c.listModels();
    expect(urls).toEqual([`${RELAY}/models`]);
    expect(models.map((m) => [m.id, m.provider, m.available])).toEqual([
      [GPT, 'cloudflare', true],
      [QWEN, 'cloudflare', true],
    ]);
  });

  it('marks a model the relay leaves out unavailable, and ignores ids it does not know', async () => {
    const { c } = client(() => json(200, { object: 'list', data: [{ id: GPT }, { id: '@cf/other/model' }] }));
    expect((await c.listModels()).map((m) => [m.id, m.available])).toEqual([
      [GPT, true],
      [QWEN, false],
    ]);
  });

  it("throws the relay's 503 with its message", async () => {
    const { c } = client(() => json(503, { error: { message: 'Cloudflare is not configured.' } }));
    const err = await c.listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayHttpError);
    expect((err as RelayHttpError).status).toBe(503);
    expect(describeCloudflareError(err, RELAY)).toMatch(/no Cloudflare set up/);
  });

  it('words an unreachable relay', async () => {
    const { c } = client(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    });
    const err = await c.listModels().catch((e: unknown) => e);
    expect(describeCloudflareError(err, RELAY)).toBe(`Can't reach oreo-ai at ${RELAY}. Is the Mac on Tailscale?`);
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
  const status = (code: number, body: Record<string, unknown> = {}) =>
    APIError.generate(code, body, undefined, new Headers());

  it('words no route to oreo-ai, the rate limit and a relay without Cloudflare', () => {
    expect(describeCloudflareError(new APIConnectionError({ message: 'x' }), RELAY)).toBe(
      `Can't reach oreo-ai at ${RELAY}. Is the Mac on Tailscale?`,
    );
    expect(describeCloudflareError(status(429), RELAY)).toMatch(/limit is reached.*Use a Mac model/);
    expect(describeCloudflareError(status(503), RELAY)).toMatch(/oreo-ai has no Cloudflare set up/);
  });

  it("passes on the relay's own message for a 400", () => {
    expect(describeCloudflareError(status(400, { error: { message: 'Model not offered.' } }), RELAY)).toBe(
      'Model not offered.',
    );
  });

  it('never mentions a Cloudflare token', () => {
    for (const code of [400, 401, 403, 429, 500, 503]) {
      expect(describeCloudflareError(status(code), RELAY)).not.toMatch(/token/i);
    }
  });
});
