import { APIConnectionError, APIError } from 'openai';
import { describe, expect, it } from 'vitest';
import { OreoGateway, parseModels } from '../src/gateway/client';
import { describeGatewayError, GatewayHttpError } from '../src/gateway/errors';

const server = 'https://oreo.test';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(chunks: string[]): Response {
  const body = chunks
    .map((text) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('parseModels', () => {
  it('reads { models: [...] } and fills in missing names', () => {
    expect(
      parseModels({
        models: [
          { id: 'gpt-oss-120b', name: 'GPT OSS 120B', provider: 'cloudflare', supportsTools: true },
          { id: 'oreo-2b', provider: 'macbook', available: false },
          { id: 'qwen3' },
        ],
      }),
    ).toEqual([
      { id: 'gpt-oss-120b', name: 'GPT OSS 120B', provider: 'cloudflare', supportsTools: true, available: true },
      { id: 'oreo-2b', name: 'oreo-2b', provider: 'macbook', supportsTools: false, available: false },
      { id: 'qwen3', name: 'qwen3', provider: 'cloudflare', supportsTools: false, available: true },
    ]);
  });

  it('accepts a bare array and skips entries without an id', () => {
    expect(parseModels([{ id: 'a' }, { name: 'no id' }, null])).toEqual([
      { id: 'a', name: 'a', provider: 'cloudflare', supportsTools: false, available: true },
    ]);
  });

  it('rejects other shapes', () => {
    expect(() => parseModels({ data: [] })).toThrow(/unexpected model list/);
  });
});

describe('OreoGateway', () => {
  it('lists models with the bearer token', async () => {
    let seen: Request | undefined;
    const gateway = new OreoGateway(server, 'oreo_t', async (input, init) => {
      seen = new Request(input as string, init);
      return jsonResponse(200, { models: [{ id: 'm1', name: 'Model 1', provider: 'macbook', supportsTools: true }] });
    });
    await expect(gateway.listModels()).resolves.toEqual([
      { id: 'm1', name: 'Model 1', provider: 'macbook', supportsTools: true, available: true },
    ]);
    expect(seen?.url).toBe(`${server}/api/models`);
    expect(seen?.headers.get('authorization')).toBe('Bearer oreo_t');
  });

  it('raises GatewayHttpError with the server message', async () => {
    const gateway = new OreoGateway(server, 'oreo_t', async () => jsonResponse(401, { message: 'bad token' }));
    await expect(gateway.listModels()).rejects.toMatchObject({ status: 401, serverMessage: 'bad token' });
  });

  it('streams chat deltas from the OpenAI-compatible endpoint', async () => {
    let url = '';
    let body: { model?: string; stream?: boolean } = {};
    const gateway = new OreoGateway(server, 'oreo_t', async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return sseResponse(['Hel', 'lo']);
    });
    const parts: string[] = [];
    for await (const p of gateway.streamChat('m1', [{ role: 'user', content: 'hi' }], new AbortController().signal)) {
      parts.push(p);
    }
    expect(parts.join('')).toBe('Hello');
    expect(url).toBe(`${server}/api/llm/v1/chat/completions`);
    expect(body).toMatchObject({ model: 'm1', stream: true });
  });
});

describe('describeGatewayError', () => {
  it('explains auth, limit, missing gateway and server errors', () => {
    expect(describeGatewayError(new GatewayHttpError(401), server)).toMatch(/Sign in/);
    expect(describeGatewayError(new GatewayHttpError(429), server)).toMatch(/limit/);
    expect(describeGatewayError(new GatewayHttpError(429, 'Daily cap hit'), server)).toBe('Daily cap hit');
    expect(describeGatewayError(new GatewayHttpError(404), server)).toMatch(/no model gateway/);
    expect(describeGatewayError(new GatewayHttpError(503), server)).toMatch(/503/);
  });

  it('reads the status from OpenAI SDK errors', () => {
    const err = APIError.generate(429, { error: { message: 'Slow down' } }, undefined, new Headers());
    expect(describeGatewayError(err, server)).toBe('Slow down');
  });

  it('points at Tailscale when the server is unreachable', () => {
    expect(describeGatewayError(new APIConnectionError({ message: 'x' }), server)).toMatch(/Tailscale/);
    const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    expect(describeGatewayError(fetchFailed, server)).toMatch(/Tailscale/);
  });
});
