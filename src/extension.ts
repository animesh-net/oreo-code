import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GithubTokenStore, validateGithubTokenShape } from './auth/githubToken';
import { ChatController } from './chat/chatController';
import { ensureGithubMcpBinary, GITHUB_MCP_VERSION } from './mcp/githubBinary';
import { githubServerSpec } from './mcp/githubServer';
import { McpHost } from './mcp/host';
import { stdioConnect } from './mcp/stdioConnect';
import { OllamaClient } from './ollama/client';
import { tailscaleOllamaUrls } from './ollama/url';
import { ghCliToken } from './auth/ghCliToken';
import { CloudflareClient } from './cloudflare/client';
import { describeError, downloadRelease, findUpdateWithTokens } from './update/releases';
import type { ReasoningEffort, ViewState } from './shared/protocol';
import { ChatViewProvider } from './views/chatViewProvider';
import { registerInlineCompletion } from './workspace/inlineCompletion';
import { currentWorkspace } from './workspace/vscodeWorkspace';

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
  // The chat's latest state also tells completion where Ollama answers and what it has.
  let latestState: ViewState | undefined;
  const stateChanged = new vscode.EventEmitter<void>();

  const controller = new ChatController({
    getOllamaUrl: () => config().get<string>('ollamaUrl', ''),
    getLastModel: () => context.globalState.get<string>(LAST_MODEL_KEY),
    rememberModel: (modelId) => void context.globalState.update(LAST_MODEL_KEY, modelId),
    getEffort: () => context.globalState.get<ReasoningEffort>(EFFORT_KEY),
    rememberEffort: (effort) => void context.globalState.update(EFFORT_KEY, effort),
    createClient: (ollamaUrl) => new OllamaClient(ollamaUrl),
    fallbackOllamaUrls: (ollamaUrl) => tailscaleOllamaUrls(ollamaUrl, os.networkInterfaces()),
    getWorkspace: currentWorkspace,
    // Workers AI through oreo-ai's relay on the Pi, over Tailscale; it holds the Cloudflare token.
    getCloudUrl: () => config().get<string>('cloudUrl', ''),
    createCloudClient: (cloudUrl) => new CloudflareClient(cloudUrl),
    post: (message) => view.post(message),
    onState: (state) => {
      latestState = state;
      updateStatus(status, state);
      stateChanged.fire();
    },
  });
  view.attach(controller);
  registerInlineCompletion(context, () => latestState, stateChanged.event);

  // GitHub tools: github-mcp-server runs on this Mac as a child process, with the
  // GitHub token from the Keychain. It starts on first use, not at activation.
  const githubTokens = new GithubTokenStore(context.secrets);
  const output = vscode.window.createOutputChannel('Oreo Code');
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
      title: 'Oreo Code: Set GitHub token',
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

  // Updates: each main build is a release (v0.2.0, v0.2.1, ...). The check needs no
  // token while the repository is public; a token is used first when there is one.
  let installedUpdate: string | undefined;
  let warnedAboutUpdates = false;
  const checkForUpdates = async (manual: boolean) => {
    if (!manual && !config().get<boolean>('autoUpdate', true)) return;
    let step = 'checking for a newer release';
    try {
      // The Keychain token first, then the GitHub CLI's sign-in, then no token.
      const { release, token } = await findUpdateWithTokens(version, [() => githubTokens.get(), ghCliToken]);
      if (!release || release.version === installedUpdate) {
        if (manual) {
          void vscode.window.showInformationMessage(
            installedUpdate
              ? `Oreo Code ${installedUpdate} is installed; reload the window to use it.`
              : `Oreo Code ${version} is the newest version.`,
          );
        }
        return;
      }
      step = `downloading ${release.assetName}`;
      const bytes = await downloadRelease(release, token);
      step = 'saving the download';
      const dir = vscode.Uri.joinPath(context.globalStorageUri, 'updates');
      await vscode.workspace.fs.createDirectory(dir);
      const file = vscode.Uri.joinPath(dir, release.assetName);
      await vscode.workspace.fs.writeFile(file, bytes);
      step = `installing ${release.version}`;
      try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
      } catch (err) {
        // VS Code's own command can fail with a bare string; its CLI, inside the app
        // (not on PATH), installs a VSIX the same way the manual install does.
        output.appendLine(`installExtension failed (${describeError(err)}); trying the code CLI`);
        await installWithCli(file.fsPath);
      }
      installedUpdate = release.version;
      output.appendLine(`Installed Oreo Code ${release.version}.`);
      const choice = await vscode.window.showInformationMessage(
        `Oreo Code ${release.version} is installed. Reload to use it.`,
        'Reload',
      );
      if (choice) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (err) {
      const message = `Update failed while ${step}: ${describeError(err)}`;
      output.appendLine(message);
      if (err instanceof Error && err.stack) output.appendLine(err.stack);
      // An automatic check says why it failed once per session, then only logs.
      if (manual || !warnedAboutUpdates) void vscode.window.showErrorMessage(message);
      warnedAboutUpdates = true;
    }
  };
  const firstCheck = setTimeout(() => void checkForUpdates(false), 15_000);
  const laterChecks = setInterval(() => void checkForUpdates(false), 6 * 60 * 60 * 1000);

  context.subscriptions.push(
    { dispose: () => (clearTimeout(firstCheck), clearInterval(laterChecks)) },
    stateChanged,
    vscode.commands.registerCommand('oreo.checkForUpdates', () => checkForUpdates(true)),
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
      if (e.affectsConfiguration('oreo.ollamaUrl') || e.affectsConfiguration('oreo.cloudUrl')) {
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
    item.text = '$(warning) Oreo Code';
    item.tooltip = state.error;
    return;
  }
  const model = state.models.find((m) => m.id === state.selectedModel);
  item.text = state.busy ? '$(sync~spin) Oreo Code' : `$(comment-discussion) ${model?.name ?? 'Oreo Code'}`;
  item.tooltip = `Ollama at ${state.ollamaUrl}`;
}

/** Installs a VSIX with the `code` CLI that ships inside VS Code. */
function installWithCli(vsixPath: string): Promise<void> {
  const cli = path.join(vscode.env.appRoot, 'bin', process.platform === 'win32' ? 'code.cmd' : 'code');
  return new Promise((resolve, reject) => {
    execFile(cli, ['--install-extension', vsixPath, '--force'], { timeout: 120_000 }, (err, _stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(),
    );
  });
}
