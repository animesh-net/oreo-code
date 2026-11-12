import type { CatalogTool } from './catalog';

/** Branches the agent may write to: ones it created, under this prefix. */
export const AGENT_BRANCH_PREFIX = 'oreo-agent/';
/** Every pull request the agent opens targets this branch. */
export const PR_BASE = 'main';
/** Tool results longer than this are cut, so one file can't fill the context window. */
export const MAX_RESULT_CHARS = 20_000;

const PROTECTED_BRANCHES = new Set(['main', 'master']);

export type PolicyDecision =
  { kind: 'run' } | { kind: 'approve'; summary: string } | { kind: 'refuse'; reason: string };

/**
 * Decides what happens to one tool call. These rules are enforced here, in code,
 * whatever the model was told:
 *  - reads run straight away;
 *  - writes need your approval, and only touch branches named oreo-agent/…;
 *  - a pull request must go from an oreo-agent/ branch into main.
 */
export function decide(tool: CatalogTool, args: Record<string, unknown>): PolicyDecision {
  if (tool.toolClass === 'read') return { kind: 'run' };

  if (tool.server === 'github') {
    const problem = githubWriteProblem(tool.tool, args);
    if (problem) return { kind: 'refuse', reason: problem };
  }
  return { kind: 'approve', summary: summarize(tool, args) };
}

function githubWriteProblem(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === 'create_pull_request') {
    const base = str(args.base);
    const head = str(args.head);
    if (base !== PR_BASE) return `Pull requests must target ${PR_BASE}, not "${base ?? ''}".`;
    if (!head?.startsWith(AGENT_BRANCH_PREFIX)) {
      return `Pull requests must come from a branch named ${AGENT_BRANCH_PREFIX}…, not "${head ?? ''}".`;
    }
    return undefined;
  }
  if (tool === 'create_branch') {
    const branch = str(args.branch);
    if (!branch?.startsWith(AGENT_BRANCH_PREFIX) || branch.length <= AGENT_BRANCH_PREFIX.length) {
      return `New branches must be named ${AGENT_BRANCH_PREFIX}<short-name>, not "${branch ?? ''}".`;
    }
    return undefined;
  }
  // Every other write that names a branch (files, commits) must stay on an agent branch.
  if ('branch' in args) {
    const branch = str(args.branch);
    if (!branch || PROTECTED_BRANCHES.has(branch) || !branch.startsWith(AGENT_BRANCH_PREFIX)) {
      return `Changes may only go to a branch named ${AGENT_BRANCH_PREFIX}…, not "${branch ?? ''}".`;
    }
  }
  return undefined;
}

/**
 * Files that decide what runs: scripts, hooks, build and CI files, editor tasks. An
 * edit to one could change what an approved command (e.g. "npm test") or VS Code
 * does, so it always asks, even with "Approve edits for this task" on.
 */
const RUNS_CODE = [
  /(^|\/)package\.json$/i,
  /(^|\/)(makefile|gnumakefile|justfile|taskfile\.ya?ml|dockerfile|compose\.ya?ml|docker-compose\.ya?ml)$/i,
  /(^|\/)\.(vscode|husky|githooks|github|devcontainer|circleci|gitlab-ci)(\/|$)/i,
  /(^|\/)\.(gitlab-ci\.yml|envrc|yarnrc(\.yml)?|pnpmfile\.cjs|gitattributes|gitmodules)$/i,
  /\.(sh|bash|zsh|command|ps1|bat|cmd)$/i,
  /\.(csproj|fsproj|vbproj|props|targets|sln|slnx)$/i,
  /(^|\/)(setup\.py|pyproject\.toml|tox\.ini|noxfile\.py|conftest\.py|build\.gradle(\.kts)?|pom\.xml)$/i,
];

export function runsCode(path: string): boolean {
  return RUNS_CODE.some((re) => re.test(path));
}

/**
 * Whether agent mode's own write tools (src/agent/writeTools.ts) need your approval.
 * A command always does. Edits and new files do unless you switched on "Approve
 * edits for this task", which covers only those two, only that task, and never a
 * file that decides what runs (runsCode).
 */
export function needsApproval(
  tool: 'edit_file' | 'create_file' | 'run_command',
  approveEdits: boolean,
  path?: string,
): boolean {
  if (tool === 'run_command') return true;
  if (path !== undefined && runsCode(path)) return true;
  return !approveEdits;
}

/** One line for the approval card; the card also shows the full arguments. */
export function summarize(tool: CatalogTool, args: Record<string, unknown>): string {
  const repo = [str(args.owner), str(args.repo)].filter(Boolean).join('/');
  const where = repo ? ` in ${repo}` : '';
  switch (tool.tool) {
    case 'create_branch':
      return `Create branch ${str(args.branch)} from ${str(args.from_branch) ?? 'the default branch'}${where}`;
    case 'create_pull_request':
      return `Open a pull request "${str(args.title) ?? ''}" from ${str(args.head)} into ${str(args.base)}${where}`;
    case 'push_files': {
      const files = Array.isArray(args.files) ? args.files.length : 0;
      return `Commit ${files} file${files === 1 ? '' : 's'} to ${str(args.branch)}${where}: ${str(args.message) ?? ''}`;
    }
    case 'create_or_update_file':
      return `Write ${str(args.path)} on ${str(args.branch)}${where}: ${str(args.message) ?? ''}`;
    default:
      return `Run ${tool.name}${where}`;
  }
}

/** Cuts a long tool result and tells the model how to get the rest. */
export function capResult(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Cut at ${max} of ${text.length} characters. Ask for a narrower path or range.]`;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
