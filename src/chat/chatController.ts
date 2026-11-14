import { Instructions } from '../agent/instructions';
import { detectCheckCommand, detectStartCommand, expectsServer, startScript } from '../agent/verify';
import { Checkpoint } from '../agent/checkpoint';
import { FIND_SYMBOL_TOOL, runFindSymbol } from '../agent/findSymbol';
import { runAgent, type AgentModel } from '../agent/loop';
import { describeWrite, type PendingWrite, type WritableWorkspace } from '../agent/writeTools';
import { runWorkspaceTool, WORKSPACE_TOOLS, type Workspace } from '../agent/workspaceTools';
import type { CodeSymbol } from '../completion/symbols';
import type { ModelClient, ToolCall, WireMessage } from '../ollama/client';
import { buildSystemPrompt } from './context';
import { compactWire, summaryMessage } from './compact';
import { chatToSave, readSavedChat, type SavedChat } from './savedChat';
import { describeOllamaError, isUnreachable } from '../ollama/errors';
import { defaultModel } from '../ollama/models';
import { isLoopbackUrl, normalizeOllamaUrl } from '../ollama/url';
import {
  DEFAULT_EFFORT,
  REASONING_EFFORTS,
  type AgentStep,
  type ApprovalRequest,
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
  /** A line for the Oreo Code output channel: what discovery found, and what failed. */
  log?(line: string): void;
  /** The model picked last time in the dropdown, if any. */
  getLastModel(): string | undefined;
  /** Remembers the dropdown choice for next time. */
  rememberModel(modelId: string): void;
  /** The thinking effort picked last time, if any. */
  getEffort(): ReasoningEffort | undefined;
  /** Remembers the thinking effort picked in the dropdown. */
  rememberEffort(effort: ReasoningEffort): void;
  /** Agent mode and "Apply edits without asking" as you last set them; remembered across reloads. */
  getAgentSettings?(): { agentMode?: boolean; approveEdits?: boolean };
  rememberAgentSettings?(settings: { agentMode: boolean; approveEdits: boolean }): void;
  /** The chat saved for this workspace, so it comes back after a reload. */
  loadChat?(): unknown;
  saveChat?(chat: SavedChat): void;
  createClient(ollamaUrl: string): ModelClient;
  /**
   * Other addresses to try when nothing answers at a local URL (127.0.0.1 or
   * localhost): the Mac's Tailscale addresses, where Ollama may listen instead.
   */
  fallbackOllamaUrls?(ollamaUrl: string): string[];
  /** The open folder, for the repo snapshot and the read-only tools; none if no folder is open. */
  getWorkspace?(): Workspace | undefined;
  /** The open folder with writing and commands, for agent mode; none if no folder is open. */
  getWritableWorkspace?(): WritableWorkspace | undefined;
  /** Definitions by name from the symbol index inline completion keeps (find_symbol). */
  findSymbol?(name: string): Promise<readonly CodeSymbol[]>;
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
 * The prompt budget for a model whose context isn't known: what a 32K-token context
 * allows (`promptBudget` in src/ollama/models.ts). Each listed model has its own,
 * from the context Ollama runs it with; Ollama cuts a longer prompt without saying so.
 */
export const MAX_PROMPT_CHARS = 66_000;
const REMOVED = '(Removed to fit the context window.)';

/**
 * Shrinks the prompt in place until it fits: first the oldest earlier turns go (the
 * system prompt and the current question stay), then the oldest tool results are
 * replaced by a note. Returns the question's new index.
 */
export function fitToContext(wire: WireMessage[], question: number, max = MAX_PROMPT_CHARS): number {
  // A tool call's arguments count too: create_file sends a whole file in them.
  const size = () =>
    wire.reduce(
      (n, m) =>
        n +
        m.content.length +
        (m.role === 'assistant' ? (m.tool_calls ?? []).reduce((k, t) => k + t.function.arguments.length, 0) : 0),
      0,
    );
  // Earlier turns sit between the system prompt (0) and the current question.
  while (size() > max && question > 1) {
    wire.splice(1, 1);
    question--;
  }
  for (const m of wire) {
    if (size() <= max) break;
    if (m.role === 'tool' && m.content !== REMOVED) m.content = REMOVED;
  }
  // Then the long arguments of calls already made, oldest first, keeping the path so
  // the model still knows which file it wrote. The arguments stay valid JSON.
  for (const m of wire) {
    if (size() <= max) break;
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const t of m.tool_calls) {
      if (t.function.arguments.length <= SHORT_ARGUMENTS) continue;
      let path: unknown;
      try {
        path = (JSON.parse(t.function.arguments) as { path?: unknown }).path;
      } catch {
        // Not JSON: nothing worth keeping.
      }
      t.function.arguments = JSON.stringify(typeof path === 'string' ? { path, note: REMOVED } : { note: REMOVED });
    }
  }
  return question;
}

