import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { describe, expect, it } from 'vitest';
import { FIRST_TOKEN_TIMEOUT_MS, MAX_OUTPUT_TOKENS, OllamaClient } from '../src/ollama/client';
import { describeOllamaError, OllamaHttpError } from '../src/ollama/errors';
import {
  billions,
  completionModel,
  contextTokens,
  defaultModel,
  DEFAULT_CONTEXT_TOKENS,
  modelFrom,
  promptBudget,
  tagsFrom,
  type ShowResponse,
} from '../src/ollama/models';

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

/** What /api/show says of the models in these tests, like Ollama does for them. */
const SHOW: Record<string, ShowResponse> = {
  'qwen3.5:4b': {
    capabilities: ['completion', 'tools', 'thinking'],
    details: { family: 'qwen35', parameter_size: '4.0B' },
    model_info: { 'qwen35.context_length': 262144 },
    parameters: 'num_ctx 32768\ntemperature 0.6',
  },
  'qwen3.5:2b': {
    capabilities: ['completion', 'thinking'],
    details: { family: 'qwen35', parameter_size: '2.0B' },
    model_info: { 'qwen35.context_length': 262144 },
  },
  'qwen2.5-coder:1.5b-base': {
    capabilities: ['completion', 'insert'],
    details: { family: 'qwen2', parameter_size: '1.5B' },
    model_info: { 'qwen2.context_length': 32768 },
  },
  'gpt-oss:20b': {
    capabilities: ['completion', 'tools', 'thinking'],
    details: { family: 'gptoss', parameter_size: '20.9B' },
  },
  'nomic-embed-text:latest': { capabilities: ['embedding'], details: { family: 'nomic-bert', parameter_size: '137M' } },
};

