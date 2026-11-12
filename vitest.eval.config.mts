import { defineConfig } from 'vitest/config';

// The live eval (npm run eval): real model, real projects; not part of npm test or CI.
export default defineConfig({
  test: {
    include: ['test/eval/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
  },
});
