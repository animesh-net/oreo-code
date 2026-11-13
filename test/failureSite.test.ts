import { describe, expect, it } from 'vitest';
import { failureSite, linesAround } from '../src/agent/failureSite';

const files = ['server/index.js', 'public/index.html', 'app/calc.py', 'package.json'];

describe('failureSite', () => {
  it("finds the line Node prints above a SyntaxError, under the module loader's frames", () => {
    const out = `> start\n> node server/index.js\n\nfile:///private/var/folders/jv/T/oreo-e2e-x/server/index.js:31\n    } catch (e) {\n      ^^^^^\n\nSyntaxError: Unexpected token 'catch'\n    at compileSourceTextModule (node:internal/modules/esm/utils:318:16)\n\nNode.js v24.14.0`;
    expect(failureSite(out, files)).toEqual({ path: 'server/index.js', line: 31 });
  });

  it('finds the first frame in the repository, skipping node_modules and Node itself', () => {
    const out = `TypeError: fs.existsSync is not a function\n    at Object.<anonymous> (/Users/a/p/node_modules/x/index.js:3:1)\n    at serve (/Users/a/p/server/index.js:12:9)\n    at node:internal/process/task_queues:105:5`;
    expect(failureSite(out, files)).toEqual({ path: 'server/index.js', line: 12 });
  });

  it('reads Python tracebacks and relative paths', () => {
    expect(failureSite('Traceback:\n  File "app/calc.py", line 4, in add\nTypeError', files)).toEqual({
      path: 'app/calc.py',
      line: 4,
    });
    expect(failureSite('server/index.js:7:3 error', files)).toEqual({ path: 'server/index.js', line: 7 });
  });

  it('finds nothing outside the repository', () => {
    expect(failureSite('at x (/Users/a/other/thing.js:3:1)', files)).toBeUndefined();
    expect(failureSite('Error: listen EADDRINUSE: address already in use :::3000', files)).toBeUndefined();
  });

  it('shows the numbered lines around the failing one, marked', () => {
    const text = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n');
    expect(linesAround('a.js', text, 2)).toBe(
      'It fails at line 2 of a.js:\n  1: line1\n> 2: line2\n  3: line3\n  4: line4\n  5: line5\n  6: line6',
    );
  });
});
