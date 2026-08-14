/**
 * OpenTelemetry GenAI semantic-convention attribute keys and the mapping from
 * the harness's own vocabulary onto them.
 *
 * Two rules govern what lands here. Keys the GenAI semantic conventions define
 * are used verbatim, so a collector that already understands LLM traces reads
 * this exporter's spans without configuration. Facts the conventions do not
 * model — the harness's turn/step coordinates, the session-log sequence, the
 * force-end marker — take a `dsh.` prefix rather than an invented `gen_ai.`
 * key, because a receiver must be able to tell a standard field from ours.
 *
 * @module dsh-observability/semconv
 */

import type { Attributes } from '@opentelemetry/api'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Attribute values an OTLP span accepts for the keys this module produces. */
export type SpanAttributes = Record<string, string | number | boolean>

/**
 * GenAI semantic-convention keys, spelled once. The conventions are still
 * marked experimental upstream, so the exact strings live here rather than
 * being inlined at each use: a convention rename is then one edit.
 */
export const GEN_AI = {
  /** Provider route that served the request (`gen_ai.provider.name`). */
  providerName: 'gen_ai.provider.name',
  /** Model requested by the caller (`gen_ai.request.model`). */
  requestModel: 'gen_ai.request.model',
  /** Sampling temperature, when the conversation set one. */
  requestTemperature: 'gen_ai.request.temperature',
  /** Output-token ceiling, when the conversation set one. */
  requestMaxTokens: 'gen_ai.request.max_tokens',
  /** Prompt tokens billed for the step. */
  usageInputTokens: 'gen_ai.usage.input_tokens',
  /** Completion tokens billed for the step. */
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  /** Prompt tokens served from the provider's cache. */
  usageCacheReadTokens: 'gen_ai.usage.cache_read_input_tokens',
  /** Prompt tokens written into the provider's cache. */
  usageCacheWriteTokens: 'gen_ai.usage.cache_creation_input_tokens',
  /** Reasoning tokens the provider reported separately from output. */
  usageReasoningTokens: 'gen_ai.usage.reasoning_tokens',
  /** Name of the invoked tool. */
  toolName: 'gen_ai.tool.name',
  /** Provider-assigned identifier of the tool call. */
  toolCallId: 'gen_ai.tool.call.id',
  /** Operation the span represents (`chat`, `execute_tool`). */
  operationName: 'gen_ai.operation.name',
} as const

/**
 * Exception-event keys the conventions define. A receiver renders a recorded
 * exception from these attributes, never from the event body, so an event
 * using the reserved `exception` name without them renders empty.
 */
export const EXCEPTION = {
  /** Event name the conventions reserve for a recorded exception. */
  eventName: 'exception',
  /** Exception class name. */
  type: 'exception.type',
  /** Exception message. */
  message: 'exception.message',
} as const

/**
 * Identity attribute keys the telemetry seam puts on every record it hands
 * over. These are READ from `record.attributes`; they are the seam's spelling,
 * not this package's, and must never be confused with the {@link DSH} keys the
 * exporter WRITES onto spans — `event.seq` arrives under this spelling and
 * leaves under `dsh.event.seq`.
 */
export const SEAM_ATTR = {
  /** Session the record belongs to; present on every ledger and ops record. */
  sessionId: 'session.id',
  /** Session-log event type of a ledger record. */
  eventType: 'event.type',
  /** Session-log sequence of a ledger record. */
  eventSeq: 'event.seq',
  /** Working directory, when the session header carried one. */
  sessionCwd: 'session.cwd',
  /** Parent session of a forked stream. */
  sessionParentId: 'session.parent_id',
  /** Length of the inherited prefix a forked stream starts after. */
  sessionSeedLength: 'session.seed_length',
  /** Operation discriminant of an ops record (`agent-error`, `shutdown`). */
  telemetryOp: 'telemetry.op',
  /** Error class name, on an `agent-error` ops record. */
  errorName: 'error.name',
} as const

/**
 * Harness-owned keys the exporter writes onto spans, for facts the GenAI
 * conventions do not model. A receiver correlating duplicate deliveries uses
 * `session.id` + `dsh.turn` + `dsh.step`; `dsh.event.seq` ties a span or span
 * event back to the exact session-log row.
 */
export const DSH = {
  /**
   * Session the span belongs to; the deduplication key's first component. The
   * one key spelled identically in {@link SEAM_ATTR}. The seam's other header
   * facts are copied through {@link SEAM_ATTR} rather than redeclared here, so
   * no exported key has two names to keep in step.
   */
  sessionId: 'session.id',
  /** Turn ordinal within the session. */
  turn: 'dsh.turn',
  /** Step ordinal within the turn. */
  step: 'dsh.step',
  /** Session-log sequence of the event that produced this span or span event. */
  eventSeq: 'dsh.event.seq',
  /** Session-log event type, on span events whose type has no span of its own. */
  eventType: 'dsh.event.type',
  /** Why a turn ended, from the turn/end reason's discriminant tag. */
  turnEndReason: 'dsh.turn.end_reason',
  /** Present and true when a span was closed by a force-end sweep rather than its own end event. */
  forceEnded: 'dsh.force_ended',
  /** Present and true on a turn's root span synthesized because its own `turn/start` never arrived. */
  turnSynthesized: 'dsh.turn.synthesized',
  /** Milliseconds from the step's request to its first streamed chunk. */
  timeToFirstChunkMillis: 'dsh.step.time_to_first_chunk_ms',
  /** The human prompt that opened the turn, on the trace root. */
  turnInput: 'dsh.turn.input',
  /** The step's assembled assistant reply. */
  stepOutput: 'dsh.step.output',
  /** Tool-call arguments as the model produced them, unparsed. */
  toolInput: 'dsh.tool.input',
  /** The tool's model-facing result. */
  toolOutput: 'dsh.tool.output',
  /** Serialized body of a session event recorded as a span event. */
  eventBody: 'dsh.event.body',
  /**
   * Present and true when at least one payload on this span, or on this span
   * event, was clipped to the configured ceiling. The in-band `…[clipped]`
   * marker cannot be trusted for this: a payload may genuinely end in it.
   */
  payloadClipped: 'dsh.payload_clipped',
  /** Reasoning effort the conversation requested, which the conventions do not model. */
  requestReasoningEffort: 'dsh.request.reasoning_effort',
} as const

