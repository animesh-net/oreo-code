import { describe, expect, it } from 'vitest';
import {
  ChatController,
  EMPTY_REPLY,
  fitToContext,
  historyToWire,
  MAX_EARLIER_REPLY_CHARS,
  MAX_TOOL_ROUNDS,
  pickModel,
  type ChatControllerDeps,
} from '../src/chat/chatController';
import type { Workspace } from '../src/agent/workspaceTools';
import type { FunctionTool, ModelClient, StreamEvent, WireMessage } from '../src/ollama/client';
import { OllamaHttpError } from '../src/ollama/errors';
import { cloudModels } from '../src/cloudflare/client';
import { RelayHttpError } from '../src/cloudflare/errors';
import type { ChatMessage, ModelInfo, ToWebview } from '../src/shared/protocol';

const models: ModelInfo[] = [
  {
    id: 'oreo-4b',
    name: 'Oreo 4B',
    provider: 'macbook',
    supportsTools: true,
    thinking: 'switch',
    maxPromptChars: 72_000,
    defaultRank: 1,
    available: true,
  },
  {
    id: 'oreo-2b',
    name: 'Oreo 2B',
    provider: 'macbook',
    supportsTools: false,
    thinking: 'switch',
    maxPromptChars: 72_000,
    defaultRank: 2,
    available: true,
  },
  {
    id: 'oreo-9b',
    name: 'Oreo 9B',
    provider: 'macbook',
    supportsTools: false,
    thinking: 'switch',
    maxPromptChars: 72_000,
    defaultRank: 3,
    available: false,
  },
];

const efforts: string[] = [];

