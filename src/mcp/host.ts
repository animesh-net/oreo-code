import { buildCatalog, type CatalogTool, type McpToolInfo } from '../agent/catalog';

/** How to start one MCP server as a child process talking over stdio. */
export interface McpServerSpec {
  /** Short name; tools are offered as "<name>__<tool>". */
  name: string;
  command: string;
  args: string[];
  /** Only these variables reach the child, on top of a minimal default (PATH, HOME…). */
  env: Record<string, string>;
}

/** The parts of an MCP client the host uses, so tests can stand in for a server. */
export interface McpConnection {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutput>;
  close(): Promise<void>;
  /** Called when the server process exits or the connection drops. */
  onClose(listener: () => void): void;
}

export interface ToolOutput {
  text: string;
  isError: boolean;
}

export type Connect = (spec: McpServerSpec) => Promise<McpConnection>;

export type ServerState = { name: string; status: 'starting' | 'ready' | 'failed' | 'stopped'; error?: string };

/**
 * Starts the configured MCP servers, keeps their tool catalog, and routes tool
 * calls to the right server. A server that fails or exits drops its tools and is
 * started again on the next use; the others keep working.
 */
export class McpHost {
  private readonly connections = new Map<string, McpConnection>();
  private readonly tools = new Map<string, McpToolInfo[]>();
  private readonly states = new Map<string, ServerState>();
  private catalog: CatalogTool[] = [];
  private starting: Promise<void> | undefined;

  constructor(
    private readonly specs: () => Promise<McpServerSpec[]>,
    private readonly connect: Connect,
    private readonly onChange: () => void = () => {},
  ) {}

  /** Starts any server that isn't running. Safe to call again; concurrent calls share one start. */
  start(): Promise<void> {
    this.starting ??= this.startAll().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  get catalogTools(): readonly CatalogTool[] {
    return this.catalog;
  }

  get serverStates(): ServerState[] {
    return [...this.states.values()];
  }

  /** Calls a catalog tool ("<server>__<tool>") on its server. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutput> {
    const tool = this.catalog.find((t) => t.name === name);
    if (!tool) return { text: `There is no tool named ${name}.`, isError: true };
    const connection = this.connections.get(tool.server);
    if (!connection) return { text: `The ${tool.server} tools aren't running. Try again.`, isError: true };
    try {
      return await connection.callTool(tool.tool, args, signal);
    } catch (err) {
      return { text: `${name} failed: ${(err as Error).message}`, isError: true };
    }
  }

  async stop(): Promise<void> {
    const all = [...this.connections.values()];
    this.connections.clear();
    this.tools.clear();
    this.rebuild();
    for (const name of this.states.keys()) this.states.set(name, { name, status: 'stopped' });
    await Promise.allSettled(all.map((c) => c.close()));
    this.onChange();
  }

  private async startAll(): Promise<void> {
    const specs = await this.specs();
    await Promise.all(specs.filter((s) => !this.connections.has(s.name)).map((s) => this.startOne(s)));
    this.rebuild();
    this.onChange();
  }

  private async startOne(spec: McpServerSpec): Promise<void> {
    this.states.set(spec.name, { name: spec.name, status: 'starting' });
    this.onChange();
    try {
      const connection = await this.connect(spec);
      const tools = await connection.listTools();
      connection.onClose(() => {
        if (this.connections.get(spec.name) !== connection) return;
        this.connections.delete(spec.name);
        this.tools.delete(spec.name);
        this.states.set(spec.name, { name: spec.name, status: 'stopped', error: 'The server exited.' });
        this.rebuild();
        this.onChange();
      });
      this.connections.set(spec.name, connection);
      this.tools.set(spec.name, tools);
      this.states.set(spec.name, { name: spec.name, status: 'ready' });
    } catch (err) {
      this.states.set(spec.name, { name: spec.name, status: 'failed', error: (err as Error).message });
    }
  }

  private rebuild(): void {
    this.catalog = buildCatalog(this.tools);
  }
}
