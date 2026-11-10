import { describe, expect, it } from 'vitest';
import type { CatalogTool } from '../src/agent/catalog';
import { capResult, decide, MAX_RESULT_CHARS } from '../src/agent/policy';

const tool = (name: string, toolClass: 'read' | 'write' = 'write'): CatalogTool => ({
  name: `github__${name}`,
  server: 'github',
  tool: name,
  description: name,
  inputSchema: {},
  toolClass,
});
const repo = { owner: 'animesh-net', repo: 'oreo-ai' };

describe('decide', () => {
  it('runs reads straight away', () => {
    expect(decide(tool('get_file_contents', 'read'), { ...repo, path: 'README.md' })).toEqual({ kind: 'run' });
  });

  it('asks before creating an agent branch, and refuses any other name', () => {
    expect(decide(tool('create_branch'), { ...repo, branch: 'oreo-agent/fix-typo' })).toMatchObject({
      kind: 'approve',
      summary: 'Create branch oreo-agent/fix-typo from the default branch in animesh-net/oreo-ai',
    });
    expect(decide(tool('create_branch'), { ...repo, branch: 'feature/x' })).toMatchObject({ kind: 'refuse' });
    expect(decide(tool('create_branch'), { ...repo, branch: 'oreo-agent/' })).toMatchObject({ kind: 'refuse' });
  });

  it('never writes to main, master or a branch the agent did not make', () => {
    for (const branch of ['main', 'master', 'feature/x', '', undefined]) {
      expect(decide(tool('push_files'), { ...repo, branch, files: [], message: 'x' })).toMatchObject({
        kind: 'refuse',
      });
      expect(
        decide(tool('create_or_update_file'), { ...repo, branch, path: 'a', content: 'b', message: 'c' }),
      ).toMatchObject({
        kind: 'refuse',
      });
    }
  });

  it('asks before committing to an agent branch, with a one-line summary', () => {
    expect(
      decide(tool('push_files'), { ...repo, branch: 'oreo-agent/x', files: [{}, {}], message: 'Fix typo' }),
    ).toEqual({ kind: 'approve', summary: 'Commit 2 files to oreo-agent/x in animesh-net/oreo-ai: Fix typo' });
  });

  it('opens pull requests only from an agent branch into main', () => {
    expect(
      decide(tool('create_pull_request'), { ...repo, title: 'Fix', head: 'oreo-agent/x', base: 'main' }),
    ).toMatchObject({
      kind: 'approve',
    });
    expect(
      decide(tool('create_pull_request'), { ...repo, title: 'Fix', head: 'oreo-agent/x', base: 'dev' }),
    ).toMatchObject({
      kind: 'refuse',
      reason: expect.stringContaining('must target main'),
    });
    expect(
      decide(tool('create_pull_request'), { ...repo, title: 'Fix', head: 'feature/x', base: 'main' }),
    ).toMatchObject({
      kind: 'refuse',
    });
  });
});

describe('capResult', () => {
  it('leaves short results alone and cuts long ones with a note', () => {
    expect(capResult('short')).toBe('short');
    const cut = capResult('x'.repeat(MAX_RESULT_CHARS + 5));
    expect(cut.startsWith('x'.repeat(MAX_RESULT_CHARS))).toBe(true);
    expect(cut).toContain(`Cut at ${MAX_RESULT_CHARS} of ${MAX_RESULT_CHARS + 5} characters`);
  });
});