/** Waits before each retry of a discovery that left a model undescribed. */
export const REDISCOVERY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000];

/** One model for the log: what it can do and how much prompt it gets. */
function describeModel(m: ModelInfo): string {
  if (m.described === false) return `${m.id} (not described)`;
  const can = [
    m.supportsTools && 'tools',
    m.thinking !== 'none' && `thinking (${m.thinking})`,
    m.completion && 'completion',
  ]
    .filter(Boolean)
    .join(', ');
  return `${m.id} (${can || 'chat only'}, ${m.maxPromptChars} prompt chars)`;
}

/** Compacts a prompt that's nearly full; returns the question's new index, or undefined. */
type Compactor = (
  wire: WireMessage[],
  question: number,
  client: ModelClient,
  model: string,
  max: number,
) => Promise<number | undefined>;

const COMPACTED = 'Compacted the conversation to fit the context window';

/** Tool-call arguments up to this length are kept when trimming. */
const SHORT_ARGUMENTS = 300;

/** How much of each earlier answer goes back to the model; the latest goes back whole. */
export const MAX_EARLIER_REPLY_CHARS = 1_500;
const SHORTENED = '\n… (earlier answer shortened)';

/**
 * The conversation as sent to the model. Answers before the latest one are cut short,
 * so a small model sees what was said without copying long earlier replies again.
 */
export function historyToWire(history: ChatMessage[]): WireMessage[] {
  let latest = -1;
  history.forEach((m, i) => {
    if (m.role === 'assistant') latest = i;
  });
  return history.map((m, i) => ({
    role: m.role,
    content:
      m.role === 'assistant' && i !== latest && m.content.length > MAX_EARLIER_REPLY_CHARS
        ? `${m.content.slice(0, MAX_EARLIER_REPLY_CHARS)}${SHORTENED}`
        : m.content,
  }));
}

/** The share of a model's prompt the repository's instruction files may use, at most 24,000 characters. */
export function instructionBudget(maxPromptChars = MAX_PROMPT_CHARS): number {
  return Math.min(24_000, Math.floor(maxPromptChars * 0.15));
}

