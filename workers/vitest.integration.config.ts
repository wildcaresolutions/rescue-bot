import { defineConfig } from 'vitest/config'

// Integration tier: plain Node runner firing real HTTP at the deployed test
// worker. No Workers pool, no mocks — real D1/Vectorize/AI over the wire.
// Run via: make cf-test-integration (sets BASE_URL, SIGNING_SECRET, etc.)
export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    retry: process.env.CI ? 1 : 0,
  },
})
