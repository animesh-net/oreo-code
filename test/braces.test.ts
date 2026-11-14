import { describe, expect, it } from 'vitest';
import { braceHint, scanBraces } from '../src/agent/braces';
import { syntaxProblem } from '../src/agent/syntax';

/** Like the calculator server: a stray `}` on line 8 closes the try early. */
const STRAY_CLOSE = [
  "import { createServer } from 'http';", // 1
  'async function handle(request, response) {', // 2
  '    try {', // 3
  "        if (request.url === '/calculator/api/calculate') {", // 4
  '            const result = calculate(request);', // 5
  '            response.end(JSON.stringify({ result }));', // 6
  '        }', // 7
  '        }', // 8  <- stray: closes the try
  '        console.log(`Response: ${request.url} - 200`);', // 9
  '    } catch (e) {', // 10
  '        console.error(e.message);', // 11
  '    }', // 12
  '}', // 13
].join('\n');

describe('braceHint', () => {
  it('names the stray brace that closed the try before its catch', () => {
    // acorn reports the try (line 3); Node reports the catch (line 10): both get the fix.
    expect(syntaxProblem('server/index.js', STRAY_CLOSE)).toMatchObject({ line: 3 });
    expect(braceHint(STRAY_CLOSE, 3)).toBe(
      'The `try {` from line 3 is closed by the `}` on line 8, so the `catch` on line 10 has nothing to follow. Remove that extra `}` on line 8.',
    );
    expect(braceHint(STRAY_CLOSE, 10)).toBe(
      'The `}` before `catch` on line 10 closes `async function handle(request, response) {` from line 2, not a `try` block: the `try {` from line 3 was already closed by the `}` on line 8. Remove that extra `}` on line 8.',
    );
  });

  it('says when no try is open at all', () => {
    const text = 'function f() {\n  run();\n} catch (e) {\n}\n';
    expect(braceHint(text, 3)).toMatch(/closes `function f\(\) \{` from line 1, and no `try \{` is open before it/);
  });

  it('handles else the same way', () => {
    const joined = 'function f(x) {\n  if (x) {\n    a();\n  }\n  b();\n  } else {\n  }\n}\n';
    expect(braceHint(joined, 6)).toMatch(/the `if \(x\) \{` from line 2 was already closed by the `\}` on line 4/);
  });

  it('points at a brace with nothing to close, or a block never closed', () => {
    expect(braceHint('function f() {\n}\n}\n', 3)).toBe(
      'The `}` on line 3 has no `{` to close. Remove it, or add the `{` it was meant to close.',
    );
    expect(braceHint('function f() {\n  if (x) {\n    a();\n}\n', 4)).toBe(
      'The `function f() {` from line 1 is never closed. Add its `}`.',
    );
  });

  it('ignores braces in strings, template literals, comments and regular expressions', () => {
    const text = [
      'const a = "{";',
      "const b = '}';",
      'const c = `x ${ { y: 1 }.y } }`;',
      '// }',
      '/* { */',
      'const d = /[{}]/.test(s);',
      'function f() { return 1; }',
    ].join('\n');
    const scan = scanBraces(text);
    expect(scan?.stray).toEqual([]);
    expect(scan?.blocks.filter((b) => b.close === undefined)).toEqual([]);
    expect(braceHint(text, 7)).toBeUndefined();
  });
});
