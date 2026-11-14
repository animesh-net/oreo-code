// Messages between the extension host and the chat webview.
// Shared by both bundles, so keep this file free of Node and DOM imports.

/** Where a model runs: the Mac's Ollama, the only place models come from. */
export type ModelProvider = 'macbook';

/**
 * How a model can think. "switch": only on or off (Off / On in the menu); Ollama
 * turns any level into "on" for such a model. "levels": always reasons, at low,
 * medium or high. "none": can't think, so there is no Thinking menu and no
 * reasoning_effort is sent. Read from what Ollama says of each model (`src/ollama/models.ts`).
 */
export type ThinkingStyle = 'switch' | 'levels' | 'none';

export interface ModelInfo {
  id: string;
  name: string;
  provider: ModelProvider;
  supportsTools: boolean;
  thinking: ThinkingStyle;
  /** The prompt is kept under this many characters, to fit the model's context window. */
  maxPromptChars: number;
  /** Size in billions of parameters, from Ollama; the menu lists the largest first. */
  sizeB?: number;
  /** Can write inline code completions (Qwen2.5-Coder-style fill-in-the-middle). */
  completion?: boolean;
  /** False when Ollama didn't say what the model can do: it's offered for plain chat until it does. */
  described?: boolean;
  /** False when Ollama doesn't have the model installed. */
  available: boolean;
}

/** How long a model may think before answering; sent to Ollama as reasoning_effort. */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'low', 'medium', 'high'];

/** Until you pick otherwise the models don't think: they are small and slow to think on the M1. */
export const DEFAULT_EFFORT: ReasoningEffort = 'none';

/**
 * What the Thinking menu offers for a model, so it shows only what is really sent.
 * One effort is kept for all models: On keeps it (medium if it was off), and a
 * levels model shows "none" as low.
 */
export function effortChoices(
  style: ThinkingStyle,
  effort: ReasoningEffort,
): { value: ReasoningEffort; label: string }[] {
  if (style === 'none') return [];
  return style === 'levels'
    ? [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ]
    : [
        { value: 'none', label: 'Off' },
        { value: effort === 'none' ? 'medium' : effort, label: 'On' },
      ];
}

export function shownEffort(style: ThinkingStyle, effort: ReasoningEffort): ReasoningEffort {
  return style === 'levels' && effort === 'none' ? 'low' : effort;
}

/** The pill's second word: the level, or whether a switch model thinks. */
export function effortLabel(style: ThinkingStyle, effort: ReasoningEffort): string {
  if (style === 'none') return 'No thinking';
  if (style === 'switch') return effort === 'none' ? 'Thinking off' : 'Thinking';
  const shown = shownEffort(style, effort);
  return effortChoices(style, effort).find((c) => c.value === shown)?.label ?? shown;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** What the model looked at while answering, e.g. "Read src/extension.ts". */
  activity?: string[];
  /** Agent mode: each tool the agent used, in order. */
  steps?: AgentStep[];
}

/** One tool call in agent mode, shown collapsed in the chat. */
export interface AgentStep {
  /** E.g. "Read src/extension.ts" or "Edit src/app.ts". */
  title: string;
  /** The arguments and what came back, as plain text. */
  detail?: string;
  outcome: 'ok' | 'rejected' | 'error';
}

/** A write waiting for your approval in agent mode. */
export interface ApprovalRequest {
  id: number;
  kind: 'edit_file' | 'create_file' | 'run_command';
  /** E.g. "Edit src/app.ts" or "Run npm test". */
  title: string;
  /** The diff for a file, or the exact command line; shown as plain text. */
  detail: string;
  /** Where a command runs. */
  cwd?: string;
}

export interface ViewState {
  /** The normalized "oreo.ollamaUrl" setting. */
  ollamaUrl: string;
  models: ModelInfo[];
  selectedModel?: string;
  /** The thinking effort sent with each message. */
  effort: ReasoningEffort;
  messages: ChatMessage[];
  busy: boolean;
  error?: string;
  /** Agent mode is on: the agent may edit files and run commands, with your approval. */
  agentMode: boolean;
  /** "Apply edits without asking" (on by default, remembered): edits and new files skip the card; commands and files that run code still ask. */
  approveEdits: boolean;
  /** A folder is open, so agent mode has somewhere to work. */
  hasFolder: boolean;
  /** The write waiting for your answer, if any. */
  approval?: ApprovalRequest;
  /** Files the last agent task changed, which "Undo task" can put back. */
  undoFiles?: string[];
}

export type ToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'delta'; text: string }
  /** A tool ran while the reply is being written. */
  | { type: 'activity'; text: string }
  /** Agent mode: a tool call finished (or was rejected). */
  | { type: 'step'; step: AgentStep }
  /** The model is thinking before it writes (cleared by the next text). */
  | { type: 'thinking' }
  /** A turn failed: show the error and put the user's text back in the input. */
  | { type: 'failed'; message: string; draft: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'selectModel'; modelId: string }
  | { type: 'selectEffort'; effort: ReasoningEffort }
  | { type: 'newChat' }
  | { type: 'retry' }
  | { type: 'setAgentMode'; on: boolean }
  | { type: 'setApproveEdits'; on: boolean }
  | { type: 'approval'; id: number; approved: boolean }
  | { type: 'undoTask' };
