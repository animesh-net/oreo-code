import * as vscode from 'vscode';
import { TokenStore, validateTokenShape } from './auth/tokenStore';
import { ChatController } from './chat/chatController';
import { OreoGateway } from './gateway/client';
import type { ViewState } from './shared/protocol';
import { ChatViewProvider } from './views/chatViewProvider';

const LAST_MODEL_KEY = 'oreo.lastModel';

export function activate(context: vscode.ExtensionContext): void {
  const tokens = new TokenStore(context.secrets);
  const view = new ChatViewProvider(context.extensionUri);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'workbench.view.extension.oreo';
  status.show();

  const config = () => vscode.workspace.getConfiguration('oreo');

  const signIn = async () => {
    const token = await vscode.window.showInputBox({
      title: 'Oreo: Sign in',
      prompt: 'Paste an API token from oreo-ai → Settings → API tokens.',
      password: true,
      ignoreFocusOut: true,
      validateInput: validateTokenShape,
    });
    if (token === undefined) return;
    await tokens.set(token);
    // Refresh also runs from tokens.onDidChange; this makes the result immediate.
    await controller.refresh();
  };

  const controller = new ChatController({
    getServerUrl: () => config().get<string>('serverUrl', ''),
    getLastModel: () => context.globalState.get<string>(LAST_MODEL_KEY),
    rememberModel: (modelId) => void context.globalState.update(LAST_MODEL_KEY, modelId),
    getToken: () => tokens.get(),
    createGateway: (serverUrl, token) => new OreoGateway(serverUrl, token),
    post: (message) => view.post(message),
    signIn,
    onState: (state) => updateStatus(status, state),
  });
  view.attach(controller);

  context.subscriptions.push(
    status,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('oreo.signIn', signIn),
    vscode.commands.registerCommand('oreo.signOut', async () => {
      await tokens.clear();
      await controller.refresh();
      void vscode.window.showInformationMessage('Signed out of oreo-ai.');
    }),
    vscode.commands.registerCommand('oreo.newChat', () => controller.newChat()),
    tokens.onDidChange(() => void controller.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('oreo.serverUrl')) {
        void controller.refresh();
      }
    }),
  );

  void controller.refresh();
}

export function deactivate(): void {
  // Nothing to clean up: subscriptions are disposed by VS Code.
}

function updateStatus(item: vscode.StatusBarItem, state: ViewState): void {
  if (!state.signedIn) {
    item.text = '$(account) Oreo: signed out';
    item.tooltip = 'Run "Oreo: Sign in" to connect to oreo-ai.';
    return;
  }
  if (state.error) {
    item.text = '$(warning) Oreo';
    item.tooltip = state.error;
    return;
  }
  const model = state.models.find((m) => m.id === state.selectedModel);
  item.text = state.busy ? '$(sync~spin) Oreo' : `$(comment-discussion) ${model?.name ?? 'Oreo'}`;
  item.tooltip = `Connected to ${state.serverUrl}`;
}