/** The project's check command and how to start the app, found from its files. */
async function findCheckCommand(
  ws: WritableWorkspace,
  task: string,
): Promise<{
  checkCommand: string | undefined;
  startCommand: string | undefined;
  startServes: boolean;
  startScript: string | undefined;
}> {
  try {
    const files = await ws.listFiles();
    const packageJson = files.includes('package.json') ? await ws.readFile('package.json') : undefined;
    return {
      checkCommand: detectCheckCommand(files, packageJson),
      startCommand: detectStartCommand(files, packageJson),
      startServes: expectsServer(task, packageJson),
      startScript: startScript(packageJson),
    };
  } catch {
    return { checkCommand: undefined, startCommand: undefined, startServes: false, startScript: undefined };
  }
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
  /** A pending retry of a discovery that couldn't describe every model. */
  private rediscovery: ReturnType<typeof setTimeout> | undefined;
  private agentMode: boolean;
  /** On unless you switch it off: edits apply without a card; commands and files that run code still ask. */
  private approveEdits: boolean;
  private approval: { request: ApprovalRequest; answer(approved: boolean): void } | undefined;
  private approvalSeq = 0;
  /** Bumped by New chat, so a task stopped by it doesn't write into the new chat. */
  private chatId = 0;
  /** The summary that stands in for the chat's first `upTo` messages once it was compacted. */
  private compacted?: { upTo: number; summary: string };
  /** The chat as last saved, to save only when it changes. */
  private savedChat?: string;
  /** What the last agent task changed, for "Undo task". */
  private checkpoint: Checkpoint | undefined;

  constructor(private readonly deps: ChatControllerDeps) {
    const saved = deps.getAgentSettings?.() ?? {};
    this.agentMode = saved.agentMode ?? false;
    this.approveEdits = saved.approveEdits ?? true;
    const chat = readSavedChat(deps.loadChat?.());
    if (chat) {
      this.messages = chat.messages;
      this.compacted = chat.compacted;
      this.savedChat = JSON.stringify(chat);
    }
  }

  /** Saves the chat when a turn is over, if it changed since it was last saved. */
  private saveChat(): void {
    if (this.busy || !this.deps.saveChat) return;
    const chat = chatToSave({ messages: this.messages, compacted: this.compacted });
    const json = JSON.stringify(chat);
    if (json === this.savedChat) return;
    this.savedChat = json;
    this.deps.saveChat(chat);
  }

  private rememberAgentSettings(): void {
    this.deps.rememberAgentSettings?.({ agentMode: this.agentMode, approveEdits: this.approveEdits });
  }

  /** Re-reads the Ollama URL setting, then reloads the model list. */
  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    clearTimeout(this.rediscovery);
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
        this.error = `Ollama at ${this.ollamaUrl} has no models that can chat. Pull one with "ollama pull", then reload the window.`;
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
    this.afterDiscovery(seq, 0);
  }

  /**
   * Logs what discovery found and, if Ollama couldn't describe a model (its features
   * would stay off all session), tries again after each of REDISCOVERY_DELAYS_MS. This
   * finishes a failed discovery; a complete one is never redone while VS Code runs.
   */
  private afterDiscovery(seq: number, attempt: number): void {
    const client = this.client;
    if (!client || !this.models.length) return;
    const undescribed = this.models.filter((m) => m.described === false);
    const delay = REDISCOVERY_DELAYS_MS.at(attempt);
    this.deps.log?.(
      `Models at ${this.ollamaUrl}: ${this.models.map(describeModel).join('; ')}` +
        undescribed
          .map(
            (m) =>
              `\n  Couldn't read what ${m.id} can do (${client.showErrors?.get(m.id) ?? 'no answer'}): offered for plain chat${delay === undefined ? '; gave up' : `; trying again in ${delay / 1000} s`}.`,
          )
          .join(''),
    );
    if (!undescribed.length || delay === undefined) return;
    this.rediscovery = setTimeout(() => {
      void (async () => {
        if (seq !== this.refreshSeq) return;
        try {
          const models = await client.listModels();
          if (seq !== this.refreshSeq) return;
          this.models = models;
          this.selectedModel = pickModel(models, this.selectedModel, this.deps.getLastModel());
          this.publish();
        } catch (err) {
          if (seq !== this.refreshSeq) return;
          this.deps.log?.(`Listing the models again failed: ${(err as Error).message}`);
        }
        this.afterDiscovery(seq, attempt + 1);
      })();
    }, delay);
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
          this.error = `Ollama at ${this.ollamaUrl} has no models that can chat. Pull one with "ollama pull", then reload the window.`;
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
      case 'setAgentMode':
        if (!this.busy) {
          this.agentMode = message.on;
          this.rememberAgentSettings();
          this.publish();
        }
        return;
      case 'setApproveEdits':
        this.approveEdits = message.on;
        this.rememberAgentSettings();
        this.publish();
        return;
      case 'approval':
        if (this.approval?.request.id === message.id) this.approval.answer(message.approved);
        return;
      case 'undoTask':
        await this.undoTask();
        return;
    }
  }

  newChat(): void {
    this.chatId++;
    this.abort?.abort();
    this.messages = [];
    this.compacted = undefined;
    this.error = undefined;
    // The last task's undo stays: its files are still changed, whatever chat is open.
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
      agentMode: this.agentMode,
      approveEdits: this.approveEdits,
      hasFolder: !!this.deps.getWritableWorkspace?.(),
      approval: this.approval?.request,
      undoFiles: !this.busy && this.checkpoint && !this.checkpoint.isEmpty ? this.checkpoint.files : undefined,
    };
  }

  /** Your last pick, or the default. */
  private get effort(): ReasoningEffort {
    const saved = this.deps.getEffort();
    return saved && REASONING_EFFORTS.includes(saved) ? saved : DEFAULT_EFFORT;
  }

  private async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    const model = this.selectedModel;
    const info = this.models.find((m) => m.id === model);
    const client = this.client;
    if (!text || this.busy || !client || !model) return;

    const turnStart = this.messages.length;
    const chat = this.chatId;
    this.messages.push({ role: 'user', content: text });
    const history = [...this.messages];
    this.busy = true;
    this.error = undefined;
    const abort = new AbortController();
    this.abort = abort;
    this.publish();

    let reply = '';
    const activity: string[] = [];
    const steps: AgentStep[] = [];
    const finish = () => {
      if (this.chatId !== chat) return; // New chat was pressed; this turn belongs to the old one.
      const message: ChatMessage = { role: 'assistant', content: reply };
      if (activity.length) message.activity = activity;
      if (steps.length) message.steps = steps;
      this.messages.push(message);
    };
    const writable = this.agentMode && info?.supportsTools ? this.deps.getWritableWorkspace?.() : undefined;
    try {
      if (writable && info) {
        const compact = this.compactor(chat, turnStart, abort.signal);
        const result = await this.runAgentTask(writable, { client, info }, history, abort.signal, compact, {
          onText: (delta) => {
            reply += delta;
            this.deps.post({ type: 'delta', text: delta });
          },
          onStep: (step) => {
            steps.push(step);
            this.deps.post({ type: 'step', step });
          },
        });
        reply = result.reply;
        finish();
        return;
      }
      const workspace = this.deps.getWorkspace?.();
      const tools = info?.supportsTools && workspace ? WORKSPACE_TOOLS : undefined;
      const wire: WireMessage[] = [
        { role: 'system', content: await buildSystemPrompt(workspace, !!tools) },
        ...this.historyWire(history),
      ];
      const compact = this.compactor(chat, turnStart, abort.signal);
      let question = wire.length - 1;
      for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
        let text = '';
        let calls: ToolCall[] | undefined;
        const offered = tools && round < MAX_TOOL_ROUNDS ? tools : undefined;
        let thinking = false;
        const compacted = await compact(wire, question, client, model, info?.maxPromptChars ?? MAX_PROMPT_CHARS);
        if (compacted !== undefined) {
          question = compacted;
          activity.push(COMPACTED);
          this.deps.post({ type: 'activity', text: COMPACTED });
        }
        question = fitToContext(wire, question, info?.maxPromptChars);
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
        fitToContext(wire, question, info?.maxPromptChars);
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
        // You pressed Stop: keep what arrived, if anything, and the agent's steps.
        if (reply || steps.length) finish();
        else if (this.chatId === chat) this.messages.splice(turnStart);
      } else {
        const message = describeOllamaError(err, this.ollamaUrl, model);
        this.error = message;
        if (steps.length) {
          // An agent task that already used tools stays in the chat, so you can see (and undo) what it did.
          finish();
        } else {
          this.messages.splice(turnStart);
          this.deps.post({ type: 'failed', message, draft: text });
        }
      }
    } finally {
      this.busy = false;
      if (this.abort === abort) this.abort = undefined;
      this.publish();
    }
  }

  /**
   * Agent mode: the read tools, find_symbol and the write tools, with every write
   * approved first (src/agent/policy.ts) and remembered for "Undo task".
   */
  private async runAgentTask(
    ws: WritableWorkspace,
    model: AgentModel,
    history: ChatMessage[],
    signal: AbortSignal,
    compact: Compactor,
    on: { onText(delta: string): void; onStep(step: AgentStep): void },
  ) {
    // Replaces the last task's undo only once this task changes a file.
    const checkpoint = new Checkpoint(() => {
      this.checkpoint = checkpoint;
    });
    const findSymbol = this.deps.findSymbol;
    // The repository's instruction files and its check run on their own, nothing to set up.
    const instructions = new Instructions(ws, instructionBudget(model.info.maxPromptChars));
    const task = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
    const [rootInstructions, { checkCommand, startCommand, startServes, startScript: script }] = await Promise.all([
      instructions.root(),
      findCheckCommand(ws, task),
    ]);
    const wire: WireMessage[] = [
      { role: 'system', content: await buildSystemPrompt(ws, true, true, rootInstructions) },
      ...this.historyWire(history),
    ];
    return runAgent({
      model,
      wire,
      question: wire.length - 1,
      fit: fitToContext,
      compact: (w, question, current) =>
        compact(w, question, current.client, current.info.id, current.info.maxPromptChars),
      effort: this.effort,
      signal,
      readTools: findSymbol ? [...WORKSPACE_TOOLS, FIND_SYMBOL_TOOL] : WORKSPACE_TOOLS,
      runRead: (call) =>
        call.function.name === FIND_SYMBOL_TOOL.function.name && findSymbol
          ? runFindSymbol(findSymbol, call)
          : runWorkspaceTool(ws, call),
      workspace: ws,
      approveEdits: () => this.approveEdits,
      requestApproval: (pending) => this.requestApproval(pending, ws, signal),
      checkpoint,
      onText: on.onText,
      onThinking: () => this.deps.post({ type: 'thinking' }),
      onStep: on.onStep,
      instructionsFor: (path) => instructions.forPath(path),
      problems: ws.problems?.bind(ws),
      checkCommand,
      startCommand,
      startServes,
      startScript: script,
    });
  }

  /** The chat as sent to the model: the summary of a compacted beginning, then the rest. */
  private historyWire(history: ChatMessage[]): WireMessage[] {
    const c = this.compacted;
    if (!c || c.upTo > history.length) return historyToWire(history);
    return [summaryMessage(c.summary), ...historyToWire(history.slice(c.upTo))];
  }

  /**
   * Compacts a turn's prompt once it's nearly full (src/chat/compact.ts), summarizing with
   * the model in use, and keeps the summary for later turns of the same chat. A summary
   * that fails leaves the prompt to fitToContext's trimming; Stop still stops.
   */
  private compactor(chat: number, turnStart: number, signal: AbortSignal): Compactor {
    return async (wire, question, client, model, max) => {
      let result;
      try {
        result = await compactWire(wire, question, max, async (messages) => {
          let text = '';
          for await (const event of client.streamChat(model, messages, signal, 'none')) {
            if (event.type === 'text') text += event.text;
          }
          return text;
        });
      } catch (err) {
        if (signal.aborted) throw err;
        return undefined;
      }
      if (!result) return undefined;
      if (this.chatId === chat) this.compacted = { upTo: turnStart, summary: result.summary };
      return result.question;
    };
  }

  /** Shows the approval card and waits for Approve or Reject; Stop counts as Reject. */
  private requestApproval(pending: PendingWrite, ws: WritableWorkspace, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const id = ++this.approvalSeq;
      const answer = (approved: boolean) => {
        if (this.approval?.request.id !== id) return;
        this.approval = undefined;
        signal.removeEventListener('abort', onAbort);
        this.publish();
        resolve(approved);
      };
      const onAbort = () => answer(false);
      signal.addEventListener('abort', onAbort, { once: true });
      this.approval = {
        request: {
          id,
          kind: pending.kind,
          title: describeWrite(pending),
          detail: pending.kind === 'run_command' ? pending.command : pending.diff,
          ...(pending.kind === 'run_command' ? { cwd: ws.root ?? ws.name } : {}),
        },
        answer,
      };
      this.publish();
      if (signal.aborted) onAbort();
    });
  }

  /** Puts back every file the last agent task changed. */
  private async undoTask(): Promise<void> {
    const checkpoint = this.checkpoint;
    const ws = this.deps.getWritableWorkspace?.();
    if (this.busy || !checkpoint || checkpoint.isEmpty || !ws) return;
    // Busy while files are put back, so no new task starts in the middle of it.
    this.busy = true;
    this.publish();
    let result: Awaited<ReturnType<Checkpoint['restore']>>;
    try {
      result = await checkpoint.restore(ws);
    } finally {
      this.busy = false;
    }
    const { restored, changed, failed } = result;
    this.checkpoint = undefined;
    this.messages.push({
      role: 'assistant',
      content:
        `Undid the last task: put back ${restored.length} file${restored.length === 1 ? '' : 's'} (${restored.join(', ') || 'none'}).` +
        (changed.length ? ` Left ${changed.join(', ')} as is: changed since the task wrote it.` : '') +
        (failed.length ? ` Couldn't restore ${failed.join(', ')}.` : '') +
        ' Commands it ran are not undone.',
    });
    this.publish();
  }

  private publish(): void {
    this.saveChat();
    const state = this.state;
    this.deps.post({ type: 'state', state });
    this.deps.onState?.(state);
  }
}

/**
 * Keeps the current choice if still installed, else the last dropdown choice, else the
 * default: the largest model that can use tools (`defaultModel`).
 */
export function pickModel(
  models: ModelInfo[],
  current: string | undefined,
  preferred: string | undefined,
): string | undefined {
  const usable = models.filter((m) => m.available);
  if (current && usable.some((m) => m.id === current)) return current;
  if (preferred && usable.some((m) => m.id === preferred)) return preferred;
  return defaultModel(usable)?.id;
}
