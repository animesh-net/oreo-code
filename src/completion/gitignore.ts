interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/**
 * A small .gitignore matcher for the repository root's file: comments, `!` negation,
 * a leading `/` anchor, a trailing `/` for folders, `*`, `?` and `**`. Enough to keep
 * ignored files out of completion; not every corner of git's rules.
 */
export class GitIgnore {
  private readonly rules: Rule[] = [];

  constructor(text = '') {
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      if (negate) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      if (!line) continue;
      const body = line
        .split('**')
        .map((part) =>
          part
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]'),
        )
        .join('.*');
      const re = new RegExp(`${anchored ? '^' : '(^|/)'}${body}(/|$)`);
      this.rules.push({ re, negate, dirOnly });
    }
  }

  /** Whether a workspace-relative file path is ignored. */
  ignores(path: string): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      const m = rule.re.exec(path);
      if (!m) continue;
      // A folder-only rule must match a folder: something follows the match in the path.
      if (rule.dirOnly && m.index + m[0].length >= path.length && !m[0].endsWith('/')) continue;
      ignored = !rule.negate;
    }
    return ignored;
  }
}
