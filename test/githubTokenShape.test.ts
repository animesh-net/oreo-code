import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
const { validateGithubTokenShape } = await import('../src/auth/githubToken');

describe('validateGithubTokenShape', () => {
  it('accepts fine-grained and classic tokens', () => {
    expect(validateGithubTokenShape('github_pat_abc')).toBeUndefined();
    expect(validateGithubTokenShape(' ghp_abc ')).toBeUndefined();
  });

  it('rejects empty, other prefixes and spaces', () => {
    expect(validateGithubTokenShape('')).toMatch(/fine-grained/);
    expect(validateGithubTokenShape('oreo_abc')).toMatch(/start with/);
    expect(validateGithubTokenShape('ghp_a b')).toMatch(/spaces/);
  });
});
