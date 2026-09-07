import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': new URL('.', import.meta.url).pathname,
      // `server-only` throws on import outside RSC; stub it so server modules are testable.
      'server-only': new URL('./tests/stubs/server-only.ts', import.meta.url).pathname,
    },
  },
});
