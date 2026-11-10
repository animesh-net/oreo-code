import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
const { validateTokenShape } = await import('../src/auth/tokenStore');

describe('validateTokenShape', () => {
  it('accepts oreo_ tokens', () => {
    expect(validateTokenShape('oreo_abc123')).toBeUndefined();
    expect(validateTokenShape('  oreo_abc123  ')).toBeUndefined();
  });

  it('rejects empty, wrong prefix and inner spaces', () => {
    expect(validateTokenShape('')).toMatch(/Settings → API tokens/);
    expect(validateTokenShape('ghp_abc')).toMatch(/start with "oreo_"/);
    expect(validateTokenShape('oreo_ab c')).toMatch(/spaces/);
  });
});
