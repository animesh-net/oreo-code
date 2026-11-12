import { isSecretPath, type Workspace } from './workspaceTools';

/** Instruction files read at the start of every agent task, from the repository root. */
export const ROOT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'];
/** Instruction files that apply to their own folder and below, read when the agent first works there. */
export const FOLDER_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
/** The most of one instruction file the model gets. */
export const MAX_INSTRUCTION_FILE_CHARS = 8_000;

/**
 * The repository's agent instructions (AGENTS.md, CLAUDE.md, Copilot's instructions):
 * the root ones go in the system prompt, and a folder's own ones are added to the
 * first tool result that touches a file under it. Each file is given once per task,
 * within a budget that scales with the model's context.
 */
export class Instructions {
  private readonly given = new Set<string>();
  private left: number;

  constructor(
    private readonly ws: Workspace,
    /** All instruction text together may use this many characters. */
    budget: number,
  ) {
    this.left = budget;
  }

  /** The root files, for the system prompt; empty if there are none. */
  async root(): Promise<string> {
    return this.render(await this.read(ROOT_INSTRUCTION_FILES));
  }

  /** Instructions of folders above `path` not given yet, nearest last; empty if none. */
  async forPath(path: string): Promise<string> {
    const parts = path.split('/').slice(0, -1);
    const candidates: string[] = [];
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      for (const name of FOLDER_INSTRUCTION_FILES) candidates.push(`${dir}/${name}`);
    }
    return this.render(await this.read(candidates));
  }

  private async read(paths: string[]): Promise<{ path: string; text: string }[]> {
    const found: { path: string; text: string }[] = [];
    for (const path of paths) {
      if (this.given.has(path) || isSecretPath(path) || this.left <= 0) continue;
      // Tried once per task, found or not, so later reads don't look again.
      this.given.add(path);
      let text: string;
      try {
        text = (await this.ws.readFile(path)).trim();
      } catch {
        continue; // Not there.
      }
      if (!text) continue;
      const room = Math.min(MAX_INSTRUCTION_FILE_CHARS, this.left);
      const kept = text.length > room ? `${text.slice(0, room)}\n… (rest of ${path} cut)` : text;
      this.left -= kept.length;
      found.push({ path, text: kept });
    }
    return found;
  }

  private render(files: { path: string; text: string }[]): string {
    return files.map((f) => `--- ${f.path} ---\n${f.text}`).join('\n\n');
  }
}

/** One problem a language server reports in a file. */
export interface Problem {
  /** 1-based. */
  line: number;
  message: string;
  source?: string;
}

/** Problems in `after` that weren't in `before`, matched by message, so moved lines still match. */
export function newProblems(before: readonly Problem[], after: readonly Problem[]): Problem[] {
  const left = new Map<string, number>();
  for (const p of before) left.set(p.message, (left.get(p.message) ?? 0) + 1);
  return after.filter((p) => {
    const n = left.get(p.message) ?? 0;
    if (n > 0) {
      left.set(p.message, n - 1);
      return false;
    }
    return true;
  });
}

const MAX_PROBLEMS_SHOWN = 10;

/** The line added to a change's result: the errors it introduced, for the model to fix. */
export function describeProblems(path: string, before: readonly Problem[], after: readonly Problem[]): string {
  if (!after.length) return `No errors reported for ${path}.`;
  const added = newProblems(before, after);
  const older = after.filter((p) => !added.includes(p));
  const list = (ps: readonly Problem[]) => [
    ...ps.slice(0, MAX_PROBLEMS_SHOWN).map((p) => `- line ${p.line}: ${p.message}${p.source ? ` (${p.source})` : ''}`),
    ...(ps.length > MAX_PROBLEMS_SHOWN ? [`- … and ${ps.length - MAX_PROBLEMS_SHOWN} more.`] : []),
  ];
  return [
    ...(added.length ? [`Errors in ${path} after this change. Fix them before going on:`, ...list(added)] : []),
    // Errors from before the task still matter in a file the task changes: the same
    // message can also hide a new one (a lost "}" next to an old one).
    ...(older.length
      ? [
          added.length
            ? 'It also still has errors from before this task:'
            : `${path} still has errors from before this task. Fix them if they're part of the task:`,
          ...list(older),
        ]
      : []),
  ].join('\n');
}