/** Marker appended to a payload the configured ceiling truncated. */
export const CLIP_MARKER = '…[clipped]'

/**
 * Map a conversation's call configuration onto request attributes.
 *
 * Absent optional fields are omitted rather than exported as null: an absent
 * temperature means the deployment never set one, and a null would read as a
 * configured zero to an aggregating collector.
 * @param config - the logged call configuration from the request header.
 * @returns request attributes for the step's span.
 */
export function requestAttributes(config: LlmCallConfig): SpanAttributes {
  const attributes: SpanAttributes = {
    [GEN_AI.providerName]: config.provider,
    [GEN_AI.requestModel]: config.model,
  }
  if (config.temperature !== undefined) attributes[GEN_AI.requestTemperature] = config.temperature
  if (config.maxTokens !== undefined) attributes[GEN_AI.requestMaxTokens] = config.maxTokens
  if (config.reasoningEffort !== undefined) attributes[DSH.requestReasoningEffort] = String(config.reasoningEffort)
  return attributes
}

/** Every key {@link requestAttributes} can produce, for clearing a superseded header. */
const REQUEST_ATTRIBUTE_KEYS = [
  GEN_AI.providerName,
  GEN_AI.requestModel,
  GEN_AI.requestTemperature,
  GEN_AI.requestMaxTokens,
  DSH.requestReasoningEffort,
] as const

/**
 * Replace a span's request attributes with one call configuration's.
 *
 * Every key the mapping can write is cleared first. A `'change'` header may
 * drop an optional scalar its predecessor set, and merging would leave the
 * superseded value reading as this request's own configuration.
 * @param target - span attributes updated in place.
 * @param config - the logged call configuration from the request header.
 */
export function applyRequestAttributes(target: Attributes, config: LlmCallConfig): void {
  for (const key of REQUEST_ATTRIBUTE_KEYS) delete target[key]
  Object.assign(target, requestAttributes(config))
}

/**
 * Map a step's reported token usage onto usage attributes.
 *
 * `inputTokens` and `outputTokens` are always present in the harness's own
 * type and always exported; the cache and reasoning counts are provider-
 * dependent and omitted when the provider did not report them, so a missing
 * count is distinguishable from a reported zero.
 * @param usage - the token usage the adapter reported for one model request.
 * @returns usage attributes for the step's span.
 */
export function usageAttributes(usage: TokenUsage): SpanAttributes {
  const attributes: SpanAttributes = {
    [GEN_AI.usageInputTokens]: usage.inputTokens,
    [GEN_AI.usageOutputTokens]: usage.outputTokens,
  }
  if (usage.cacheReadTokens !== undefined) attributes[GEN_AI.usageCacheReadTokens] = usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined) attributes[GEN_AI.usageCacheWriteTokens] = usage.cacheWriteTokens
  if (usage.reasoningTokens !== undefined) attributes[GEN_AI.usageReasoningTokens] = usage.reasoningTokens
  return attributes
}

/**
 * Serialize one payload for a span attribute, clipped to a character ceiling.
 *
 * Span attributes are strings, so a structured event body has to be
 * serialized; the ceiling exists because a single tool result can carry a
 * whole file and OTLP has no per-attribute limit of its own. The canonical
 * session log keeps the full bytes either way, so clipping loses nothing
 * durable.
 * @param payload - any JSON-serializable session-event body.
 * @param maxChars - the ceiling on the returned text, marker included.
 * @returns the serialized text and whether it was clipped.
 */
export function serializePayload(payload: unknown, maxChars: number): { text: string; clipped: boolean } {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload) ?? String(payload)
  if (text.length <= maxChars) return { text, clipped: false }
  const kept = text.slice(0, wholeCharacterEnd(text, Math.max(0, maxChars - CLIP_MARKER.length)))
  // The final slice bounds a ceiling smaller than the marker itself.
  return { text: (kept + CLIP_MARKER).slice(0, maxChars), clipped: true }
}

/**
 * Move a cut off the middle of a surrogate pair.
 *
 * `slice` counts UTF-16 code units, so a cut inside an emoji or a CJK
 * extension character strands a high surrogate that the OTLP encoder replaces
 * with U+FFFD.
 */
function wholeCharacterEnd(text: string, end: number): number {
  if (end <= 0) return 0
  const last = text.charCodeAt(end - 1)
  return last >= 0xD800 && last <= 0xDBFF ? end - 1 : end
}