function fakeClient(
  stream: (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<string>,
  list: () => Promise<ModelInfo[]> = async () => models,
): ModelClient {
  return {
    listModels: list,
    streamChat: (_model, messages, signal, effort) => {
      efforts.push(effort);
      const chat = messages.filter((m): m is ChatMessage => m.role === 'user' || m.role === 'assistant');
      return texts(stream(chat, signal));
    },
  };
}

async function* texts(parts: AsyncIterable<string>): AsyncIterable<StreamEvent> {
  for await (const text of parts) yield { type: 'text', text };
}

function setup(client: ModelClient, overrides: Partial<ChatControllerDeps> = {}) {
  const posted: ToWebview[] = [];
  const urls: string[] = [];
  const controller = new ChatController({
    getOllamaUrl: () => 'http://127.0.0.1:11434/',
    getLastModel: () => undefined,
    rememberModel: () => {},
    getEffort: () => undefined,
    rememberEffort: () => {},
    createClient: (url) => {
      urls.push(url);
      return client;
    },
    post: (m) => posted.push(m),
    ...overrides,
  });
  return { controller, posted, urls };
}

async function* chunks(...parts: string[]) {
  for (const p of parts) yield p;
}

describe('ChatController', () => {
  it("finds Ollama on the Mac's Tailscale address when nothing answers on localhost", async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const tried: string[] = [];
    const controller = new ChatController({
      getOllamaUrl: () => 'http://127.0.0.1:11434',
      getLastModel: () => undefined,
      rememberModel: () => {},
      getEffort: () => undefined,
      rememberEffort: () => {},
      createClient: (url) => {
        tried.push(url);
        return fakeClient(
          () => chunks(),
          async () => {
            if (url === 'http://100.100.10.20:11434') return models;
            throw refused;
          },
        );
      },
      fallbackOllamaUrls: () => ['http://100.101.0.9:11434', 'http://100.100.10.20:11434'],
      post: () => {},
    });
    await controller.refresh();
    expect(tried).toEqual(['http://127.0.0.1:11434', 'http://100.101.0.9:11434', 'http://100.100.10.20:11434']);
    expect(controller.state).toMatchObject({
      ollamaUrl: 'http://100.100.10.20:11434',
      selectedModel: 'oreo-4b',
      error: undefined,
    });
  });

  it('keeps the error for the configured URL when no fallback answers', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const { controller } = setup(
      fakeClient(
        () => chunks(),
        async () => {
          throw refused;
        },
      ),
      { fallbackOllamaUrls: () => ['http://100.100.10.20:11434'] },
    );
    await controller.refresh();
    expect(controller.state.ollamaUrl).toBe('http://127.0.0.1:11434');
    expect(controller.state.error).toBe("Can't reach Ollama at http://127.0.0.1:11434. Is it running?");
  });

  it('does not look elsewhere when a non-local URL is set or Ollama answered with an error', async () => {
    let asked = 0;
    const fallbackOllamaUrls = () => {
      asked++;
      return ['http://100.100.10.20:11434'];
    };
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    await setup(
      fakeClient(
        () => chunks(),
        async () => {
          throw refused;
        },
      ),
      { getOllamaUrl: () => 'http://100.64.0.2:11434', fallbackOllamaUrls },
    ).controller.refresh();
    await setup(
      fakeClient(
        () => chunks(),
        async () => {
          throw new OllamaHttpError(500, 'boom');
        },
      ),
      { fallbackOllamaUrls },
    ).controller.refresh();
    expect(asked).toBe(0);
  });

  it('talks to the normalized Ollama URL with no sign-in', async () => {
    const { controller, urls } = setup(fakeClient(() => chunks()));
    await controller.refresh();
    expect(urls).toEqual(['http://127.0.0.1:11434']);
    expect(controller.state).toMatchObject({ ollamaUrl: 'http://127.0.0.1:11434', error: undefined });
  });

  it('loads models and preselects the last dropdown choice', async () => {
    const { controller } = setup(
      fakeClient(() => chunks()),
      { getLastModel: () => 'oreo-2b' },
    );
    await controller.refresh();
    expect(controller.state.selectedModel).toBe('oreo-2b');
    // Largest first as in OREO_MODELS: the two Workers AI models (unusable without a
    // token), then the Mac's; one not in OREO_MODELS goes last.
    expect(controller.state.models.map((m) => [m.id, m.available])).toEqual([
      ['@cf/openai/gpt-oss-120b', false],
      ['@cf/qwen/qwen3-30b-a3b-fp8', false],
      ['oreo-4b', true],
      ['oreo-2b', true],
      ['oreo-9b', false],
    ]);
  });

  it('says Ollama is unreachable in one sentence', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const { controller } = setup(
      fakeClient(
        () => chunks(),
        async () => {
          throw refused;
        },
      ),
    );
    await controller.refresh();
    expect(controller.state.models.every((m) => !m.available)).toBe(true);
    expect(controller.state.error).toBe("Can't reach Ollama at http://127.0.0.1:11434. Is it running?");
  });

  it('explains when Ollama has none of the Oreo models', async () => {
    const { controller } = setup(
      fakeClient(
        () => chunks(),
        async () => models.map((m) => ({ ...m, available: false })),
      ),
    );
    await controller.refresh();
    expect(controller.state.selectedModel).toBeUndefined();
    expect(controller.state.error).toMatch(/none of the Oreo models/);
  });

  it('streams a reply and keeps the finished turn', async () => {
    let sentHistory: ChatMessage[] = [];
    const { controller, posted } = setup(
      fakeClient((messages) => {
        sentHistory = messages;
        return chunks('Hel', 'lo');
      }),
    );
    await controller.refresh();
    await controller.handle({ type: 'send', text: '  hi  ' });
    expect(sentHistory).toEqual([{ role: 'user', content: 'hi' }]);
    expect(posted.filter((m) => m.type === 'delta').map((m) => (m as { text: string }).text)).toEqual(['Hel', 'lo']);
    expect(controller.state).toMatchObject({
      busy: false,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello' },
      ],
    });
  });

  it('drops a failed turn and returns the text to the input', async () => {
    const { controller, posted } = setup(
      fakeClient(async function* () {
        yield 'partial';
        throw new OllamaHttpError(404);
      }),
    );
    await controller.refresh();
    await controller.handle({ type: 'send', text: 'hi' });
    expect(controller.state.messages).toEqual([]);
    expect(controller.state.error).toMatch(/^oreo-4b isn't in Ollama/);
    expect(posted).toContainEqual(expect.objectContaining({ type: 'failed', draft: 'hi' }));
  });

  it('keeps the partial reply when stopped', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { controller } = setup(
      fakeClient(async function* (_messages, signal) {
        yield 'part';
        await gate;
        if (signal.aborted) throw new Error('aborted');
        yield 'never';
      }),
    );
    await controller.refresh();
    const sending = controller.handle({ type: 'send', text: 'hi' });
    await new Promise((r) => setTimeout(r, 0));
    await controller.handle({ type: 'stop' });
    release();
    await sending;
    expect(controller.state.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'part' },
    ]);
  });

  it('first available model is the default when nothing was picked before', async () => {
    const { controller } = setup(fakeClient(() => chunks()));
    await controller.refresh();
    expect(controller.state.selectedModel).toBe('oreo-4b');
  });

  it('refuses to select an unavailable model and remembers valid picks', async () => {
    const remembered: string[] = [];
    const { controller } = setup(
      fakeClient(() => chunks()),
      { rememberModel: (id) => remembered.push(id) },
    );
    await controller.refresh();
    await controller.handle({ type: 'selectModel', modelId: 'oreo-9b' });
    expect(controller.state.selectedModel).toBe('oreo-4b');
    await controller.handle({ type: 'selectModel', modelId: 'oreo-2b' });
    expect(controller.state.selectedModel).toBe('oreo-2b');
    expect(remembered).toEqual(['oreo-2b']);
  });

  it('ignores empty sends', async () => {
    let calls = 0;
    const { controller } = setup(
      fakeClient(() => {
        calls++;
        return chunks('ok');
      }),
    );
    await controller.refresh();
    await controller.handle({ type: 'send', text: '   ' });
    expect(calls).toBe(0);
  });

  it('reports a bad Ollama URL without calling Ollama', async () => {
    const { controller, urls } = setup(
      fakeClient(() => chunks()),
      { getOllamaUrl: () => 'ftp://x' },
    );
    await controller.refresh();
    expect(urls).toEqual([]);
    expect(controller.state.error).toMatch(/http:\/\//);
  });
});

