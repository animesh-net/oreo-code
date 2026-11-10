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
  | { type: 'signIn' }
  | { type: 'newChat' }
  | { type: 'retry' };