/** A fetch that answers /api/tags and /api/show like Ollama with these models, and the rest with `rest`. */
function fakeOllama(names: string[], rest: (url: string, init?: RequestInit) => Response = () => sseResponse(['ok'])) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url.endsWith('/api/show') ? `show ${JSON.parse(String(init?.body)).model}` : url);
    if (url.endsWith('/api/tags')) return jsonResponse(200, { models: names.map((name) => ({ name, model: name })) });
    if (url.endsWith('/api/show')) {
      const show = SHOW[JSON.parse(String(init?.body)).model as string];
      return show ? jsonResponse(200, show) : jsonResponse(404, { error: 'not found' });
    }
    return rest(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('models from Ollama', () => {
  it('reads what each model can do from /api/show', () => {
    const m = (name: string) =>
      modelFrom({ name, parameterSize: SHOW[name].details?.parameter_size as string }, SHOW[name]);
    expect(m('qwen3.5:4b')).toEqual({
      id: 'qwen3.5:4b',
      name: 'qwen3.5:4b',
      provider: 'macbook',
      supportsTools: true,
      thinking: 'switch',
      maxPromptChars: promptBudget(32768),
      sizeB: 4,
      completion: false,
      available: true,
    });
    expect(m('qwen3.5:2b')).toMatchObject({
      supportsTools: false,
      thinking: 'switch',
      maxPromptChars: promptBudget(4096),
    });
    expect(m('qwen2.5-coder:1.5b-base')).toMatchObject({ thinking: 'none', completion: true, sizeB: 1.5 });
    expect(m('gpt-oss:20b')).toMatchObject({ thinking: 'levels', supportsTools: true });
    expect(m('nomic-embed-text:latest')).toBeUndefined(); // can't chat
  });

  it('offers a model Ollama won\'t describe for plain chat, and drops ":latest" from names', () => {
    expect(modelFrom({ name: 'mystery:latest' }, undefined)).toMatchObject({
      name: 'mystery',
      supportsTools: false,
      thinking: 'none',
      maxPromptChars: promptBudget(DEFAULT_CONTEXT_TOKENS),
      completion: false,
    });
  });

  it("uses the model's num_ctx, else Ollama's 4K default, within what it was trained for", () => {
    expect(contextTokens({ parameters: 'stop "<|im_end|>"\nnum_ctx 8192' })).toBe(8192);
    expect(contextTokens({})).toBe(4096);
    expect(contextTokens({ parameters: 'num_ctx 65536', model_info: { 'llama.context_length': 8192 } })).toBe(8192);
    expect(promptBudget(32768)).toBeGreaterThan(64_000);
    expect(promptBudget(4096)).toBeLessThan(6_000);
  });

  it('reads sizes and the tag list', () => {
    expect([billions('4.0B'), billions('596.05M'), billions('1.5B'), billions(undefined)]).toEqual([
      4, 0.59605, 1.5, 0,
    ]);
    expect(
      tagsFrom({
        models: [{ name: 'a:latest', digest: 'd1', details: { parameter_size: '4B' } }, { model: 'b' }, null],
      }),
    ).toEqual([
      { name: 'a:latest', digest: 'd1', parameterSize: '4B' },
      { name: 'b', digest: undefined, parameterSize: undefined },
    ]);
    expect(() => tagsFrom({ data: [] })).toThrow(/unexpected model list/);
  });

  it("leaves out Ollama's cloud models, which don't run on the Mac", () => {
    expect(
      tagsFrom({
        models: [
          { name: 'oreo-4b:latest' },
          { name: 'gemma4:31b-cloud' },
          { name: 'gpt-oss:120b-cloud', remote_model: 'gpt-oss:120b', remote_host: 'https://ollama.com:443' },
          { name: 'renamed', remote_host: 'https://ollama.com:443' },
          { name: 'qwen3-coder:cloud' },
        ],
      }).map((t) => t.name),
    ).toEqual(['oreo-4b:latest']);
  });

  it('picks the largest model with tools by default, and the smallest coder for completion', async () => {
    const { fetchImpl } = fakeOllama(Object.keys(SHOW));
    const models = await new OllamaClient(ollama, fetchImpl).listModels();
    expect(defaultModel(models)?.id).toBe('gpt-oss:20b');
    expect(defaultModel(models.filter((m) => m.id !== 'gpt-oss:20b'))?.id).toBe('qwen3.5:4b');
    expect(defaultModel(models.filter((m) => !m.supportsTools))?.id).toBe('qwen3.5:2b');
    expect(completionModel(models)?.id).toBe('qwen2.5-coder:1.5b-base');
    expect(completionModel(models.filter((m) => !m.completion))).toBeUndefined();
  });
});

describe('the Mac as it is', () => {
  it('lists the local models from `ollama list`, picks a 4B with tools and a 1.5B coder, and leaves the cloud one out', async () => {
    const qwen4: ShowResponse = { ...SHOW['qwen3.5:4b'], details: { family: 'qwen35', parameter_size: '4.7B' } };
    const qwen2: ShowResponse = { ...SHOW['qwen3.5:2b'], details: { family: 'qwen35', parameter_size: '2.3B' } };
    const coder = SHOW['qwen2.5-coder:1.5b-base'];
    const show: Record<string, ShowResponse> = {
      'oreo-1.5b:latest': { ...coder, parameters: 'num_ctx 8192' },
      'qwen2.5-coder:1.5b-base': coder,
      'oreo-2b:latest': { ...qwen2, parameters: 'num_ctx 32768' },
      'oreo-4b:latest': qwen4,
      'qwen3.5:2b': qwen2,
      'qwen3.5:4b': qwen4,
      'gemma4:31b-cloud': { capabilities: ['completion', 'tools'], details: { parameter_size: '31B' } },
    };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return jsonResponse(200, {
          models: Object.keys(show).map((name) => ({
            name,
            ...(name.endsWith('-cloud') ? { remote_host: 'https://ollama.com:443' } : {}),
          })),
        });
      }
      return jsonResponse(200, show[JSON.parse(String(init?.body)).model as string]);
    }) as typeof fetch;
    const models = await new OllamaClient(ollama, fetchImpl).listModels();
    expect(models.map((m) => m.name)).toEqual([
      'oreo-4b',
      'qwen3.5:4b',
      'oreo-2b',
      'qwen3.5:2b',
      'oreo-1.5b',
      'qwen2.5-coder:1.5b-base',
    ]);
    expect(defaultModel(models)?.name).toBe('oreo-4b');
    expect(completionModel(models)?.sizeB).toBe(1.5);
    expect(models.find((m) => m.name === 'oreo-2b')?.maxPromptChars).toBeGreaterThan(
      models.find((m) => m.name === 'qwen3.5:2b')?.maxPromptChars ?? 0,
    );
  });
});