describe('thinking effort', () => {
  it('defaults to none and goes with each request', async () => {
    efforts.length = 0;
    const { controller } = setup(fakeClient(() => chunks('ok')));
    await controller.refresh();
    expect(controller.state.effort).toBe('none');
    await controller.handle({ type: 'send', text: 'hi' });
    expect(efforts).toEqual(['none']);
  });

  it('remembers your pick, uses it for every model and ignores unknown values', async () => {
    efforts.length = 0;
    let saved: string | undefined = 'medium';
    const { controller } = setup(
      fakeClient(() => chunks('ok')),
      {
        getEffort: () => saved as never,
        rememberEffort: (effort) => (saved = effort),
      },
    );
    await controller.refresh();
    expect(controller.state.effort).toBe('medium');

    await controller.handle({ type: 'selectEffort', effort: 'high' });
    expect(saved).toBe('high');
    await controller.handle({ type: 'selectModel', modelId: 'oreo-2b' });
    expect(controller.state.effort).toBe('high');
    await controller.handle({ type: 'send', text: 'hi' });
    expect(efforts).toEqual(['high']);

    await controller.handle({ type: 'selectEffort', effort: 'extreme' as never });
    expect(controller.state.effort).toBe('high');
  });

  it('falls back to none if a stored value is no longer valid', async () => {
    const { controller } = setup(
      fakeClient(() => chunks()),
      { getEffort: () => 'extreme' as never },
    );
    await controller.refresh();
    expect(controller.state.effort).toBe('none');
  });
});

describe('pickModel', () => {
  it('keeps the current model, then the preferred one, then the first', () => {
    expect(pickModel(models, 'oreo-2b', 'oreo-4b')).toBe('oreo-2b');
    expect(pickModel(models, 'gone', 'oreo-2b')).toBe('oreo-2b');
    expect(pickModel(models, undefined, 'missing')).toBe('oreo-4b');
    expect(pickModel([], undefined, undefined)).toBeUndefined();
  });

  it('never picks a model without a rank for you, but keeps one you chose', () => {
    const coder: ModelInfo = { ...models[1], id: 'oreo-1.5b', name: 'Oreo 1.5B', thinking: 'none' };
    delete coder.defaultRank;
    const ranked = [{ ...models[0], available: false }, coder, { ...models[1], available: false }];
    expect(pickModel(ranked, undefined, undefined)).toBeUndefined();
    expect(pickModel(ranked, undefined, 'oreo-1.5b')).toBe('oreo-1.5b');
  });

  it('picks by rank, not by where a model sits in the list', () => {
    expect(pickModel([models[1], models[0]], undefined, undefined)).toBe('oreo-4b');
  });

  it('skips models Ollama does not have', () => {
    expect(pickModel(models, 'oreo-9b', 'oreo-9b')).toBe('oreo-4b');
    expect(pickModel(models, undefined, 'oreo-2b')).toBe('oreo-2b');
  });
});

