/**
 * OTLP traces pipeline and manual span construction.
 *
 * This module assembles a `BasicTracerProvider` with a `BatchSpanProcessor`
 * and the OTLP/HTTP trace exporter, then feeds it spans built by hand rather
 * than created through a `Tracer`. The reason is identifier control: a
 * `Tracer` obtains ids from a no-argument `IdGenerator`, so a span created
 * through it cannot carry an identifier derived from `(session.id, turn,
 * step)`, and without that derivation replay produces a second, disconnected
 * tree instead of the same one. `SpanProcessor.onEnd` accepts any
 * `ReadableSpan`, so completed spans go straight to the processor.
 *
 * Batching, retry, queueing, and loss policy remain the SDK's documented
 * behavior; this module neither wraps nor reimplements them.
 *
 * @module dsh-observability/otel
 */

import { SpanKind, SpanStatusCode, TraceFlags, type Attributes, type HrTime, type SpanContext, type SpanStatus } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import type { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type BufferConfig,
  type ReadableSpan,
  type SpanProcessor,
  type TimedEvent,
} from '@opentelemetry/sdk-trace-base'

/** Nanoseconds per millisecond, for epoch-to-`HrTime` conversion. */
const NANOS_PER_MILLI = 1_000_000

/** Milliseconds per second. */
const MILLIS_PER_SECOND = 1_000

/** Nanoseconds per second. */
const NANOS_PER_SECOND = 1_000_000_000

/**
 * Convert epoch milliseconds to the SDK's `HrTime` pair.
 *
 * Session-event times are integer milliseconds, so the nanosecond component
 * is always a whole multiple of 1e6 and no precision is invented.
 * @param epochMillis - Unix epoch milliseconds, as carried by every seam record.
 * @returns the `[seconds, nanoseconds]` pair the SDK and OTLP expect.
 */
export function hrTimeFromEpochMillis(epochMillis: number): HrTime {
  const seconds = Math.floor(epochMillis / MILLIS_PER_SECOND)
  return [seconds, Math.round((epochMillis - seconds * MILLIS_PER_SECOND) * NANOS_PER_MILLI)]
}

/**
 * Difference between two `HrTime` values, normalized so the nanosecond
 * component stays within one second.
 * @param start - the earlier time.
 * @param end - the later time.
 * @returns `end - start` as an `HrTime` duration; negative inputs are not normalized away.
 */
export function hrTimeDuration(start: HrTime, end: HrTime): HrTime {
  let seconds = end[0] - start[0]
  let nanos = end[1] - start[1]
  if (nanos < 0) {
    seconds -= 1
    nanos += NANOS_PER_SECOND
  }
  return [seconds, nanos]
}

/** The constructed SDK pipeline: the provider owns shutdown, the processor receives spans. */
export interface TracePipeline {
  /** Owns shutdown and the flush drain. */
  provider: BasicTracerProvider
  /** Receives completed spans through {@link SpanProcessor.onEnd}. */
  processor: SpanProcessor
  /**
   * The resource handed to the provider, returned because a manually built
   * span carries its own reference and the provider exposes no getter.
   */
  resource: ReadableSpan['resource']
}

/**
 * Assemble the export pipeline.
 *
 * The validated `exporter` object is passed verbatim so every SDK option
 * (`headers`, `timeoutMillis`, `compression`, `keepAlive`, …) reaches the
 * exporter; rebuilding selected fields here would silently drop the rest.
 * @param options - exporter and processor SDK passthroughs plus the resource identity.
 * @returns the provider for shutdown and the processor for span handoff.
 */
export function buildTracePipeline(options: {
  exporter: OTLPExporterNodeConfigBase & { url: string }
  processor?: BufferConfig
  resourceAttributes: Attributes
}): TracePipeline {
  const processor = new BatchSpanProcessor(new OTLPTraceExporter(options.exporter), options.processor)
  const resource = resourceFromAttributes(options.resourceAttributes)
  const provider = new BasicTracerProvider({ resource, spanProcessors: [processor] })
  return { provider, processor, resource }
}

/** Everything a completed span needs, in this package's own vocabulary. */
export interface SpanDraft {
  /** Span name as it appears in the trace UI. */
  name: string
  /** Derived trace id shared by every span of one turn. */
  traceId: string
  /** Derived span id, unique within the trace. */
  spanId: string
  /** Parent's span id; absent for a turn's root span. */
  parentSpanId?: string
  /** Span kind; the harness produces `INTERNAL` spans only. */
  kind?: SpanKind
  /** Epoch milliseconds of the source event that opened the span. */
  startEpochMillis: number
  /** Epoch milliseconds of the source event that closed the span. */
  endEpochMillis: number
  /** Accumulated attributes. */
  attributes: Attributes
  /** Point-in-time events recorded against this span. */
  events: TimedEvent[]
  /** Set when the span's own outcome flag reported failure. */
  error?: boolean
  /** Diagnostic message for a failed span. */
  errorMessage?: string
}

/**
 * Build a completed `ReadableSpan` from a draft.
 *
 * `traceFlags` is always `SAMPLED`: `BatchSpanProcessor.onEnd` drops any span
 * whose sampled bit is clear, without a diagnostic, so an unsampled flag here
 * would silently discard every span. Sampling is a deployment concern handled
 * by the collector, not by this exporter.
 * @param draft - the accumulated span state.
 * @param resource - the provider's resource, which the exporter reads from the span.
 * @param scope - instrumentation scope reported for the span.
 * @returns a `ReadableSpan` ready for {@link SpanProcessor.onEnd}.
 */
export function buildReadableSpan(
  draft: SpanDraft,
  resource: ReadableSpan['resource'],
  scope: ReadableSpan['instrumentationScope'],
): ReadableSpan {
  const spanContext: SpanContext = {
    traceId: draft.traceId,
    spanId: draft.spanId,
    traceFlags: TraceFlags.SAMPLED,
  }
  const startTime = hrTimeFromEpochMillis(draft.startEpochMillis)
  const endTime = hrTimeFromEpochMillis(draft.endEpochMillis)
  const status: SpanStatus = draft.error === true
    ? {
      code: SpanStatusCode.ERROR,
      ...draft.errorMessage === undefined ? {} : { message: draft.errorMessage },
    }
    : { code: SpanStatusCode.UNSET }
  return {
    name: draft.name,
    kind: draft.kind ?? SpanKind.INTERNAL,
    spanContext: () => spanContext,
    ...draft.parentSpanId === undefined ? {} : {
      parentSpanContext: {
        traceId: draft.traceId,
        spanId: draft.parentSpanId,
        traceFlags: TraceFlags.SAMPLED,
      },
    },
    startTime,
    endTime,
    status,
    attributes: draft.attributes,
    links: [],
    events: draft.events,
    duration: hrTimeDuration(startTime, endTime),
    ended: true,
    resource,
    instrumentationScope: scope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  }
}
