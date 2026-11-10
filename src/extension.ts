import * as vscode from 'vscode';
import { GithubTokenStore, validateGithubTokenShape } from './auth/githubToken';
import { ChatController } from './chat/chatController';
import { ensureGithubMcpBinary, GITHUB_MCP_VERSION } from './mcp/githubBinary';
import { githubServerSpec } from './mcp/githubServer';
import { McpHost } from './mcp/host';
import { stdioConnect } from './mcp/stdioConnect';
import { OllamaClient } from './ollama/client';
import type { ReasoningEffort, ViewState } from './shared/protocol';
import { ChatViewProvider } from './views/chatViewProvider';

const LAST_MODEL_KEY = 'oreo.lastModel';
// Kept from when effort was remembered per provider, so an earlier pick for the Mac's models carries over.
const EFFORT_KEY = 'oreo.effort.macbook';

let mcpHost: McpHost | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const view = new ChatViewProvider(context.extensionUri);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'workbench.view.extension.oreo';
  status.show();

  const config = () => vscode.workspace.getConfiguration('oreo');

  const controller = new ChatController({
    getOllamaUrl: () => config().get<string>('ollamaUrl', ''),
    getLastModel: () => context.globalState.get<string>(LAST_MODEL_KEY),
    rememberModel: (modelId) => void context.globalState.update(LAST_MODEL_KEY, modelId),
    getEffort: () => context.globalState.get<ReasoningEffort>(EFFORT_KEY),
    rememberEffort: (effort) => void context.globalState.update(EFFORT_KEY, effort),
    createClient: (ollamaUrl) => new OllamaClient(ollamaUrl),
    post: (message) => view.post(message),
    onState: (state) => updateStatus(status, state),
  });
  view.attach(controller);

  // GitHub tools: github-mcp-server runs on this Mac as a child process, with the
  // GitHub token from the Keychain. It starts on first use, not at activation.
  const githubTokens = new GithubTokenStore(context.secrets);
  const output = vscode.window.createOutputChannel('Oreo');
  const version = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  const host = new McpHost(async () => {
    const token = await githubTokens.get();
    if (!token) return [];
    const custom = config().get<string>('githubMcp.path', '').trim();
    const binary = custom || (await ensureGithubMcpBinary(context.globalStorageUri.fsPath));
    const spec = githubServerSpec(binary, token);
    return spec ? [spec] : [];
  }, stdioConnect(version));
  mcpHost = host;

  const setGithubToken = async () => {
    const token = await vscode.window.showInputBox({
      title: 'Oreo: Set GitHub token',
      prompt:
        'Paste a fine-grained GitHub token with Contents and Pull requests (read and write) on the repos the agent may use.',
      password: true,
      ignoreFocusOut: true,
      validateInput: validateGithubTokenShape,
    });
    if (token === undefined) return;
    await githubTokens.set(token);
    void vscode.window.showInformationMessage('GitHub token saved in the Keychain.');
  };

  const showGithubTools = async () => {
    if (!(await githubTokens.get())) {
      const choice = await vscode.window.showWarningMessage('Set a GitHub token first.', 'Set GitHub token');
      if (choice) await setGithubToken();
      if (!(await githubTokens.get())) return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting github-mcp-server ${GITHUB_MCP_VERSION}…` },
      () => host.start(),
    );
    output.clear();
    for (const state of host.serverStates) {
      output.appendLine(`${state.name}: ${state.status}${state.error ? ` — ${state.error}` : ''}`);
    }
    const tools = host.catalogTools;
    output.appendLine('');
    output.appendLine(`${tools.length} tools (read runs straight away; write needs your approval):`);
    for (const tool of tools) output.appendLine(`  [${tool.toolClass}] ${tool.name}`);
    output.show(true);
  };

  context.subscriptions.push(
    status,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('oreo.newChat', () => controller.newChat()),
    output,
    vscode.commands.registerCommand('oreo.setGithubToken', setGithubToken),
    vscode.commands.registerCommand('oreo.clearGithubToken', async () => {
      await githubTokens.clear();
      void vscode.window.showInformationMessage('GitHub token removed.');
    }),
    vscode.commands.registerCommand('oreo.showGithubTools', showGithubTools),
    // A new token or binary takes effect on the next start.
    githubTokens.onDidChange(() => void host.stop()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('oreo.ollamaUrl')) {
        void controller.refresh();
      }
      if (e.affectsConfiguration('oreo.githubMcp.path')) {
        void host.stop();
      }
    }),
  );

  void controller.refresh();
}

export async function deactivate(): Promise<void> {
  // Stops the github-mcp-server child process; everything else is in subscriptions.
  await mcpHost?.stop();
}

function updateStatus(item: vscode.StatusBarItem, state: ViewState): void {
  if (state.error) {
    item.text = '$(warning) Oreo';
    item.tooltip = state.error;
    return;
  }
  const model = state.models.find((m) => m.id === state.selectedModel);
  item.text = state.busy ? '$(sync~spin) Oreo' : `$(comment-discussion) ${model?.name ?? 'Oreo'}`;
  item.tooltip = `Ollama at ${state.ollamaUrl}`;
}
