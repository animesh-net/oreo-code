import { isSecretPath, type Workspace } from '../agent/workspaceTools';

const MAX_TREE = 300;
const MAX_OPEN_FILE_CHARS = 8_000;
const MAX_SELECTION_CHARS = 4_000;

/**
 * The system prompt sent with every message: which repository is open, its files,
 * and the file in the editor. Kept well inside the models' 32K-token context.
 */
export async function buildSystemPrompt(ws: Workspace | undefined, withTools: boolean): Promise<string> {
  const lines = ["You are Oreo Code, a coding assistant inside VS Code on the user's Mac."];
  if (!ws) {
    lines.push('No folder is open, so there is no repository to look at. Answer from the conversation.');
    return lines.join('\n');
  }

  const [files, branch] = await Promise.all([ws.listFiles(), ws.branch()]);
  lines.push(
    `You are working in the repository "${ws.name}"${branch ? ` on branch ${branch}` : ''}. When the user says "my code", "the repo" or "this project", they mean this repository.`,
  );
  lines.push(
    withTools
      ? 'Use the tools list_files, search and read_file to look at the code before you answer; never guess what a file contains. You can only read: suggest changes as code in your reply, naming the file and lines. Say which files you looked at.'
      : "You can't open files. You see the file list below and the file open in the editor; if you need another file, ask the user to open it in the editor.",
  );

  const shown = files.slice(0, MAX_TREE);
  lines.push(
    '',
    `Files (${files.length}${files.length > shown.length ? `, first ${shown.length} shown` : ''}; ignored folders left out):`,
  );
  lines.push(...shown);

  const open = ws.activeFile();
  if (open && !isSecretPath(open.path)) {
    const text =
      open.text.length > MAX_OPEN_FILE_CHARS ? `${open.text.slice(0, MAX_OPEN_FILE_CHARS)}\n… (cut)` : open.text;
    lines.push('', `Open in the editor: ${open.path}`, '```', text, '```');
    if (open.selection?.trim()) {
      lines.push('Selected in it:', '```', open.selection.slice(0, MAX_SELECTION_CHARS), '```');
    }
  }
  return lines.join('\n');
}
