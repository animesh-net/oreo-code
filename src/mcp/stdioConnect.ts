import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpToolInfo } from '../agent/catalog';
import type { Connect, McpConnection, ToolOutput } from './host';

/** Connects to an MCP server by starting it as a child process (stdio transport). */
export const stdioConnect =
  (clientVersion: string): Connect =>
  async (spec) => {
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      // A minimal environment (PATH, HOME, …) plus what the server needs; never the
      // whole VS Code environment.
      env: { ...getDefaultEnvironment(), ...spec.env },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'oreo-code', version: clientVersion });
    await client.connect(transport);

    const listeners: Array<() => void> = [];
    client.onclose = () => listeners.forEach((l) => l());

    const connection: McpConnection = {
      async listTools() {
        const tools: McpToolInfo[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          tools.push(...(page.tools as McpToolInfo[]));
          cursor = page.nextCursor;
        } while (cursor);
        return tools;
      },
      async callTool(name, args, signal): Promise<ToolOutput> {
        const result = await client.callTool({ name, arguments: args }, undefined, { signal });
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content
          .map((part: { type?: string; text?: string }) =>
            part.type === 'text' ? (part.text ?? '') : `[${part.type} content]`,
          )
          .join('\n');
        return { text, isError: result.isError === true };
      },
      close: () => client.close(),
      onClose: (listener) => listeners.push(listener),
    };
    return connection;
  };
