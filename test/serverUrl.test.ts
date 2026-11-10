import { describe, expect, it } from 'vitest';
import { normalizeServerUrl } from '../src/gateway/serverUrl';

describe('normalizeServerUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeServerUrl('https://ai.animesh.org.in/')).toBe('https://ai.animesh.org.in');
    expect(normalizeServerUrl('  https://host:8443/oreo//  ')).toBe('https://host:8443/oreo');
  });

  it('rejects empty, invalid and non-http values', () => {
    expect(() => normalizeServerUrl('')).toThrow(/empty/);
    expect(() => normalizeServerUrl('not a url')).toThrow(/not a valid URL/);
    expect(() => normalizeServerUrl('ftp://host')).toThrow(/https:\/\/ or http:\/\//);
    expect(() => normalizeServerUrl('https://host/?x=1')).toThrow(/query string/);
  });
});
