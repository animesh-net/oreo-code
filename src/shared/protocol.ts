// Messages between the extension host and the chat webview.
// Shared by both bundles, so keep this file free of Node and DOM imports.

/** Where a model runs: the MacBook's Ollama. */
export type ModelProvider = 'macbook';

/**
 * How a model can think. "switch": only on or off (Off / On in the menu); Ollama
 * turns any level into "on" for such a model. "levels": always reasons, at low,
 * medium or high. Set per model in `src/ollama/models.ts`.
 */
export type ThinkingStyle = 'switch' | 'levels';

export interface ModelInfo {
  id: string;
  name: string;
  provider: ModelProvider;
  supportsTools: boolean;
  thinking: ThinkingStyle;
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
  if (style === 'switch') return effort === 'none' ? 'Thinking off' : 'Thinking';
  const shown = shownEffort(style, effort);
  return effortChoices(style, effort).find((c) => c.value === shown)?.label ?? shown;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
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
}

export type ToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'delta'; text: string }
  /** A turn failed: show the error and put the user's text back in the input. */
  | { type: 'failed'; message: string; draft: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'selectModel'; modelId: string }
  | { type: 'selectEffort'; effort: ReasoningEffort }
  | { type: 'newChat' }
  | { type: 'retry' };
