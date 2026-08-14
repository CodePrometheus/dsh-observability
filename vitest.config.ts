import { defineConfig } from 'vitest/config'

/**
 * Unit tests: the folding projection, identifier derivation, attribute
 * mapping, and the config fail-loud paths. Everything here runs against
 * source with no network, no collector, and no booted application — the
 * assembled-application assertions live in vitest.e2e.config.ts.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
