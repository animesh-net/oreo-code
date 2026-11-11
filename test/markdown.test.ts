import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../webview-ui/markdown';

describe('renderMarkdown', () => {
  it('renders headings, lists, emphasis and code', () => {
    const html = renderMarkdown('## Bugs\n\n- **one** with `code`\n\n```ts\nconst a = 1;\n```');
    expect(html).toContain('<h2>Bugs</h2>');
    expect(html).toContain('<li><strong>one</strong> with <code>code</code></li>');
    expect(html).toContain('<pre><code class="language-ts">const a = 1;');
  });

  it('escapes raw HTML from the model', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)><script>alert(1)</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('allows only http and https links, and no images', () => {
    expect(renderMarkdown('[ok](https://example.com)')).toContain('<a href="https://example.com">ok</a>');
    expect(renderMarkdown('[bad](javascript:alert(1))')).not.toContain('<a');
    expect(renderMarkdown('[file](file:///etc/passwd)')).not.toContain('<a');
    expect(renderMarkdown('![x](https://example.com/a.png)')).not.toContain('<img');
  });
});
