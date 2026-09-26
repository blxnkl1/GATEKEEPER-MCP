import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: 'default',
    // The decision engine logs every verdict at info level by design, which
    // would bury the test report. Silence the logger and assert on it directly
    // in decision.test.ts instead.
    env: { PINO_LOG_LEVEL: 'silent' },
  },
})
