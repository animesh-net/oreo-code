/**
 * The project's own check, run when the agent says it's done so a task ends with
 * working code: your `oreo.agent.checkCommand` setting if you set one, otherwise a
 * command found from the project's files.
 */

/** How many times a failing check goes back to the model before the task ends anyway. */
export const MAX_VERIFY_ROUNDS = 3;

/** The npm scripts tried, in order: the first one the project has is run. */
const NPM_SCRIPTS = ['check', 'typecheck', 'test', 'build', 'lint'];

/**
 * A check command for the repository, from its root files, or undefined.
 * `readPackageJson` returns the root package.json's text, if there is one.
 */
export function detectCheckCommand(files: readonly string[], packageJson: string | undefined): string | undefined {
  const root = new Set(files.filter((f) => !f.includes('/')).map((f) => f.toLowerCase()));
  if (packageJson !== undefined) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
      scripts = parsed.scripts ?? {};
    } catch {
      // Unreadable package.json: fall through to the other kinds.
    }
    // A script that watches or serves never ends, so it can't tell whether the code works.
    const script = NPM_SCRIPTS.find(
      (s) => typeof scripts[s] === 'string' && !/(--watch\b|\bwatch\b|\bserve\b|\bdev\b)/i.test(scripts[s] as string),
    );
    if (script) {
      if (root.has('pnpm-lock.yaml')) return `pnpm run ${script}`;
      if (root.has('yarn.lock')) return `yarn ${script}`;
      if (root.has('bun.lockb') || root.has('bun.lock')) return `bun run ${script}`;
      return `npm run ${script}`;
    }
  }
  if (files.some((f) => /\.(sln|slnx|csproj|fsproj)$/i.test(f))) return 'dotnet build';
  if (root.has('cargo.toml')) return 'cargo check';
  if (root.has('go.mod')) return 'go build ./...';
  return undefined;
}

/** Quotes a path for the shell: paths are checked by writePathProblem, but quoting keeps it plain. */
const quote = (path: string) => `'${path.replace(/'/g, "'\\''")}'`;

/** The exit code a shell gives for a command it can't find: then the syntax check is skipped. */
export const COMMAND_NOT_FOUND = 127;

/**
 * A syntax check for changed Python files when the project has no check of its own: it
 * parses them with Python's own parser without running them, so it needs no approval.
 * One plain command, so it works in any login shell (zsh, bash, fish); if python3 isn't
 * there, the shell exits with COMMAND_NOT_FOUND and the check is skipped. JavaScript and
 * TypeScript are left to VS Code's built-in errors: `node --check` rejects valid JSX or
 * Flow depending on the Node version.
 */
export function syntaxCheckCommand(changed: readonly string[]): string | undefined {
  const files = changed.filter((path) => /\.py$/i.test(path)).map(quote);
  return files.length
    ? `python3 -c 'import ast,sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]' ${files.join(' ')}`
    : undefined;
}

/**
 * How to start the app, to see it runs: the project's `start` script, unless it watches
 * or serves in development mode. Undefined without one.
 */
export function detectStartCommand(files: readonly string[], packageJson: string | undefined): string | undefined {
  if (packageJson === undefined) return undefined;
  let start: unknown;
  try {
    start = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts?.start;
  } catch {
    return undefined;
  }
  if (typeof start !== 'string' || /(--watch\b|\bwatch\b|nodemon)/i.test(start)) return undefined;
  const root = new Set(files.filter((f) => !f.includes('/')).map((f) => f.toLowerCase()));
  if (root.has('pnpm-lock.yaml')) return 'pnpm start';
  if (root.has('yarn.lock')) return 'yarn start';
  return 'npm start';
}
