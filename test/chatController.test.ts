import { describe, expect, it } from 'vitest';
import { ChatController, pickModel, type ChatControllerDeps } from '../src/chat/chatController';
import type { ModelClient } from '../src/ollama/client';
import { OllamaHttpError } from '../src/ollama/errors';
import type { ChatMessage, ModelInfo, ToWebview } from '../src/shared/protocol';

const models: ModelInfo[] = [
  { id: 'oreo-4b', name: 'Oreo 4B', provider: 'macbook', supportsTools: true, thinking: 'switch', available: true },
  { id: 'oreo-2b', name: 'Oreo 2B', provider: 'macbook', supportsTools: false, thinking: 'switch', available: true },
  { id: 'oreo-9b', name: 'Oreo 9B', provider: 'macbook', supportsTools: false, thinking: 'switch', available: false },
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
      return stream(messages, signal);
    },
  };
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
    expect(controller.state.models).toHaveLength(3);
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
    expect(controller.state.models).toEqual([]);
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

  it('skips models Ollama does not have', () => {
    expect(pickModel(models, 'oreo-9b', 'oreo-9b')).toBe('oreo-4b');
    expect(pickModel(models, undefined, 'oreo-2b')).toBe('oreo-2b');
  });
});
