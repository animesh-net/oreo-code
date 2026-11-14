import { describe, expect, it } from 'vitest';
import { checksSyntax, syntaxProblem } from '../src/agent/syntax';

describe('syntaxProblem', () => {
  it('finds the line of a stray catch, as in the broken server', () => {
    const text = "import fs from 'fs';\nfunction serve() {\n  run();\n}\n} catch (e) {\n}\n";
    expect(syntaxProblem('server/index.js', text)).toEqual({ line: 5, message: 'Unexpected token' });
    const noCatch = 'function serve() {\n  try {\n    run();\n  }\n}\n';
    expect(syntaxProblem('server/index.js', noCatch)).toMatchObject({
      line: 2,
      message: 'Missing catch or finally clause',
    });
  });

  it('accepts modules, CommonJS with a top-level return, JSX, top-level await and a hashbang', () => {
    expect(syntaxProblem('a.mjs', "import x from 'x';\nexport default x;\n")).toBeUndefined();
    expect(syntaxProblem('a.cjs', "const x = require('x');\nif (!x) return;\nmodule.exports = x;\n")).toBeUndefined();
    expect(syntaxProblem('App.jsx', 'export const App = () => <div className="a">{1 + 1}</div>;\n')).toBeUndefined();
    expect(syntaxProblem('a.js', 'const r = await fetch(u);\n')).toBeUndefined();
    expect(syntaxProblem('bin/cli.js', '#!/usr/bin/env node\nconsole.log(1);\n')).toBeUndefined();
  });

  it('leaves Flow and decorators to VS Code', () => {
    expect(syntaxProblem('a.js', '// @flow\nfunction f(x: number): string { return x; }\n')).toBeUndefined();
    expect(syntaxProblem('a.js', '@Component()\nclass A {}\n')).toBeUndefined();
  });

  it("checks an HTML page's inline scripts at their own lines, not src or JSON ones", () => {
    const page = [
      '<!DOCTYPE html>',
      '<html><body>',
      '<script src="app.js"></script>',
      '<script type="application/json">{ not js }</script>',
      '<script>',
      '  function add(a, b) {',
      '    return a + b;',
      '  ',
      '</script>',
      '</body></html>',
    ].join('\n');
    expect(syntaxProblem('public/calculator.html', page)).toEqual({ line: 9, message: 'Unexpected token' });
    expect(
      syntaxProblem('public/ok.html', '<script type="module">\nimport x from "./x.js";\n</script>'),
    ).toBeUndefined();
  });

  it('checks JSON, but not JSON with comments', () => {
    expect(syntaxProblem('package.json', '{\n  "name": "x",\n  "scripts": {\n}\n')).toMatchObject({ line: 5 });
    expect(syntaxProblem('package.json', '{ "name": "x" }\n')).toBeUndefined();
    expect(checksSyntax('tsconfig.json')).toBe(false);
    expect(checksSyntax('.vscode/settings.json')).toBe(false);
    expect(checksSyntax('src/app.ts')).toBe(false);
  });
});