describe('repo context and tools', () => {
  const ws: Workspace = {
    name: 'oreo-code',
    listFiles: async () => ['src/a.ts'],
    readFile: async () => 'export const a = 1;',
    branch: async () => 'main',
    activeFile: () => undefined,
  };

  /** Plays one scripted round per call and records what each request carried. */
  function scripted(rounds: (n: number) => StreamEvent[]) {
    const requests: { messages: WireMessage[]; tools?: FunctionTool[] }[] = [];
    const client: ModelClient = {
      listModels: async () => models,
      async *streamChat(_model, messages, _signal, _effort, tools) {
        requests.push({ messages: [...messages], tools });
        for (const e of rounds(requests.length)) yield e;
      },
    };
    return { client, requests };
  }

  const readCall: StreamEvent = {
    type: 'toolCalls',
    calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }],
  };

  it('sends the repo snapshot and lets Oreo 4B read files before it answers', async () => {
    const { client, requests } = scripted((n) => (n === 1 ? [readCall] : [{ type: 'text', text: 'a is 1.' }]));
    const { controller, posted } = setup(client, { getWorkspace: () => ws });
    await controller.refresh();
    await controller.handle({ type: 'send', text: 'What is a?' });

    expect(requests).toHaveLength(2);
    const system = requests[0].messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('repository "oreo-code" on branch main');
    expect(requests[0].tools?.map((t) => t.function.name)).toEqual(['list_files', 'read_file', 'search']);
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(requests[1].messages.at(-1)?.content).toContain('1: export const a = 1;');
    expect(posted).toContainEqual({ type: 'activity', text: 'Read src/a.ts' });
    expect(controller.state.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'a is 1.',
      activity: ['Read src/a.ts'],
    });
  });

  it('gives Oreo 2B the snapshot but no tools', async () => {
    const { client, requests } = scripted(() => [{ type: 'text', text: 'ok' }]);
    const { controller } = setup(client, { getWorkspace: () => ws, getLastModel: () => 'oreo-2b' });
    await controller.refresh();
    await controller.handle({ type: 'send', text: 'hi' });
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].messages[0].content).toContain("You can't open files");
  });

  it(`stops offering tools after ${MAX_TOOL_ROUNDS} rounds so the model must answer`, async () => {
    const { client, requests } = scripted((n) => (n < MAX_TOOL_ROUNDS ? [readCall] : [{ type: 'text', text: 'done' }]));
    const { controller } = setup(client, { getWorkspace: () => ws });
    await controller.refresh();
    await controller.handle({ type: 'send', text: 'hi' });
    expect(requests).toHaveLength(MAX_TOOL_ROUNDS);
    expect(requests.at(-1)?.tools).toBeUndefined();
    expect(controller.state.messages.at(-1)?.content).toBe('done');
  });
});

