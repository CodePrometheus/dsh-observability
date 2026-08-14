/**
 * Deterministic trace and span identifiers derived from session coordinates.
 *
 * OpenTelemetry's `IdGenerator` takes no arguments, so identifiers created
 * through a `Tracer` are random and unrelated to the session that produced
 * them. This module derives them from `(session.id, turn, step)` instead,
 * which buys two properties the exporter depends on: live capture and
 * `FEEDBACK_ONLY` canonical-log replay of the same events produce the same
 * tree, and a duplicate handoff after a cursor-less re-adoption lands on the
 * existing span rather than creating a second, disconnected one.
 *
 * Derivation is SHA-256 over a delimited coordinate string, truncated to the
 * width the wire format requires. Truncated SHA-256 is used as a fixed-length
 * mapping, not as a security barrier: the inputs are process-local session
 * identifiers, never a secret.
 *
 * @module dsh-observability/ids
 */

import { createHash } from 'node:crypto'

/** Hex width of an OTLP trace id — 16 bytes. */
const TRACE_ID_CHARS = 32

/** Hex width of an OTLP span id — 8 bytes. */
const SPAN_ID_CHARS = 16

/**
 * The all-zero trace id, which OpenTelemetry reserves as "invalid".
 * A derivation landing here is replaced rather than exported.
 */
const INVALID_TRACE_ID = '0'.repeat(TRACE_ID_CHARS)

/** The all-zero span id, likewise reserved as invalid. */
const INVALID_SPAN_ID = '0'.repeat(SPAN_ID_CHARS)

/**
 * Field separator for coordinate strings. `\u0000` cannot occur in a session
 * id, turn number, or tool call id, so no two distinct coordinate tuples can
 * serialize to the same string — a session id containing an ordinary
 * delimiter such as `:` would otherwise be able to collide with a different
 * tuple.
 */
const SEPARATOR = '\u0000'

/**
 * Hash a coordinate string to a fixed-width lowercase hex identifier.
 *
 * The all-zero result is remapped through one extra hashing round because
 * OpenTelemetry treats it as the invalid id and drops the span. The
 * probability is negligible, but a dropped span would be silent, and one
 * extra round costs nothing on a path that never runs.
 */
function derive(coordinate: string, chars: number, invalid: string): string {
  const id = createHash('sha256').update(coordinate).digest('hex').slice(0, chars)
  if (id !== invalid) return id
  return createHash('sha256').update(`${coordinate}${SEPARATOR}1`).digest('hex').slice(0, chars)
}

/**
 * Derive the trace id for one turn. A turn is the trace root, so every span
 * belonging to the turn shares this id.
 * @param sessionId - the session the turn belongs to.
 * @param turn - the turn ordinal within the session.
 * @returns a 32-character lowercase hex trace id, never the reserved all-zero value.
 */
export function traceIdFor(sessionId: string, turn: number): string {
  return derive(`${sessionId}${SEPARATOR}${turn}`, TRACE_ID_CHARS, INVALID_TRACE_ID)
}

/**
 * Derive the span id of a turn's root span.
 * @param sessionId - the session the turn belongs to.
 * @param turn - the turn ordinal within the session.
 * @returns a 16-character lowercase hex span id, never the reserved all-zero value.
 */
export function turnSpanIdFor(sessionId: string, turn: number): string {
  return derive(`${sessionId}${SEPARATOR}${turn}${SEPARATOR}turn`, SPAN_ID_CHARS, INVALID_SPAN_ID)
}

/**
 * Derive the span id of one model step within a turn.
 * @param sessionId - the session the turn belongs to.
 * @param turn - the turn ordinal within the session.
 * @param step - the step ordinal within the turn.
 * @returns a 16-character lowercase hex span id, never the reserved all-zero value.
 */
export function stepSpanIdFor(sessionId: string, turn: number, step: number): string {
  return derive(`${sessionId}${SEPARATOR}${turn}${SEPARATOR}${step}`, SPAN_ID_CHARS, INVALID_SPAN_ID)
}

/**
 * Derive the span id of one tool execution.
 *
 * The model-issued call id is the distinguishing component: a step can call
 * the same tool more than once, so the tool name would not separate them.
 * @param sessionId - the session the turn belongs to.
 * @param turn - the turn ordinal within the session.
 * @param step - the step that issued the call.
 * @param callId - the model-issued tool call id.
 * @returns a 16-character lowercase hex span id, never the reserved all-zero value.
 */
export function toolSpanIdFor(sessionId: string, turn: number, step: number, callId: string): string {
  return derive(
    `${sessionId}${SEPARATOR}${turn}${SEPARATOR}${step}${SEPARATOR}${callId}`,
    SPAN_ID_CHARS,
    INVALID_SPAN_ID,
  )
}
