import MarkdownIt from 'markdown-it';

/**
 * Model output is untrusted, so: raw HTML is escaped (html: false), images are off
 * (the CSP blocks them anyway), and links must be http or https.
 */
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
md.disable(['image']);
md.validateLink = (url: string) => /^https?:\/\//i.test(url.trim());

export function renderMarkdown(text: string): string {
  return md.render(text);
}
