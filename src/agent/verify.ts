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

/** Server frameworks: a project that depends on one is a server. */
const SERVER_PACKAGES = /^(express|fastify|koa|@hapi\/hapi|@nestjs\/core|hono|polka|restify|http-server|serve)$/;
/** A task about serving: "so the app runs and serves index.html", "listen on port 3000". */
const SERVER_TASK = /\b(serv(e|es|ed|ing|er|ers)|port|localhost|https?|endpoints?|routes?|web ?app|website)\b/i;

/**
 * Whether the app should stay up and answer requests, so that starting it and
 * exiting at once, or answering nothing, is a failure rather than "ran and finished".
 */
export function expectsServer(task: string, packageJson: string | undefined): boolean {
  if (SERVER_TASK.test(task)) return true;
  if (packageJson === undefined) return false;
  try {
    const pkg = JSON.parse(packageJson) as { dependencies?: object; devDependencies?: object };
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => SERVER_PACKAGES.test(d));
  } catch {
    return false;
  }
}

/** A command that starts the app the way the run check does (`npm start`, `yarn run start`). */
export function startsApp(command: string): boolean {
  return /^\s*(npm|pnpm|yarn|bun)\s+(run\s+)?start\s*$/.test(command);
}

/** The `start` script's own command line (`node server/index.js`), to know it when the model runs it. */
export function startScript(packageJson: string | undefined): string | undefined {
  if (packageJson === undefined) return undefined;
  try {
    const start = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts?.start;
    return typeof start === 'string' ? start.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Endings that don't change what a command starts: `&`, `2>&1`, `|| true`, `; true`. */
const NOISE_AT_END = /\s*(&|2>&1|\|\|\s*true|;\s*true)\s*$/;

/**
 * The app start inside a command the model ran to start it (`npm start &`, `nohup node
 * server/index.js 2>&1 || true`), or undefined if the command does something else. Such a
 * command would block until stopped, or leave a server nobody can reach.
 */
export function appStartIn(command: string, script: string | undefined): string | undefined {
  let rest = command.trim();
  const background = /(^|[^&])&\s*$/.test(rest) || /^nohup\s/.test(rest);
  rest = rest.replace(/^nohup\s+/, '');
  for (let before = ''; before !== rest;) {
    before = rest;
    rest = rest.replace(NOISE_AT_END, '');
  }
  if (!rest || /[;&|<>`$]/.test(rest)) return undefined;
  if (background || startsApp(rest) || (script !== undefined && rest === script)) return rest;
  return undefined;
}