describe('OllamaClient', () => {
  it('lists the installed models largest first, asking /api/show about each, without any token', async () => {
    const seen: Request[] = [];
    const { fetchImpl, calls } = fakeOllama(['qwen2.5-coder:1.5b-base', 'qwen3.5:4b', 'nomic-embed-text:latest']);
    const client = new OllamaClient(ollama, async (input, init) => {
      seen.push(new Request(input as string, init));
      return fetchImpl(input, init);
    });
    const models = await client.listModels();
    expect(models.map((m) => m.id)).toEqual(['qwen3.5:4b', 'qwen2.5-coder:1.5b-base']);
    expect(calls).toEqual([
      `${ollama}/api/tags`,
      'show qwen2.5-coder:1.5b-base',
      'show qwen3.5:4b',
      'show nomic-embed-text:latest',
    ]);
    expect(seen.every((r) => r.headers.get('authorization') === null)).toBe(true);
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
    const { fetchImpl } = fakeOllama(['qwen3.5:4b'], (u, init) => {
      url = u;
      body = JSON.parse(String(init?.body));
      return sseResponse(['Hel', 'lo']);
    });
    const client = new OllamaClient(ollama, fetchImpl);
    await client.listModels();
    const parts: string[] = [];
    for await (const p of client.streamChat(
      'qwen3.5:4b',
      [{ role: 'user', content: 'hi' }],
      new AbortController().signal,
      'none',
    )) {
      if (p.type === 'text') parts.push(p.text);
    }
    expect(parts.join('')).toBe('Hello');
    expect(url).toBe(`${ollama}/v1/chat/completions`);
    expect(body).toEqual({
      model: 'qwen3.5:4b',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoning_effort: 'none',
      max_tokens: MAX_OUTPUT_TOKENS,
    });
  });

  // Every level goes out unchanged to a model that can think; Ollama turns any level but
  // "none" into thinking on for a model that can only think or not.
  it.each(
    ['qwen3.5:4b', 'gpt-oss:20b'].flatMap((m) =>
      (['none', 'low', 'medium', 'high'] as const).map((e) => [m, e] as const),
    ),
  )('sends %s the effort %s as reasoning_effort', async (model, effort) => {
    let body: { model?: string; reasoning_effort?: string; max_tokens?: number } = {};
    const { fetchImpl } = fakeOllama([model], (_u, init) => {
      body = JSON.parse(String(init?.body));
      return sseResponse(['ok']);
    });
    const client = new OllamaClient(ollama, fetchImpl);
    await client.listModels();
    for await (const _ of client.streamChat(
      model,
      [{ role: 'user', content: 'hi' }],
      new AbortController().signal,
      effort,
    )) {
      // drain
    }
    expect(body).toMatchObject({
      model,
      reasoning_effort: effort,
      max_tokens: effort === 'none' ? MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS * 2,
    });
  });

  it.each(['none', 'high'] as const)(
    'sends a model that cannot think no reasoning_effort, even for %s',
    async (effort) => {
      let body: { reasoning_effort?: string; max_tokens?: number } = {};
      const { fetchImpl } = fakeOllama(['qwen2.5-coder:1.5b-base'], (_u, init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse(['ok']);
      });
      const client = new OllamaClient(ollama, fetchImpl);
      await client.listModels();
      for await (const _ of client.streamChat(
        'qwen2.5-coder:1.5b-base',
        [{ role: 'user', content: 'hi' }],
        new AbortController().signal,
        effort,
      )) {
        // drain
      }
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    },
  );
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

  it('suggests pulling a missing model again or reloading', () => {
    const err = APIError.generate(
      404,
      { error: { message: 'model "oreo-4b" not found, try pulling it first' } },
      undefined,
      new Headers(),
    );
    const text = describeOllamaError(err, ollama, 'oreo-4b');
    expect(text).toMatch(/^oreo-4b isn't in Ollama any more\./);
    expect(text).toContain('ollama pull oreo-4b');
    expect(text).toContain('reload the window');
    expect(describeOllamaError(new OllamaHttpError(404), ollama)).toMatch(/Reload the window/);
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
