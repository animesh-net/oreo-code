import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, normalizeOllamaUrl, tailscaleOllamaUrls } from '../src/ollama/url';

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

  it('names the setting it checks, such as oreo.cloudUrl', () => {
    expect(normalizeOllamaUrl('https://ai.animesh.org.in/v1/', 'oreo.cloudUrl')).toBe('https://ai.animesh.org.in/v1');
    expect(() => normalizeOllamaUrl('ftp://host', 'oreo.cloudUrl')).toThrow(/"oreo\.cloudUrl" must start/);
  });
});

describe('tailscaleOllamaUrls', () => {
  it("finds the Mac's Tailscale address, keeping the configured port", () => {
    const interfaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { address: '192.168.1.20', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      utun4: [
        { address: '100.100.10.20', family: 'IPv4', internal: false },
        { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false },
      ],
    };
    expect(tailscaleOllamaUrls('http://127.0.0.1:11434', interfaces)).toEqual(['http://100.100.10.20:11434']);
    expect(tailscaleOllamaUrls('http://localhost:9999', interfaces)).toEqual(['http://100.100.10.20:9999']);
  });

  it('ignores addresses outside 100.64.0.0/10', () => {
    const interfaces = {
      en0: [
        { address: '100.63.0.1', family: 'IPv4', internal: false },
        { address: '100.128.0.1', family: 4, internal: false },
      ],
    };
    expect(tailscaleOllamaUrls('http://127.0.0.1:11434', interfaces)).toEqual([]);
  });

  it('treats only local addresses as loopback', () => {
    expect(isLoopbackUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLoopbackUrl('http://localhost:11434')).toBe(true);
    expect(isLoopbackUrl('http://100.100.10.20:11434')).toBe(false);
  });
});
