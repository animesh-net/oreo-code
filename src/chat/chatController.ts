import type { Gateway } from '../gateway/client';
import { describeGatewayError } from '../gateway/errors';
import { normalizeServerUrl } from '../gateway/serverUrl';
import type { ChatMessage, FromWebview, ModelInfo, ToWebview, ViewState } from '../shared/protocol';

export interface ChatControllerDeps {
  /** Raw "oreo.serverUrl" setting. */
  getServerUrl(): string;
  /** The model picked last time in the dropdown, if any. */
  getLastModel(): string | undefined;
  /** Remembers the dropdown choice for next time. */
  rememberModel(modelId: string): void;
  getToken(): Promise<string | undefined>;
  createGateway(serverUrl: string, token: string): Gateway;
  /** Sends a message to the webview (a no-op while the view is closed). */
  post(message: ToWebview): void;
  /** Runs the "Oreo: Sign in" flow. */
  signIn(): Promise<void>;
  /** Called after every state change, e.g. to update the status bar. */
  onState?(state: ViewState): void;
}

/**
 * Owns the chat: sign-in state, the model list and the conversation.
 * Free of `vscode` imports so it can be unit tested.
 *
 * A turn is kept only if it finished or you stopped it; a failed turn is
 * removed and its text goes back into the input box.
 */
export class ChatController {
  private serverUrl = '';
  private gateway: Gateway | undefined;
  private models: ModelInfo[] = [];
  private selectedModel: string | undefined;
  private messages: ChatMessage[] = [];
  private busy = false;
  private error: string | undefined;
  private abort: AbortController | undefined;
  private refreshSeq = 0;

  constructor(private readonly deps: ChatControllerDeps) {}

  /** Re-reads settings and token, then reloads the model list. */
  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    this.error = undefined;
    this.gateway = undefined;
    this.models = [];
    try {
      this.serverUrl = normalizeServerUrl(this.deps.getServerUrl());
    } catch (err) {
      this.serverUrl = this.deps.getServerUrl();
      this.error = (err as Error).message;
      this.publish();
      return;
    }
    const token = await this.deps.getToken();
    if (seq !== this.refreshSeq) return;
    if (!token) {
      this.publish();
      return;
    }
    const gateway = this.deps.createGateway(this.serverUrl, token);
    this.gateway = gateway;
    this.publish();
    try {
      const models = await gateway.listModels();
      if (seq !== this.refreshSeq) return;
      this.models = models;
      this.selectedModel = pickModel(models, this.selectedModel, this.deps.getLastModel());
      if (models.length === 0) this.error = 'oreo-ai has no models for your account.';
    } catch (err) {
      if (seq !== this.refreshSeq) return;
      this.error = describeGatewayError(err, this.serverUrl);
    }
    this.publish();
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
      case 'signIn':
        await this.deps.signIn();
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
      signedIn: this.gateway !== undefined,
      serverUrl: this.serverUrl,
      models: this.models,
      selectedModel: this.selectedModel,
      messages: [...this.messages],
      busy: this.busy,
      error: this.error,
    };
  }

  private async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    const gateway = this.gateway;
    const model = this.selectedModel;
    if (!text || this.busy || !gateway || !model) return;

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
      for await (const delta of gateway.streamChat(model, history, abort.signal)) {
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
        const message = describeGatewayError(err, this.serverUrl);
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
 * else the first available model (oreo-ai lists its default first).
 * Unavailable models (MacBook asleep) are skipped.
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