describe('empty replies, thinking and the context window', () => {
  const ws: Workspace = {
    name: 'r',
    listFiles: async () => ['a.ts'],
    readFile: async () => 'x',
    branch: async () => undefined,
    activeFile: () => undefined,
  };

  function scriptedClient(rounds: (n: number, effort: string) => StreamEvent[]) {
    const efforts: string[] = [];
    const client: ModelClient = {
      listModels: async () => models,
      async *streamChat(_m, _msgs, _s, effort) {
        efforts.push(effort);
        for (const e of rounds(efforts.length, effort)) yield e;
      },
    };
    return { client, efforts };
  }

  it('asks once more, without thinking, when a reply ends empty', async () => {
    const { client, efforts } = scriptedClient((n) =>
      n === 1 ? [{ type: 'thinking' }] : [{ type: 'text', text: 'Found it.' }],
    );
    const { controller, posted } = setup(client, { getWorkspace: () => ws, getEffort: () => 'medium' });
    await controller.refresh();
    await controller.handle({ type: 'send', text: 'bugs?' });
    expect(efforts).toEqual(['medium', 'none']);
    expect(posted).toContainEqual({ type: 'thinking' });
    expect(controller.state.messages.at(-1)).toEqual({ role: 'assistant', content: 'Found it.' });
  });

  it('fails the turn and gives the text back when the reply is still empty', async () => {
    const { client } = scriptedClient(() => []);
    const { controller, posted } = setup(client, { getWorkspace: () => ws });
    await controller.refresh();
    await controller.handle({ type: 'send', text: 'bugs?' });
    expect(controller.state.messages).toEqual([]);
    expect(controller.state.error).toBe(EMPTY_REPLY);
    expect(posted).toContainEqual({ type: 'failed', message: EMPTY_REPLY, draft: 'bugs?' });
  });

  it('drops the oldest turns, then old tool results, but keeps the system prompt and the question', () => {
    const wire: WireMessage[] = [
      { role: 'system', content: 's'.repeat(10) },
      { role: 'user', content: 'old'.repeat(10) },
      { role: 'assistant', content: 'old answer'.repeat(10) },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [] },
      { role: 'tool', tool_call_id: 'c', content: 't'.repeat(100) },
    ];
    const question = fitToContext(wire, 3, 60);
    expect(question).toBe(1);
    expect(wire.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(wire[1].content).toBe('q');
    expect(wire[3].content).toBe('(Removed to fit the context window.)');
  });

  it('shortens earlier answers but sends the latest answer and every question whole', () => {
    const long = (c: string) => c.repeat(MAX_EARLIER_REPLY_CHARS + 500);
    const wire = historyToWire([
      { role: 'user', content: long('a') },
      { role: 'assistant', content: long('b') },
      { role: 'user', content: 'and?' },
      { role: 'assistant', content: 'short' },
      { role: 'user', content: 'more?' },
      { role: 'assistant', content: long('c') },
      { role: 'user', content: 'last' },
    ]);
    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(wire[0].content).toBe(long('a'));
    expect(wire[1].content).toBe(`${'b'.repeat(MAX_EARLIER_REPLY_CHARS)}\n… (earlier answer shortened)`);
    expect(wire[3].content).toBe('short');
    expect(wire[5].content).toBe(long('c'));
    expect(wire[6].content).toBe('last');
  });

  it('sends earlier answers shortened with the next question', async () => {
    const long = 'x'.repeat(MAX_EARLIER_REPLY_CHARS * 2);
    const seen: ChatMessage[][] = [];
    const answers = [long, 'second', 'third'];
    const { controller } = setup(
      fakeClient(async function* (messages) {
        seen.push(messages);
        yield answers[seen.length - 1];
      }),
    );
    await controller.refresh();
    await controller.handle({ type: 'send', text: 'one' });
    await controller.handle({ type: 'send', text: 'two' });
    await controller.handle({ type: 'send', text: 'three' });
    expect(seen[1][1].content).toBe(long);
    expect(seen[2][1].content).toHaveLength(MAX_EARLIER_REPLY_CHARS + '\n… (earlier answer shortened)'.length);
    expect(seen[2].at(-1)).toEqual({ role: 'user', content: 'three' });
    expect(controller.state.messages[1].content).toBe(long);
  });

  it('leaves a prompt that fits alone', () => {
    const wire: WireMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'q' },
    ];
    expect(fitToContext(wire, 1)).toBe(1);
    expect(wire).toHaveLength(2);
  });
});

