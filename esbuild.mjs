import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

// The extension host side: Node, CommonJS, `vscode` provided at runtime.
const extension = await esbuild.context({
  ...common,
  entryPoints: ['src/extension.ts'],
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
});

// The chat webview: a browser bundle (Preact), plus its CSS.
const webview = await esbuild.context({
  ...common,
  entryPoints: ['webview-ui/main.tsx'],
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/webview.js',
  jsx: 'automatic',
  jsxImportSource: 'preact',
});

if (watch) {
  await Promise.all([extension.watch(), webview.watch()]);
} else {
  await Promise.all([extension.rebuild(), webview.rebuild()]);
  await Promise.all([extension.dispose(), webview.dispose()]);
}
