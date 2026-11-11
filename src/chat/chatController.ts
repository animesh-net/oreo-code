import type { ModelClient } from '../ollama/client';
import { describeOllamaError, isUnreachable } from '../ollama/errors';
import { isLoopbackUrl, normalizeOllamaUrl } from '../ollama/url';
import {
  DEFAULT_EFFORT,
  REASONING_EFFORTS,
  type ChatMessage,
  type FromWebview,
  type ModelInfo,
  type ReasoningEffort,
  type ToWebview,
  type ViewState,
} from '../shared/protocol';

export interface ChatControllerDeps {
  /** Raw "oreo.ollamaUrl" setting. */
  getOllamaUrl(): string;
  /** The model picked last time in the dropdown, if any. */
  getLastModel(): string | undefined;
  /** Remembers the dropdown choice for next time. */
  rememberModel(modelId: string): void;
  /** The thinking effort picked last time, if any. */
  getEffort(): ReasoningEffort | undefined;
  /** Remembers the thinking effort picked in the dropdown. */
  rememberEffort(effort: ReasoningEffort): void;
  createClient(ollamaUrl: string): ModelClient;
  /**
   * Other addresses to try when nothing answers at a local URL (127.0.0.1 or
   * localhost): the Mac's Tailscale addresses, where oreo-ai's script binds Ollama.
   */
  fallbackOllamaUrls?(ollamaUrl: string): string[];
  /** Sends a message to the webview (a no-op while the view is closed). */
  post(message: ToWebview): void;
  /** Called after every state change, e.g. to update the status bar. */
  onState?(state: ViewState): void;
}

/**
 * Owns the chat: the Ollama connection, the model list and the conversation.
 * Free of `vscode` imports so it can be unit tested.
 *
 * A turn is kept only if it finished or you stopped it; a failed turn is
 * removed and its text goes back into the input box.
 */
export class ChatController {
  private ollamaUrl = '';
  private client: ModelClient | undefined;
  private models: ModelInfo[] = [];
  private selectedModel: string | undefined;
  private messages: ChatMessage[] = [];
  private busy = false;
  private error: string | undefined;
  private abort: AbortController | undefined;
  private refreshSeq = 0;

  constructor(private readonly deps: ChatControllerDeps) {}

  /** Re-reads the Ollama URL setting, then reloads the model list. */
  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    this.error = undefined;
    this.client = undefined;
    this.models = [];
    try {
      this.ollamaUrl = normalizeOllamaUrl(this.deps.getOllamaUrl());
    } catch (err) {
      this.ollamaUrl = this.deps.getOllamaUrl();
      this.error = (err as Error).message;
      this.publish();
      return;
    }
    const client = this.deps.createClient(this.ollamaUrl);
    this.client = client;
    this.publish();
    try {
      const models = await client.listModels();
      if (seq !== this.refreshSeq) return;
      this.models = models;
      this.selectedModel = pickModel(models, this.selectedModel, this.deps.getLastModel());
      if (!this.selectedModel) {
        this.error = `Ollama at ${this.ollamaUrl} has none of the Oreo models. Create them from oreo-ai's Modelfiles.`;
      }
    } catch (err) {
      if (seq !== this.refreshSeq) return;
      if (!(isUnreachable(err) && (await this.tryFallbacks(seq)))) {
        if (seq !== this.refreshSeq) return;
        this.error = describeOllamaError(err, this.ollamaUrl);
      }
    }
    if (seq !== this.refreshSeq) return;
    this.publish();
  }

  /** Looks for Ollama at the fallback addresses; uses the first that answers. */
  private async tryFallbacks(seq: number): Promise<boolean> {
    if (!isLoopbackUrl(this.ollamaUrl)) return false;
    for (const url of this.deps.fallbackOllamaUrls?.(this.ollamaUrl) ?? []) {
      const client = this.deps.createClient(url);
      try {
        const models = await client.listModels();
        if (seq !== this.refreshSeq) return true;
        this.ollamaUrl = url;
        this.client = client;
        this.models = models;
        this.selectedModel = pickModel(models, this.selectedModel, this.deps.getLastModel());
        if (!this.selectedModel) {
          this.error = `Ollama at ${this.ollamaUrl} has none of the Oreo models. Create them from oreo-ai's Modelfiles.`;
        }
        return true;
      } catch {
        // Not there either; try the next one.
      }
    }
    return false;
  }

  async handle(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.publish();
        return;
      case 'send':
        await this.send(message.text);
        return;
      case 'stop':
        this.abort?.abort();
        return;
      case 'selectModel':
        if (this.models.some((m) => m.id === message.modelId && m.available)) {
          this.selectedModel = message.modelId;
          this.deps.rememberModel(message.modelId);
          this.publish();
        }
        return;
      case 'selectEffort':
        if (REASONING_EFFORTS.includes(message.effort)) {
          this.deps.rememberEffort(message.effort);
          this.publish();
        }
        return;
      case 'newChat':
        this.newChat();
        return;
      case 'retry':
        await this.refresh();
        return;
    }
  }

  newChat(): void {
    this.abort?.abort();
    this.messages = [];
    this.error = undefined;
    this.publish();
  }

  get state(): ViewState {
    return {
      ollamaUrl: this.ollamaUrl,
      models: this.models,
      selectedModel: this.selectedModel,
      effort: this.effort,
      messages: [...this.messages],
      busy: this.busy,
      error: this.error,
    };
  }

  /** Your last pick, or the default. */
  private get effort(): ReasoningEffort {
    const saved = this.deps.getEffort();
    return saved && REASONING_EFFORTS.includes(saved) ? saved : DEFAULT_EFFORT;
  }

  private async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    const client = this.client;
    const model = this.selectedModel;
    if (!text || this.busy || !client || !model) return;

    const turnStart = this.messages.length;
    this.messages.push({ role: 'user', content: text });
    const history = [...this.messages];
    this.busy = true;
    this.error = undefined;
    const abort = new AbortController();
    this.abort = abort;
    this.publish();

    let reply = '';
    try {
      for await (const delta of client.streamChat(model, history, abort.signal, this.effort)) {
        reply += delta;
        this.deps.post({ type: 'delta', text: delta });
      }
      this.messages.push({ role: 'assistant', content: reply });
    } catch (err) {
      if (abort.signal.aborted) {
        // You pressed Stop: keep what arrived, if anything.
        if (reply) this.messages.push({ role: 'assistant', content: reply });
        else this.messages.splice(turnStart);
      } else {
        this.messages.splice(turnStart);
        const message = describeOllamaError(err, this.ollamaUrl, model);
        this.error = message;
        this.deps.post({ type: 'failed', message, draft: text });
      }
    } finally {
      this.busy = false;
      if (this.abort === abort) this.abort = undefined;
      this.publish();
    }
  }

  private publish(): void {
    const state = this.state;
    this.deps.post({ type: 'state', state });
    this.deps.onState?.(state);
  }
}

/**
 * Keeps the current choice if still available, else the last dropdown choice,
 * else the first available model (the default is listed first).
 * Models Ollama doesn't have are skipped.
 */
export function pickModel(
  models: ModelInfo[],
  current: string | undefined,
  preferred: string | undefined,
): string | undefined {
  const usable = models.filter((m) => m.available);
  if (current && usable.some((m) => m.id === current)) return current;
  if (preferred && usable.some((m) => m.id === preferred)) return preferred;
  return usable[0]?.id;
}