describe('Cloudflare models', () => {
  const RELAY = 'https://ai.animesh.org.in/v1';
  const QWEN = '@cf/qwen/qwen3-30b-a3b-fp8';
  const GPT = '@cf/openai/gpt-oss-120b';
  const cloudList =
    (...listed: string[]) =>
    async (): Promise<ModelInfo[]> =>
      cloudModels(new Set(listed));

  function cloudClient(list: () => Promise<ModelInfo[]> = cloudList(QWEN, GPT)) {
    const calls: string[] = [];
    const client: ModelClient = {
      listModels: list,
      async *streamChat(model) {
        calls.push(model);
        yield { type: 'text', text: 'from the cloud' };
      },
    };
    return { client, calls };
  }

  function relay(client: ModelClient, url = `${RELAY}/`) {
    const urls: string[] = [];
    return {
      urls,
      deps: {
        getCloudUrl: () => url,
        createCloudClient: (u: string) => {
          urls.push(u);
          return client;
        },
      } satisfies Partial<ChatControllerDeps>,
    };
  }

  const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

  it("lists the models oreo-ai's relay offers as usable and sends to the cloud client", async () => {
    const cloud = cloudClient();
    const r = relay(cloud.client);
    const { controller } = setup(
      fakeClient(() => chunks('from the Mac')),
      { ...r.deps, getLastModel: () => GPT },
    );
    await controller.refresh();
    expect(r.urls).toEqual([RELAY]);
    expect(controller.state.selectedModel).toBe(GPT);
    await controller.handle({ type: 'send', text: 'hi' });
    expect(cloud.calls).toEqual([GPT]);
    expect(controller.state.messages.at(-1)?.content).toBe('from the cloud');
  });

  it('greys out a cloud model the relay leaves out', async () => {
    const { controller } = setup(
      fakeClient(() => chunks()),
      relay(cloudClient(cloudList(GPT)).client).deps,
    );
    await controller.refresh();
    const cloud = controller.state.models.filter((m) => m.provider === 'cloudflare');
    expect(cloud.map((m) => [m.id, m.available])).toEqual([
      [GPT, true],
      [QWEN, false],
    ]);
  });

  it.each([
    ['unreachable', refused],
    ['without Cloudflare (503)', () => new RelayHttpError(503, 'Cloudflare is not configured.')],
  ])('keeps the Mac models working when the relay is %s', async (_name, failure) => {
    const cloud = cloudClient(async () => {
      throw failure();
    });
    const { controller } = setup(
      fakeClient(() => chunks()),
      relay(cloud.client).deps,
    );
    await controller.refresh();
    expect(controller.state.error).toBeUndefined();
    expect(controller.state.selectedModel).toBe('oreo-4b');
    expect(controller.state.models.filter((m) => m.provider === 'cloudflare').map((m) => m.available)).toEqual([
      false,
      false,
    ]);
  });

  it('offers no cloud model and calls no relay when oreo.cloudUrl is empty', async () => {
    const r = relay(cloudClient().client, '  ');
    const { controller } = setup(
      fakeClient(() => chunks()),
      r.deps,
    );
    await controller.refresh();
    expect(r.urls).toEqual([]);
    expect(controller.state.models.filter((m) => m.provider === 'cloudflare').every((m) => !m.available)).toBe(true);
  });

  it('greys out the cloud models for an invalid oreo.cloudUrl', async () => {
    const r = relay(cloudClient().client, 'ftp://ai.animesh.org.in');
    const { controller } = setup(
      fakeClient(() => chunks()),
      r.deps,
    );
    await controller.refresh();
    expect(r.urls).toEqual([]);
    expect(controller.state.error).toBeUndefined();
    expect(controller.state.models.filter((m) => m.provider === 'cloudflare').every((m) => !m.available)).toBe(true);
  });

  it('still works through the relay when Ollama is down, with no error shown', async () => {
    const cloud = cloudClient();
    const { controller } = setup(
      fakeClient(
        () => chunks(),
        async () => {
          throw refused();
        },
      ),
      relay(cloud.client).deps,
    );
    await controller.refresh();
    expect(controller.state.error).toBeUndefined();
    expect(controller.state.selectedModel).toBe(QWEN);
    expect(controller.state.models.filter((m) => m.available).map((m) => m.provider)).toEqual([
      'cloudflare',
      'cloudflare',
    ]);
  });

  it('shows the Ollama problem when neither Ollama nor the relay answers', async () => {
    const { controller } = setup(
      fakeClient(
        () => chunks(),
        async () => {
          throw refused();
        },
      ),
      relay(
        cloudClient(async () => {
          throw refused();
        }).client,
      ).deps,
    );
    await controller.refresh();
    expect(controller.state.selectedModel).toBeUndefined();
    expect(controller.state.error).toMatch(/Can't reach Ollama/);
  });

  it('words a relay failure as oreo-ai, not Ollama', async () => {
    const client: ModelClient = {
      listModels: cloudList(QWEN, GPT),
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw refused();
      },
    };
    const { controller } = setup(
      fakeClient(() => chunks()),
      { ...relay(client).deps, getLastModel: () => QWEN },
    );
    await controller.refresh();
    await controller.handle({ type: 'send', text: 'hi' });
    expect(controller.state.error).toBe(`Can't reach oreo-ai at ${RELAY}. Is the Mac on Tailscale?`);
  });
});
