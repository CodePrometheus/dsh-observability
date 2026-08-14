/**
 * Span-construction unit tier: the epoch-to-`HrTime` conversion the exporter
 * timestamps every span with, and the hand-built `ReadableSpan` that replaces
 * a `Tracer`-created one. The sampled-flag assertion guards a silent failure
 * mode — `BatchSpanProcessor.onEnd` discards an unsampled span without any
 * diagnostic.
 */

import { describe, expect, it } from 'vitest'
import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { buildReadableSpan, hrTimeDuration, hrTimeFromEpochMillis } from '../src/otel.ts'
import type { SpanDraft } from '../src/otel.ts'

const RESOURCE = resourceFromAttributes({ 'service.name': 'test' })
const SCOPE = { name: 'test-scope', version: '0.0.0' }

function draft(overrides?: Partial<SpanDraft>): SpanDraft {
  return {
    name: 'turn 0',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    startEpochMillis: 1_000,
    endEpochMillis: 2_500,
    attributes: {},
    events: [],
    ...overrides,
  }
}

describe('hrTimeFromEpochMillis', () => {
  it.each([
    [0, [0, 0]],
    [1_000, [1, 0]],
    [1_500, [1, 500_000_000]],
    [1_755_000_000_123, [1_755_000_000, 123_000_000]],
  ])('converts %d to %j', (millis, expected) => {
    expect(hrTimeFromEpochMillis(millis)).toEqual(expected)
  })

  it('invents no sub-millisecond precision', () => {
    const [, nanos] = hrTimeFromEpochMillis(1_234)
    expect(nanos % 1_000_000).toBe(0)
  })
})

describe('hrTimeDuration', () => {
  it('subtracts within one second', () => {
    expect(hrTimeDuration([1, 200_000_000], [1, 700_000_000])).toEqual([0, 500_000_000])
  })

  it('borrows across a second boundary', () => {
    expect(hrTimeDuration([1, 900_000_000], [2, 100_000_000])).toEqual([0, 200_000_000])
  })

  it('is zero for identical times', () => {
    expect(hrTimeDuration([5, 5], [5, 5])).toEqual([0, 0])
  })
})

describe('buildReadableSpan', () => {
  it('marks the span sampled, without which the processor discards it silently', () => {
    const span = buildReadableSpan(draft(), RESOURCE, SCOPE)
    expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED)
    expect(span.spanContext().traceFlags & TraceFlags.SAMPLED).not.toBe(0)
  })

  it('carries the derived identifiers and reports the span ended', () => {
    const span = buildReadableSpan(draft(), RESOURCE, SCOPE)
    expect(span.spanContext().traceId).toBe('a'.repeat(32))
    expect(span.spanContext().spanId).toBe('b'.repeat(16))
    expect(span.ended).toBe(true)
    expect(span.kind).toBe(SpanKind.INTERNAL)
  })

  it('omits the parent context for a root span', () => {
    expect(buildReadableSpan(draft(), RESOURCE, SCOPE).parentSpanContext).toBeUndefined()
  })

  it('places a child in its parent trace', () => {
    const span = buildReadableSpan(draft({ parentSpanId: 'c'.repeat(16) }), RESOURCE, SCOPE)
    expect(span.parentSpanContext?.spanId).toBe('c'.repeat(16))
    expect(span.parentSpanContext?.traceId).toBe(span.spanContext().traceId)
    expect(span.parentSpanContext?.traceFlags).toBe(TraceFlags.SAMPLED)
  })

  it('derives duration from the source timestamps', () => {
    const span = buildReadableSpan(draft(), RESOURCE, SCOPE)
    expect(span.startTime).toEqual([1, 0])
    expect(span.endTime).toEqual([2, 500_000_000])
    expect(span.duration).toEqual([1, 500_000_000])
  })

  it('leaves status unset unless the draft reported failure', () => {
    expect(buildReadableSpan(draft(), RESOURCE, SCOPE).status).toEqual({ code: SpanStatusCode.UNSET })
  })

  it('reports an error status, with the message when one exists', () => {
    expect(buildReadableSpan(draft({ error: true }), RESOURCE, SCOPE).status)
      .toEqual({ code: SpanStatusCode.ERROR })
    expect(buildReadableSpan(draft({ error: true, errorMessage: 'boom' }), RESOURCE, SCOPE).status)
      .toEqual({ code: SpanStatusCode.ERROR, message: 'boom' })
  })

  it('reports no dropped counts, since this exporter applies no span limits', () => {
    const span = buildReadableSpan(draft(), RESOURCE, SCOPE)
    expect([span.droppedAttributesCount, span.droppedEventsCount, span.droppedLinksCount]).toEqual([0, 0, 0])
    expect(span.links).toEqual([])
  })
})
