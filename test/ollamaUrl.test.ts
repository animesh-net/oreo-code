import { describe, expect, it } from 'vitest';
import { normalizeOllamaUrl } from '../src/ollama/url';

describe('normalizeOllamaUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeOllamaUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(normalizeOllamaUrl('  http://100.64.0.2:11434//  ')).toBe('http://100.64.0.2:11434');
  });

  it('rejects empty, invalid and non-http values', () => {
    expect(() => normalizeOllamaUrl('')).toThrow(/empty/);
    expect(() => normalizeOllamaUrl('not a url')).toThrow(/not a valid URL/);
    expect(() => normalizeOllamaUrl('ftp://host')).toThrow(/http:\/\/ or https:\/\//);
    expect(() => normalizeOllamaUrl('http://host/?x=1')).toThrow(/query string/);
  });
});
