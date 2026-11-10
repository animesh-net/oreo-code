// Messages between the extension host and the chat webview.
// Shared by both bundles, so keep this file free of Node and DOM imports.

/** Where oreo-ai runs a model: Cloudflare Workers AI or the MacBook's Ollama. */
export type ModelProvider = 'cloudflare' | 'macbook';

export interface ModelInfo {
  id: string;
  name: string;
  provider: ModelProvider;
  supportsTools: boolean;
  /** False when the model can't answer right now, e.g. the MacBook is asleep. */
  available: boolean;
}

/** How long a model may think before answering; sent to oreo-ai as reasoning_effort. */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'low', 'medium', 'high'];

/** Until you pick otherwise: Cloudflare models think at medium, the Mac's 4B/2B models don't think. */
export const DEFAULT_EFFORT: Readonly<Record<ModelProvider, ReasoningEffort>> = {
  cloudflare: 'medium',
  macbook: 'none',
};

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ViewState {
  signedIn: boolean;
  serverUrl: string;
  models: ModelInfo[];
  selectedModel?: string;
  /** The thinking effort for the selected model's provider. */
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
  | { type: 'signIn' }
  | { type: 'newChat' }
  | { type: 'retry' };
