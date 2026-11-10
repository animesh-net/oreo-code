// Messages between the extension host and the chat webview.
// Shared by both bundles, so keep this file free of Node and DOM imports.

/** Where a model runs: the MacBook's Ollama. */
export type ModelProvider = 'macbook';

export interface ModelInfo {
  id: string;
  name: string;
  provider: ModelProvider;
  supportsTools: boolean;
  /** False when Ollama doesn't have the model installed. */
  available: boolean;
}

/** How long a model may think before answering; sent to Ollama as reasoning_effort. */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'low', 'medium', 'high'];

/** Until you pick otherwise the models don't think: they are small and slow to think on the M1. */
export const DEFAULT_EFFORT: ReasoningEffort = 'none';

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
