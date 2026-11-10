import { describe, expect, it } from 'vitest';
import { ALLOWED_WRITES, buildCatalog, classify, toFunctionTools, type McpToolInfo } from '../src/agent/catalog';

const schema = { type: 'object', properties: {} };
const read = (name: string): McpToolInfo => ({
  name,
  description: `${name} tool`,
  inputSchema: schema,
  annotations: { readOnlyHint: true },
});
const write = (name: string): McpToolInfo => ({ name, inputSchema: schema, annotations: { readOnlyHint: false } });

describe('buildCatalog', () => {
  it('namespaces tools by server and sorts them', () => {
    const catalog = buildCatalog(new Map([['github', [read('search_code'), read('get_file_contents')]]]));
    expect(catalog.map((t) => t.name)).toEqual(['github__get_file_contents', 'github__search_code']);
    expect(catalog[0]).toMatchObject({ server: 'github', tool: 'get_file_contents', toolClass: 'read' });
  });

  it('keeps only the allowed write tools', () => {
    const catalog = buildCatalog(
      new Map([
        [
          'github',
          [
            write('create_branch'),
            write('push_files'),
            write('create_or_update_file'),
            write('create_pull_request'),
            write('merge_pull_request'),
            write('delete_file'),
            write('fork_repository'),
            write('update_pull_request'),
          ],
        ],
      ]),
    );
    expect(catalog.map((t) => t.name)).toEqual([...ALLOWED_WRITES].sort());
    expect(catalog.every((t) => t.toolClass === 'write')).toBe(true);
  });

  it('treats a tool without a read-only annotation as a write, and so leaves it out', () => {
    expect(classify({ name: 'x', inputSchema: schema })).toBe('write');
    expect(buildCatalog(new Map([['github', [{ name: 'mystery', inputSchema: schema }]]]))).toEqual([]);
  });

  it('drops names an OpenAI function name cannot hold', () => {
    expect(buildCatalog(new Map([['github', [read('bad name!'), read('x'.repeat(80))]]]))).toEqual([]);
  });

  it('falls back to the title or name when a tool has no description', () => {
    const [tool] = buildCatalog(
      new Map([
        ['github', [{ name: 'get_me', inputSchema: schema, annotations: { readOnlyHint: true, title: 'Who am I' } }]],
      ]),
    );
    expect(tool.description).toBe('Who am I');
  });
});

describe('toFunctionTools', () => {
  it('produces OpenAI function definitions', () => {
    const tools = toFunctionTools(buildCatalog(new Map([['github', [read('get_me')]]])));
    expect(tools).toEqual([
      { type: 'function', function: { name: 'github__get_me', description: 'get_me tool', parameters: schema } },
    ]);
  });
});
