/**
 * REAL-composition tier: boot the fixture Loader composition as a subprocess
 * through the same app/boot path a deployment uses, run one mocked-model turn
 * with a real bash round trip, and assert against what the mock OTLP collector
 * actually received on the wire — the traces path, the turn/step/tool span
 * tree, derived identifiers linking parent to child, and the full
 * `gen_ai.usage.*` set.
 *
 * Requires the built artifact (`npm run build`): the fixture loads
 * `lib/index.js`, the same file a deployment loads.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { TOOL_MARKER } from './fixtures/mock-llm.ts'

const driver = fileURLToPath(new URL('./fixtures/observability-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/observability.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url))

/** Just the slice of ExportTraceServiceRequest JSON these assertions touch. */
interface OtlpSpan {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  attributes?: { key: string; value: Record<string, unknown> }[]
  status?: { code?: number }
}

interface Capture {
  path: string
  contentType: string | undefined
  body: {
    resourceSpans?: {
      resource?: { attributes?: { key: string; value: Record<string, unknown> }[] }
      scopeSpans?: { scope?: { name?: string }; spans?: OtlpSpan[] }[]
    }[]
  }
}

/** Read one attribute's unwrapped scalar from a span. */
function attr(span: OtlpSpan, key: string): unknown {
  const value = span.attributes?.find(entry => entry.key === key)?.value
  if (value === undefined) return undefined
  return value['stringValue'] ?? value['intValue'] ?? value['doubleValue'] ?? value['boolValue']
}

function allSpans(captures: Capture[]): OtlpSpan[] {
  return captures.flatMap(capture => capture.body.resourceSpans?.flatMap(resource =>
    resource.scopeSpans?.flatMap(scoped => scoped.spans ?? []) ?? []) ?? [])
}

describe('dsh-observability REAL composition', () => {
  it('exports the turn/step/tool span tree over OTLP traces', { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS }, async () => {
    let captures!: Capture[]
    const { stderr } = await runLoaderSmoke({
      label: 'dsh-observability',
      tempDirPrefix: 'dsh-observability-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath,
      // Installed built packages resolve through real `exports`; no tsx.
      mode: 'lib',
      inspect: async (cwd) => {
        captures = JSON.parse(await readFile(join(cwd, 'otlp-captures.json'), 'utf8')) as Capture[]
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(captures.length).toBeGreaterThan(0)
    for (const capture of captures) expect(capture.path).toBe('/v1/traces')

    const spans = allSpans(captures)
    const turn = spans.find(span => span.name.startsWith('turn '))
    const steps = spans.filter(span => span.name.startsWith('step '))
    const tool = spans.find(span => span.name === 'tool bash')
    expect(turn, 'turn span').toBeDefined()
    expect(steps.length, 'one step per model request').toBeGreaterThanOrEqual(2)
    expect(tool, 'tool span').toBeDefined()

    // One trace per turn: every span shares the derived trace id and the turn
    // span is the only root.
    expect(new Set(spans.map(span => span.traceId)).size).toBe(1)
    expect(turn?.parentSpanId ?? '').toBe('')

    // The tool span nests under the step that issued the call, not the turn.
    const requestingStep = steps.find(step => step.spanId === tool?.parentSpanId)
    expect(requestingStep, 'tool parent is a step span').toBeDefined()
    expect(requestingStep?.parentSpanId).toBe(turn?.spanId)
  })

  it('carries GenAI attributes including cache-write tokens', { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS }, async () => {
    let captures!: Capture[]
    await runLoaderSmoke({
      label: 'dsh-observability attributes',
      tempDirPrefix: 'dsh-observability-attrs-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath,
      mode: 'lib',
      inspect: async (cwd) => {
        captures = JSON.parse(await readFile(join(cwd, 'otlp-captures.json'), 'utf8')) as Capture[]
      },
    })

    const spans = allSpans(captures)
    const step = spans.find(span => span.name.startsWith('step '))
    expect(attr(step!, 'gen_ai.operation.name')).toBe('chat')
    expect(attr(step!, 'gen_ai.request.model')).toBe('observability-mock')
    expect(attr(step!, 'gen_ai.provider.name')).toBe('observability-mock')
    expect(Number(attr(step!, 'gen_ai.usage.input_tokens'))).toBeGreaterThan(0)
    expect(Number(attr(step!, 'gen_ai.usage.output_tokens'))).toBeGreaterThan(0)
    expect(Number(attr(step!, 'gen_ai.usage.cache_read_input_tokens'))).toBeGreaterThan(0)
    // The field the reference implementation omits; cache writes are billed.
    expect(Number(attr(step!, 'gen_ai.usage.cache_creation_input_tokens'))).toBeGreaterThan(0)
    expect(Number(attr(step!, 'gen_ai.usage.reasoning_tokens'))).toBeGreaterThan(0)
    // The one shipped chunk per step is what makes this derivable.
    expect(Number(attr(step!, 'dsh.step.time_to_first_chunk_ms'))).toBeGreaterThanOrEqual(0)

    const tool = spans.find(span => span.name === 'tool bash')
    expect(attr(tool!, 'gen_ai.operation.name')).toBe('execute_tool')
    expect(attr(tool!, 'gen_ai.tool.name')).toBe('bash')
    // The real bash round trip reached the exported tool span.
    expect(String(attr(tool!, 'dsh.tool.output'))).toContain(TOOL_MARKER)

    const turn = spans.find(span => span.name.startsWith('turn '))
    expect(attr(turn!, 'dsh.turn.end_reason')).toBe('completed')
    // A cleanly terminated tree needs no force-end marker anywhere.
    expect(spans.some(span => attr(span, 'dsh.force_ended') === true)).toBe(false)
  })
})
