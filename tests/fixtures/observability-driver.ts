#!/usr/bin/env node
/**
 * Test driver: start a mock OTLP collector, boot the fixture Loader
 * composition against it, run one mocked-model turn with a real bash round
 * trip, then persist everything the collector captured to
 * `./otlp-captures.json` for the e2e's inspect step.
 *
 * Erasable-syntax TypeScript only: runs under plain Node type stripping.
 */

import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('observability driver requires a config path')

interface Capture {
  path: string
  contentType: string | undefined
  body: unknown
}

const captures: Capture[] = []
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', chunk => chunks.push(chunk as Buffer))
  request.on('end', () => {
    captures.push({
      path: request.url ?? '',
      contentType: request.headers['content-type'],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    })
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('collector has no port')
// The fixture config reads this url; the port is assigned per run.
process.env.DSH_OBSERVABILITY_E2E_URL = `http://127.0.0.1:${address.port}/v1/traces`

const ctx = await boot('observability-e2e', resolveConfigPath(configPath, undefined))
try {
  await runFixtureTurn(ctx, { task: 'prove the OTLP trace export' })
} finally {
  // Dispose drains the batch queue through the backend's shutdown, which is
  // also what force-ends any span still open.
  await ctx.fiber.dispose()
}
await writeFile('./otlp-captures.json', JSON.stringify(captures))
server.close()
server.closeAllConnections()
