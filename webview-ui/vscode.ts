import type { FromWebview } from '../src/shared/protocol';

interface VsCodeApi {
  postMessage(message: FromWebview): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** acquireVsCodeApi() may only be called once per webview. */
export const vscode: VsCodeApi = acquireVsCodeApi();
