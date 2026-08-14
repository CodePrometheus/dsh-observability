import { defineConfig } from 'vitest/config'

/**
 * REAL-composition tier: boots an application through the Cordis Loader with a
 * fixture `cordis.yml` that loads this package's BUILT `lib/index.js` — the
 * same file a deployment loads — and asserts the OTLP payload a mock collector
 * received. Requires `npm run build` first; assertions target the wire, never
 * package internals.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.ts'],
    environment: 'node',
    // One collector port and one Loader-booted application per file.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
