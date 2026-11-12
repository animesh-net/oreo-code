import { ChatController } from '../../src/chat/chatController';
import type { ModelClient } from '../../src/ollama/client';
import type { AgentStep, ChatMessage, ToWebview } from '../../src/shared/protocol';
import type { DiskWorkspace } from './diskWorkspace';

export interface TaskRun {
  reply: string;
  steps: AgentStep[];
  /** Titles of the approval cards, all answered Approve. */
  approvals: string[];
  error: string | undefined;
  controller: ChatController;
}

/**
 * Runs one agent task through the real ChatController, as the extension does, in a
 * disk workspace: agent mode and Auto-edit on, every card approved (the folder is a
 * throwaway copy). `client` is a real model client (the eval) or a scripted one.
 */
export async function runTask(opts: {
  ws: DiskWorkspace;
  /** A client, or how to make one for an Ollama address (the eval, which may try several). */
  client: ModelClient | ((ollamaUrl: string) => ModelClient);
  /** Addresses to try when nothing answers at ollamaUrl, as the extension does (Tailscale). */
  fallbackOllamaUrls?: (ollamaUrl: string) => string[];
  modelId: string;
  task: string;
  ollamaUrl?: string;
}): Promise<TaskRun> {
  const posted: ToWebview[] = [];
  const controller = new ChatController({
    getOllamaUrl: () => opts.ollamaUrl ?? 'http://127.0.0.1:11434',
    getLastModel: () => opts.modelId,
    rememberModel: () => {},
    getEffort: () => undefined,
    rememberEffort: () => {},
    getAgentSettings: () => ({ agentMode: true, approveEdits: true }),
    createClient: (url) => (typeof opts.client === 'function' ? opts.client(url) : opts.client),
    ...(opts.fallbackOllamaUrls ? { fallbackOllamaUrls: opts.fallbackOllamaUrls } : {}),
    getWorkspace: () => opts.ws,
    getWritableWorkspace: () => opts.ws,
    post: (m) => posted.push(m),
  });
  await controller.refresh();
  await controller.handle({ type: 'selectModel', modelId: opts.modelId });
  if (controller.state.selectedModel !== opts.modelId) {
    throw new Error(`${opts.modelId} isn't available: ${controller.state.error ?? 'not in the model list'}`);
  }

  const approvals: string[] = [];
  let done = false;
  const sending = controller.handle({ type: 'send', text: opts.task }).finally(() => (done = true));
  while (!done) {
    const card = controller.state.approval;
    if (card) {
      approvals.push(card.title);
      await controller.handle({ type: 'approval', id: card.id, approved: true });
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  await sending;
  const last = controller.state.messages.at(-1) as ChatMessage | undefined;
  return {
    reply: last?.role === 'assistant' ? last.content : '',
    steps: last?.steps ?? [],
    approvals,
    error: controller.state.error,
    controller,
  };
}
