import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
  resolve: {
    alias: { '@': new URL('.', import.meta.url).pathname },
  },
});
