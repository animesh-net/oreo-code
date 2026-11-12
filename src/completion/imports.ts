const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/** The language a path is treated as, for imports and symbols. */
export function languageOf(path: string): 'js' | 'csharp' | 'python' | undefined {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (JS_EXTENSIONS.includes(ext)) return 'js';
  if (ext === '.cs') return 'csharp';
  if (ext === '.py') return 'python';
  return undefined;
}

/**
 * The workspace files the current file imports, as far as can be told from its text:
 * relative imports in TypeScript and JavaScript, Python modules, and for C# the files
 * in folders that match a `using` namespace. `files` is the workspace listing.
 */
export function resolveImports(path: string, text: string, files: readonly string[]): string[] {
  const listed = new Set(files);
  const found: string[] = [];
  const add = (p: string | undefined) => {
    if (p && p !== path && listed.has(p) && !found.includes(p)) found.push(p);
  };
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  switch (languageOf(path)) {
    case 'js': {
      const re =
        /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
      for (const m of text.matchAll(re)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (!spec?.startsWith('.')) continue;
        const base = join(dir, spec);
        const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
        const candidates = [
          base,
          ...JS_EXTENSIONS.map((e) => stem + e),
          ...JS_EXTENSIONS.map((e) => `${base}/index${e}`),
        ];
        add(candidates.find((c) => listed.has(c)));
      }
      break;
    }
    case 'python': {
      const re = /^\s*(?:from\s+(\.*)([\w.]*)\s+import\s+([\w, ]+)|import\s+([\w.]+))/gm;
      for (const m of text.matchAll(re)) {
        const dots = m[1] ?? '';
        const module = (m[2] ?? m[4] ?? '').replace(/\./g, '/');
        let root = '';
        if (dots) {
          root = dir;
          for (let i = 1; i < dots.length; i++) root = root.includes('/') ? root.slice(0, root.lastIndexOf('/')) : '';
        }
        const names = m[3]
          ? m[3]
              .split(',')
              .map((n) => n.trim())
              .filter(Boolean)
          : [];
        const bases = module ? [join(root, module)] : names.map((n) => join(root, n));
        // `from pkg import mod` may name a module rather than a symbol.
        if (module) for (const n of names) bases.push(join(root, `${module}/${n}`));
        for (const b of bases) add([`${b}.py`, `${b}/__init__.py`].find((c) => listed.has(c)));
        // Absolute imports may be rooted at the file's folder too.
        if (!dots && module) add([`${join(dir, module)}.py`].find((c) => listed.has(c)));
      }
      break;
    }
    case 'csharp': {
      const folders = new Set<string>();
      for (const m of text.matchAll(/^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
        const parts = m[1].split('.');
        // A namespace usually ends in the folder that holds it: OreoAi.Web.Chat -> .../Chat.
        folders.add(parts.slice(-2).join('/'));
        if (parts.length > 1) folders.add(parts[parts.length - 1]);
      }
      for (const f of files) {
        if (!f.endsWith('.cs') || f === path) continue;
        const fileDir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
        for (const folder of folders) {
          if (fileDir === folder || fileDir.endsWith(`/${folder}`)) {
            add(f);
            break;
          }
        }
      }
      break;
    }
  }
  return found;
}

/** Joins a folder and a relative path, resolving `.` and `..`. */
export function join(dir: string, rel: string): string {
  const parts = dir ? dir.split('/') : [];
  for (const p of rel.split('/')) {
    if (p === '.' || p === '') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
}
