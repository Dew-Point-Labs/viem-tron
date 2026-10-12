import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    typecheck: { enabled: true },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
})
