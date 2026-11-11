import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { describe, expect, it } from 'vitest';
import { FIRST_TOKEN_TIMEOUT_MS, OllamaClient } from '../src/ollama/client';
import { describeOllamaError, OllamaHttpError } from '../src/ollama/errors';
import { modelsFromTags, OREO_MODELS } from '../src/ollama/models';

const ollama = 'http://127.0.0.1:11434';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(chunks: string[]): Response {
  const body =
    chunks
      .map(
        (text) =>
          `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
      )
      .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('OREO_MODELS', () => {
  it('offers two models on the Mac and two on Workers AI, the Mac first', () => {
    expect(OREO_MODELS.map((m) => [m.id, m.provider, m.supportsTools, m.thinking, m.maxPromptChars])).toEqual([
      ['oreo-4b', 'macbook', true, 'switch', 72_000],
      ['oreo-2b', 'macbook', false, 'switch', 72_000],
      ['@cf/qwen/qwen3-30b-a3b-fp8', 'cloudflare', true, 'switch', 72_000],
      ['@cf/openai/gpt-oss-120b', 'cloudflare', true, 'levels', 200_000],
    ]);
  });

  it('names every model "Oreo <size>", and a Mac model\'s id "oreo-<size>"', () => {
    expect(OREO_MODELS.map((m) => m.name)).toEqual(['Oreo 4B', 'Oreo 2B', 'Oreo 30B', 'Oreo 120B']);
    for (const m of OREO_MODELS) {
      expect(m.name).toMatch(/^Oreo \d+B$/);
      if (m.provider === 'macbook') expect(m.id).toBe(m.name.toLowerCase().replace(' ', '-'));
    }
  });
});

describe('modelsFromTags', () => {
  it('marks a model available under its id or its id + ":latest"', () => {
    const models = modelsFromTags({ models: [{ name: 'oreo-4b:latest' }, { name: 'qwen3.5:2b' }] });
    expect(models.map((m) => [m.id, m.available])).toEqual([
      ['oreo-4b', true],
      ['oreo-2b', false],
    ]);
    expect(modelsFromTags({ models: [{ model: 'oreo-2b' }] }).map((m) => m.available)).toEqual([false, true]);
  });

  it('does not match other tags or prefixes', () => {
    const models = modelsFromTags({ models: [{ name: 'oreo-4b:q8' }, { name: 'oreo-2b-old' }, null] });
    expect(models.every((m) => !m.available)).toBe(true);
  });

  it('rejects other shapes', () => {
    expect(() => modelsFromTags({ data: [] })).toThrow(/unexpected model list/);
  });
});

describe('OllamaClient', () => {
  it('lists the Oreo models from /api/tags without any token', async () => {
    let seen: Request | undefined;
    const client = new OllamaClient(ollama, async (input, init) => {
      seen = new Request(input as string, init);
      return jsonResponse(200, { models: [{ name: 'oreo-2b:latest', model: 'oreo-2b:latest' }] });
    });
    const models = await client.listModels();
    expect(models.map((m) => [m.id, m.available])).toEqual([
      ['oreo-4b', false],
      ['oreo-2b', true],
    ]);
    expect(seen?.url).toBe(`${ollama}/api/tags`);
    expect(seen?.headers.get('authorization')).toBeNull();
  });

  it('raises OllamaHttpError with an Ollama { error } body', async () => {
    const client = new OllamaClient(ollama, async () => jsonResponse(500, { error: 'out of memory' }));
    await expect(client.listModels()).rejects.toMatchObject({ status: 500, serverMessage: 'out of memory' });
  });

  it('reads OpenAI-style { error: { message } } bodies', async () => {
    const client = new OllamaClient(ollama, async () => jsonResponse(502, { error: { message: 'bad gateway' } }));
    await expect(client.listModels()).rejects.toMatchObject({ status: 502, serverMessage: 'bad gateway' });
  });

  it('streams from /v1/chat/completions with the model and reasoning_effort in the body', async () => {
    let url = '';
    let body: { model?: string; stream?: boolean; reasoning_effort?: string; messages?: unknown } = {};
    const client = new OllamaClient(ollama, async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return sseResponse(['Hel', 'lo']);
    });
    const parts: string[] = [];
    for await (const p of client.streamChat(
      'oreo-4b',
      [{ role: 'user', content: 'hi' }],
      new AbortController().signal,
      'none',
    )) {
      if (p.type === 'text') parts.push(p.text);
    }
    expect(parts.join('')).toBe('Hello');
    expect(url).toBe(`${ollama}/v1/chat/completions`);
    expect(body).toEqual({
      model: 'oreo-4b',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoning_effort: 'none',
    });
  });

  // Every level on both models goes out unchanged; Ollama turns any level but "none"
  // into thinking on for qwen3.5.
  it.each(
    OREO_MODELS.filter((m) => m.provider === 'macbook').flatMap((m) =>
      (['none', 'low', 'medium', 'high'] as const).map((e) => [m.id, e] as const),
    ),
  )('sends %s the effort %s as reasoning_effort', async (model, effort) => {
    let body: { model?: string; reasoning_effort?: string } = {};
    const client = new OllamaClient(ollama, async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return sseResponse(['ok']);
    });
    for await (const _ of client.streamChat(
      model,
      [{ role: 'user', content: 'hi' }],
      new AbortController().signal,
      effort,
    )) {
      // drain
    }
    expect(body).toMatchObject({ model, reasoning_effort: effort });
  });
});

describe('tool calls', () => {
  it('marks thinking, sends the tools and passes on tool calls once the stream ends, joined from their pieces', async () => {
    let body: { tools?: unknown[] } = {};
    const chunk = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
    const client = new OllamaClient(ollama, async (_input, init) => {
      body = JSON.parse(String(init?.body));
      const sse =
        chunk({ reasoning: 'hmm' }) +
        chunk({ content: 'Let me look.' }) +
        chunk({
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
          ],
        }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"src/a.ts"}' } }] }) +
        'data: [DONE]\n\n';
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const tools = [{ type: 'function' as const, function: { name: 'read_file', description: 'd', parameters: {} } }];
    const events = [];
    for await (const e of client.streamChat(
      'oreo-4b',
      [{ role: 'user', content: 'hi' }],
      new AbortController().signal,
      'none',
      tools,
    )) {
      events.push(e);
    }
    expect(body.tools).toEqual(tools);
    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'Let me look.' },
      {
        type: 'toolCalls',
        calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }],
      },
    ]);
  });
});

describe('describeOllamaError', () => {
  it('says Ollama was slow to start, not unreachable, on a timeout', () => {
    expect(describeOllamaError(new APIConnectionTimeoutError(), ollama)).toMatch(
      /didn't start answering within 10 minutes/,
    );
  });

  it('allows 10 minutes for the first token', () => {
    expect(FIRST_TOKEN_TIMEOUT_MS).toBe(600_000);
  });

  it('asks whether Ollama is running when it is unreachable', () => {
    expect(describeOllamaError(new APIConnectionError({ message: 'x' }), ollama)).toBe(
      `Can't reach Ollama at ${ollama}. Is it running?`,
    );
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(describeOllamaError(refused, ollama)).toBe(`Can't reach Ollama at ${ollama}. Is it running?`);
  });

  it('suggests creating or pulling a missing model', () => {
    const err = APIError.generate(
      404,
      { error: { message: 'model "oreo-4b" not found, try pulling it first' } },
      undefined,
      new Headers(),
    );
    const text = describeOllamaError(err, ollama, 'oreo-4b');
    expect(text).toMatch(/^oreo-4b isn't in Ollama\./);
    expect(text).toContain('ollama create oreo-4b -f Modelfile.oreo-4b');
    expect(text).toContain('ollama pull oreo-4b');
    expect(describeOllamaError(new OllamaHttpError(404), ollama)).toMatch(/ollama create/);
  });

  it('passes on the message from OpenAI- and Ollama-shaped error bodies', () => {
    const openaiShape = APIError.generate(400, { error: { message: 'bad request' } }, undefined, new Headers());
    expect(describeOllamaError(openaiShape, ollama)).toBe('Ollama answered 400: bad request');
    const ollamaShape = APIError.generate(500, { error: 'model runner crashed' }, undefined, new Headers());
    expect(describeOllamaError(ollamaShape, ollama)).toBe('Ollama answered 500: model runner crashed');
    expect(describeOllamaError(new OllamaHttpError(500, 'out of memory'), ollama)).toBe(
      'Ollama answered 500: out of memory',
    );
    expect(describeOllamaError(new OllamaHttpError(503), ollama)).toBe('Ollama answered 503. Try again in a moment.');
  });

  it('never mentions oreo-ai, tokens or Tailscale', () => {
    const texts = [
      describeOllamaError(new OllamaHttpError(401), ollama),
      describeOllamaError(new OllamaHttpError(429), ollama),
      describeOllamaError(new APIConnectionError({ message: 'x' }), ollama),
    ];
    for (const t of texts) expect(t).not.toMatch(/oreo-ai|token|Tailscale|Sign in/i);
  });
});
