import { runWorkspaceTool, WORKSPACE_TOOLS, type Workspace } from '../agent/workspaceTools';
import type { ModelClient, ToolCall, WireMessage } from '../ollama/client';
import { buildSystemPrompt } from './context';
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
  /** The open folder, for the repo snapshot and the read-only tools; none if no folder is open. */
  getWorkspace?(): Workspace | undefined;
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
export const EMPTY_REPLY = 'Oreo Code finished without an answer. Try again, or turn Thinking off.';

/**
 * The models run with a 32K-token context (oreo-ai's Modelfiles) and Ollama cuts a
 * longer prompt without saying so. At roughly 3 characters a token for code, the
 * prompt is kept under this, leaving room for the reply.
 */
export const MAX_PROMPT_CHARS = 72_000;
const REMOVED = '(Removed to fit the context window.)';

/**
 * Shrinks the prompt in place until it fits: first the oldest earlier turns go (the
 * system prompt and the current question stay), then the oldest tool results are
 * replaced by a note. Returns the question's new index.
 */
export function fitToContext(wire: WireMessage[], question: number, max = MAX_PROMPT_CHARS): number {
  const size = () => wire.reduce((n, m) => n + m.content.length, 0);
  // Earlier turns sit between the system prompt (0) and the current question.
  while (size() > max && question > 1) {
    wire.splice(1, 1);
    question--;
  }
  for (const m of wire) {
    if (size() <= max) break;
    if (m.role === 'tool' && m.content !== REMOVED) m.content = REMOVED;
  }
  return question;
}

/** Tool rounds per reply; the last round gets no tools, so the model must answer. */
export const MAX_TOOL_ROUNDS = 8;

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
    const activity: string[] = [];
    const finish = () => {
      const message: ChatMessage = { role: 'assistant', content: reply };
      if (activity.length) message.activity = activity;
      this.messages.push(message);
    };
    try {
      const info = this.models.find((m) => m.id === model);
      const workspace = this.deps.getWorkspace?.();
      const tools = info?.supportsTools && workspace ? WORKSPACE_TOOLS : undefined;
      const wire: WireMessage[] = [
        { role: 'system', content: await buildSystemPrompt(workspace, !!tools) },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ];
      let question = wire.length - 1;
      for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
        let text = '';
        let calls: ToolCall[] | undefined;
        const offered = tools && round < MAX_TOOL_ROUNDS ? tools : undefined;
        let thinking = false;
        question = fitToContext(wire, question);
        for await (const event of client.streamChat(model, wire, abort.signal, this.effort, offered)) {
          if (event.type === 'toolCalls') {
            calls = event.calls;
            continue;
          }
          if (event.type === 'thinking') {
            if (!thinking) this.deps.post({ type: 'thinking' });
            thinking = true;
            continue;
          }
          // A new round's text starts on its own paragraph.
          const delta = !text && reply ? `\n\n${event.text}` : event.text;
          text += event.text;
          reply += delta;
          this.deps.post({ type: 'delta', text: delta });
        }
        if (!calls?.length || !workspace) break;
        wire.push({ role: 'assistant', content: text, tool_calls: calls });
        for (const call of calls) {
          const result = await runWorkspaceTool(workspace, call);
          activity.push(result.summary);
          this.deps.post({ type: 'activity', text: result.summary });
          wire.push({ role: 'tool', tool_call_id: call.id, content: result.content });
        }
      }
      // A thinking model sometimes ends a round after tools with no answer at all. Ask
      // once more, without tools or thinking; if that is empty too, it's a failure.
      if (!reply.trim()) {
        wire.push({ role: 'user', content: 'Using what you found, answer my question now.' });
        fitToContext(wire, question);
        for await (const event of client.streamChat(model, wire, abort.signal, 'none')) {
          if (event.type !== 'text') continue;
          reply += event.text;
          this.deps.post({ type: 'delta', text: event.text });
        }
        if (!reply.trim()) throw new Error(EMPTY_REPLY);
      }
      finish();
    } catch (err) {
      if (abort.signal.aborted) {
        // You pressed Stop: keep what arrived, if anything.
        if (reply) finish();
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
