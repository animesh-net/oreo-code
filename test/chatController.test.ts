import { describe, expect, it } from 'vitest';
import { ChatController, pickModel, type ChatControllerDeps } from '../src/chat/chatController';
import type { Gateway } from '../src/gateway/client';
import { GatewayHttpError } from '../src/gateway/errors';
import type { ChatMessage, ModelInfo, ToWebview } from '../src/shared/protocol';

const models: ModelInfo[] = [
  { id: 'gpt-oss-120b', name: 'GPT OSS 120B', provider: 'cloudflare', supportsTools: true, available: true },
  { id: 'qwen3', name: 'Qwen3 30B', provider: 'cloudflare', supportsTools: false, available: true },
  { id: 'oreo-4b', name: 'Oreo 4B', provider: 'macbook', supportsTools: false, available: true },
  { id: 'oreo-2b', name: 'Oreo 2B', provider: 'macbook', supportsTools: false, available: false },
];

function fakeGateway(stream: (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<string>): Gateway {
  return {
    listModels: async () => models,
    streamChat: (_model, messages, signal) => stream(messages, signal),
  };
}

function setup(gateway: Gateway, token: string | null = 'oreo_t', overrides: Partial<ChatControllerDeps> = {}) {
  const posted: ToWebview[] = [];
  const controller = new ChatController({
    getServerUrl: () => 'https://oreo.test/',
    getLastModel: () => undefined,
    rememberModel: () => {},
    getToken: async () => token ?? undefined,
    createGateway: () => gateway,
    post: (m) => posted.push(m),
    signIn: async () => {},
    ...overrides,
  });
  return { controller, posted };
}

async function* chunks(...parts: string[]) {
  for (const p of parts) yield p;
}

describe('ChatController', () => {
  it('shows signed out without a token', async () => {
    const { controller } = setup(
      fakeGateway(() => chunks()),
      null,
    );
    await controller.refresh();
    expect(controller.state).toMatchObject({ signedIn: false, serverUrl: 'https://oreo.test' });
  });

  it('loads models and preselects the last dropdown choice', async () => {
    const { controller } = setup(
      fakeGateway(() => chunks()),
      'oreo_t',
      { getLastModel: () => 'qwen3' },
    );
    await controller.refresh();
    expect(controller.state).toMatchObject({ signedIn: true, selectedModel: 'qwen3' });
    expect(controller.state.models).toHaveLength(4);
  });

  it('streams a reply and keeps the finished turn', async () => {
    let sentHistory: ChatMessage[] = [];
    const { controller, posted } = setup(
      fakeGateway((messages) => {
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
      fakeGateway(async function* () {
        yield 'partial';
        throw new GatewayHttpError(429);
      }),
    );
    await controller.refresh();
    await controller.handle({ type: 'send', text: 'hi' });
    expect(controller.state.messages).toEqual([]);
    expect(controller.state.error).toMatch(/limit/);
    expect(posted).toContainEqual(expect.objectContaining({ type: 'failed', draft: 'hi' }));
  });

  it('keeps the partial reply when stopped', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { controller } = setup(
      fakeGateway(async function* (_messages, signal) {
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
    const { controller } = setup(fakeGateway(() => chunks()));
    await controller.refresh();
    expect(controller.state.selectedModel).toBe('gpt-oss-120b');
  });

  it('refuses to select an unavailable model and remembers valid picks', async () => {
    const remembered: string[] = [];
    const { controller } = setup(
      fakeGateway(() => chunks()),
      'oreo_t',
      { rememberModel: (id) => remembered.push(id) },
    );
    await controller.refresh();
    await controller.handle({ type: 'selectModel', modelId: 'oreo-2b' });
    expect(controller.state.selectedModel).toBe('gpt-oss-120b');
    await controller.handle({ type: 'selectModel', modelId: 'oreo-4b' });
    expect(controller.state.selectedModel).toBe('oreo-4b');
    expect(remembered).toEqual(['oreo-4b']);
  });

  it('ignores empty sends', async () => {
    let calls = 0;
    const { controller } = setup(
      fakeGateway(() => {
        calls++;
        return chunks('ok');
      }),
    );
    await controller.refresh();
    await controller.handle({ type: 'send', text: '   ' });
    expect(calls).toBe(0);
  });

  it('reports a bad server URL without calling the gateway', async () => {
    const { controller } = setup(
      fakeGateway(() => chunks()),
      'oreo_t',
      { getServerUrl: () => 'ftp://x' },
    );
    await controller.refresh();
    expect(controller.state).toMatchObject({ signedIn: false });
    expect(controller.state.error).toMatch(/https:\/\//);
  });
});

describe('pickModel', () => {
  it('keeps the current model, then the preferred one, then the first', () => {
    expect(pickModel(models, 'qwen3', 'gpt-oss-120b')).toBe('qwen3');
    expect(pickModel(models, 'gone', 'qwen3')).toBe('qwen3');
    expect(pickModel(models, undefined, 'missing')).toBe('gpt-oss-120b');
    expect(pickModel([], undefined, undefined)).toBeUndefined();
  });

  it('skips unavailable models, e.g. when the MacBook is asleep', () => {
    expect(pickModel(models, 'oreo-2b', 'oreo-2b')).toBe('gpt-oss-120b');
    expect(pickModel(models, undefined, 'oreo-4b')).toBe('oreo-4b');
  });
});
