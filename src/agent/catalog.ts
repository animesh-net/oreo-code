/** A tool as an MCP server lists it (the fields the catalog uses). */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

/** read: runs straight away. write: needs your approval first. */
export type ToolClass = 'read' | 'write';

export interface CatalogTool {
  /** Name the model sees: "<server>__<tool>", e.g. "github__get_file_contents". */
  name: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  toolClass: ToolClass;
}

/** An OpenAI-style function definition, as sent to the oreo-ai gateway. */
export interface FunctionTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * The only write tools offered. Any other tool that isn't read-only — merges,
 * deletes, forks, new repositories, settings, reviews, issues — is left out, so the
 * agent can create branches, commit and open pull requests, and nothing else.
 */
export const ALLOWED_WRITES: ReadonlySet<string> = new Set([
  'github__create_branch',
  'github__push_files',
  'github__create_or_update_file',
  'github__create_pull_request',
]);

/** Tools whose class is fixed here rather than taken from the server's annotations. */
export const CLASS_OVERRIDES: Readonly<Record<string, ToolClass>> = {};

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Turns each server's tools into the catalog: namespaced, classed and filtered. */
export function buildCatalog(servers: ReadonlyMap<string, readonly McpToolInfo[]>): CatalogTool[] {
  const tools: CatalogTool[] = [];
  for (const [server, list] of servers) {
    for (const tool of list) {
      const name = `${server}__${tool.name}`;
      if (!NAME.test(name)) continue;
      const toolClass = CLASS_OVERRIDES[name] ?? classify(tool);
      if (toolClass === 'write' && !ALLOWED_WRITES.has(name)) continue;
      tools.push({
        name,
        server,
        tool: tool.name,
        description: tool.description?.trim() || tool.annotations?.title || tool.name,
        inputSchema: tool.inputSchema,
        toolClass,
      });
    }
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/** Only a tool that says it is read-only runs without approval; anything else is a write. */
export function classify(tool: McpToolInfo): ToolClass {
  return tool.annotations?.readOnlyHint === true ? 'read' : 'write';
}

export function toFunctionTools(tools: readonly CatalogTool[]): FunctionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}
