import * as vscode from 'vscode';
import type { ChatController } from '../chat/chatController';
import type { FromWebview, ToWebview } from '../shared/protocol';

/** Hosts the chat webview in the Oreo Code sidebar and relays messages to the controller. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'oreo.chat';
  private view: vscode.WebviewView | undefined;
  private controller: ChatController | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  attach(controller: ChatController): void {
    this.controller = controller;
  }

  post(message: ToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((msg: FromWebview) => {
      void this.controller?.handle(msg);
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const nonce = makeNonce();
    // Model output is untrusted: no inline script, no remote content, text only.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Oreo Code</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
