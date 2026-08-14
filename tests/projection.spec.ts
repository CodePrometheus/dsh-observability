/**
 * Folding-projection unit tier: the span tree produced from a seam record
 * stream, the force-end sweeps that close spans no terminal event reached, and
 * the replay-equality property the derived identifiers exist for.
 *
 * Records are built by hand rather than captured from a live session: the seam
 * contract, not the loop, defines what this projection consumes, and a
 * hand-built stream is the only way to exercise a missing terminal event.
 */

import { describe, expect, it } from 'vitest'
import type { SessionTelemetryRecord, SessionTelemetrySeverity } from '@deepseek-ai/dsh-session-telemetry'
import { SessionSpanFolder } from '../src/projection.ts'
import type { SpanDraft } from '../src/otel.ts'
import { stepSpanIdFor, toolSpanIdFor, traceIdFor, turnSpanIdFor } from '../src/ids.ts'

const SESSION = 'session-1'

/** Build one ledger record. `body` carries only the fields the projection reads. */
function ledger(
  type: string,
  seq: number,
  time: number,
  body: unknown,
  severity: SessionTelemetrySeverity = 'info',
): SessionTelemetryRecord {
  return {
    channel: 'ledger',
    time,
    severity,
    attributes: { 'session.id': SESSION, 'event.type': type, 'event.seq': seq },
    body,
  }
}

/**
 * Build one operational record. `agent-error` carries the error class name as
 * a seam attribute and the message in its body, the way the coordinator's
 * relay builds it.
 */
function ops(op: string, time: number, body: unknown = { op }): SessionTelemetryRecord {
  const attributes: Record<string, string | number> = { 'telemetry.op': op, 'session.id': SESSION }
  const { name } = body as { name?: string }
  if (name !== undefined) attributes['error.name'] = name
  return {
    channel: 'ops',
    time,
    severity: op === 'agent-error' ? 'error' : 'info',
    attributes,
    body,
  }
}

/**
 * A tool result's call id lives inside its message content, not at the event's
 * top level. Only that path is populated here.
 */
function toolResultBody(turn: number, step: number, callId: string, content: string) {
  return { turn, step, message: { content: [{ type: 'tool-result', toolCallId: callId, content }] } }
}

/**
 * A `user/message` body. `source.kind` is the field that separates a claimed
 * human prompt from `agent.inject()` context and goal continuation rounds, so
 * it is populated even though nothing else here reads it.
 */
function userMessage(text: string, source: { kind: string } = { kind: 'user' }) {
  return { id: `msg-${text}`, role: 'user', content: [{ type: 'text', text }], source }
}

/** Collect every span a record stream produces. */
function fold(records: SessionTelemetryRecord[], options?: { maxAttributeChars?: number }): SpanDraft[] {
  const spans: SpanDraft[] = []
  const folder = new SessionSpanFolder((draft) => spans.push(draft), options)
  for (const record of records) folder.fold(record)
  return spans
}

/** One turn with one step that calls one tool, fully terminated. */
function completeTurn(): SessionTelemetryRecord[] {
  return [
    ledger('turn/start', 0, 1_000, { turn: 0 }),
    ledger('user/message', 1, 1_010, userMessage('hi')),
    ledger('step/start', 2, 1_020, { turn: 0, step: 0 }),
    ledger('request/header', 3, 1_030, { header: { config: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.2 } }, reason: 'initial' }),
    ledger('assistant/chunk', 4, 1_100, { turn: 0, step: 0, chunk: { type: 'text', text: 'h' } }),
    ledger('assistant/message', 5, 1_200, {
      turn: 0,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 8, cacheWriteTokens: 4, reasoningTokens: 1 },
    }),
    ledger('tool/call', 6, 1_210, { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }),
    ledger('tool/result', 7, 1_400, toolResultBody(0, 0, 'call-1', 'a.ts')),
    ledger('step/end', 8, 1_410, { turn: 0, step: 0 }),
    ledger('turn/end', 9, 1_420, { turn: 0, reason: { kind: 'completed' } }),
  ]
}

describe('span tree', () => {
  it('builds one trace per turn with step and tool children', () => {
    const spans = fold(completeTurn())
    expect(spans.map((s) => s.name)).toEqual(['tool bash', 'step 0', 'turn 0'])
    const traceId = traceIdFor(SESSION, 0)
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([traceId]))
  })

  it('parents a tool span on its requesting step, and the step on its turn', () => {
    const spans = fold(completeTurn())
    const [tool, step, turn] = spans
    expect(tool?.parentSpanId).toBe(stepSpanIdFor(SESSION, 0, 0))
    expect(step?.parentSpanId).toBe(turnSpanIdFor(SESSION, 0))
    expect(turn?.parentSpanId).toBeUndefined()
    expect(tool?.spanId).toBe(toolSpanIdFor(SESSION, 0, 0, 'call-1'))
  })

  it('emits children before their parent so a collector never sees an orphan', () => {
    const names = fold(completeTurn()).map((s) => s.name)
    expect(names.indexOf('tool bash')).toBeLessThan(names.indexOf('step 0'))
    expect(names.indexOf('step 0')).toBeLessThan(names.indexOf('turn 0'))
  })

  it('timestamps every span from its own source events', () => {
    const [tool, step, turn] = fold(completeTurn())
    expect([tool?.startEpochMillis, tool?.endEpochMillis]).toEqual([1_210, 1_400])
    expect([step?.startEpochMillis, step?.endEpochMillis]).toEqual([1_020, 1_410])
    expect([turn?.startEpochMillis, turn?.endEpochMillis]).toEqual([1_000, 1_420])
  })
})

describe('attributes', () => {
  it('backfills the model identity onto the step already open when the header arrives', () => {
    const step = fold(completeTurn()).find((s) => s.name === 'step 0')
    expect(step?.attributes['gen_ai.request.model']).toBe('deepseek-chat')
    expect(step?.attributes['gen_ai.provider.name']).toBe('deepseek')
    expect(step?.attributes['gen_ai.request.temperature']).toBe(0.2)
  })

  it('exports all five token usage fields', () => {
    const step = fold(completeTurn()).find((s) => s.name === 'step 0')
    expect(step?.attributes['gen_ai.usage.input_tokens']).toBe(12)
    expect(step?.attributes['gen_ai.usage.output_tokens']).toBe(3)
    expect(step?.attributes['gen_ai.usage.cache_read_input_tokens']).toBe(8)
    expect(step?.attributes['gen_ai.usage.cache_creation_input_tokens']).toBe(4)
    expect(step?.attributes['gen_ai.usage.reasoning_tokens']).toBe(1)
  })

  it('derives time to first chunk from the one shipped chunk', () => {
    const step = fold(completeTurn()).find((s) => s.name === 'step 0')
    expect(step?.attributes['dsh.step.time_to_first_chunk_ms']).toBe(80)
  })

  it('records the turn end reason', () => {
    const turn = fold(completeTurn()).find((s) => s.name === 'turn 0')
    expect(turn?.attributes['dsh.turn.end_reason']).toBe('completed')
    expect(turn?.error).toBeUndefined()
  })

  it('clips a payload to the configured ceiling and marks it out of band', () => {
    const long = 'x'.repeat(200)
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('step/start', 1, 1_010, { turn: 0, step: 0 }),
      ledger('tool/call', 2, 1_020, { turn: 0, step: 0, callId: 'c', name: 'bash', arguments: long }),
      ledger('tool/result', 3, 1_030, toolResultBody(0, 0, 'c', 'ok')),
    ]
    const tool = fold(records, { maxAttributeChars: 32 }).find((s) => s.name === 'tool bash')
    expect(String(tool?.attributes['dsh.tool.input'])).toContain('…[clipped]')
    // The ceiling bounds what lands on the span, marker included.
    expect(String(tool?.attributes['dsh.tool.input']).length).toBe(32)
    // A payload can genuinely end in the marker, so the flag is the only
    // trustworthy signal that bytes were dropped.
    expect(tool?.attributes['dsh.payload_clipped']).toBe(true)
  })

  it('leaves the clip flag off a span whose payloads all fit', () => {
    const tool = fold(completeTurn()).find((s) => s.name === 'tool bash')
    expect(tool?.attributes['dsh.payload_clipped']).toBeUndefined()
  })

  it('records the claimed human prompt, not a later injected message', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('user/message', 1, 1_010, userMessage('fix the bug')),
      ledger('step/start', 2, 1_020, { turn: 0, step: 0 }),
      ledger('user/message', 3, 1_030, userMessage('a file changed', { kind: 'plugin' })),
      ledger('turn/end', 4, 1_040, { turn: 0, reason: { kind: 'completed' } }),
    ]
    const spans = fold(records)
    const turn = spans.find((s) => s.name === 'turn 0')
    expect(String(turn?.attributes['dsh.turn.input'])).toContain('fix the bug')
    expect(String(turn?.attributes['dsh.turn.input'])).not.toContain('a file changed')
    // The injection is not dropped either: it stays on the timeline of the
    // step that was open when it arrived.
    const step = spans.find((s) => s.name === 'step 0')
    expect(step?.events.map((e) => e.name)).toEqual(['user/message'])
  })

  it('keeps a second human message on the timeline rather than replacing the first', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('user/message', 1, 1_010, userMessage('first')),
      ledger('user/message', 2, 1_020, userMessage('second')),
      ledger('turn/end', 3, 1_030, { turn: 0, reason: { kind: 'completed' } }),
    ]
    const turn = fold(records).find((s) => s.name === 'turn 0')
    expect(String(turn?.attributes['dsh.turn.input'])).toContain('first')
    expect(turn?.events.map((e) => e.name)).toEqual(['user/message'])
  })

  it('clears a request attribute the superseding header dropped', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('step/start', 1, 1_010, { turn: 0, step: 0 }),
      ledger('request/header', 2, 1_020, { header: { config: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.2 } }, reason: 'initial' }),
      // The same conversation reconfigured without a temperature: the earlier
      // value must not survive as this request's configuration.
      ledger('request/header', 3, 1_030, { header: { config: { provider: 'deepseek', model: 'deepseek-reasoner' } }, reason: 'change' }),
      ledger('step/end', 4, 1_040, { turn: 0, step: 0 }),
      ledger('turn/end', 5, 1_050, { turn: 0, reason: { kind: 'completed' } }),
    ]
    const step = fold(records).find((s) => s.name === 'step 0')
    expect(step?.attributes['gen_ai.request.model']).toBe('deepseek-reasoner')
    expect(step?.attributes['gen_ai.request.temperature']).toBeUndefined()
  })
})

describe('error mapping', () => {
  it('reads the seam pre-mapped severity instead of re-deriving tool failure', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('step/start', 1, 1_010, { turn: 0, step: 0 }),
      ledger('tool/call', 2, 1_020, { turn: 0, step: 0, callId: 'c', name: 'bash', arguments: '{}' }),
      ledger('tool/result', 3, 1_030, toolResultBody(0, 0, 'c', 'boom'), 'error'),
    ]
    expect(fold(records).find((s) => s.name === 'tool bash')?.error).toBe(true)
  })

  it('carries the tool failure identity into the span status message', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('step/start', 1, 1_010, { turn: 0, step: 0 }),
      ledger('tool/call', 2, 1_020, { turn: 0, step: 0, callId: 'c', name: 'bash', arguments: '{}' }),
      ledger('tool/result', 3, 1_030, {
        ...toolResultBody(0, 0, 'c', 'boom'),
        error: { name: 'ToolExecutionError', code: 'EXIT_NONZERO' },
      }, 'error'),
    ]
    const tool = fold(records).find((s) => s.name === 'tool bash')
    // Code first, matching a failed turn's status message.
    expect(tool?.errorMessage).toBe('EXIT_NONZERO: ToolExecutionError')
  })

  it('marks a turn whose end reason is an error, with the failure text', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('turn/end', 1, 1_010, { turn: 0, reason: { kind: 'error', error: { message: 'nope', code: 'UNKNOWN' } } }, 'error'),
    ]
    const turn = fold(records).find((s) => s.name === 'turn 0')
    expect(turn?.error).toBe(true)
    expect(turn?.attributes['dsh.turn.end_reason']).toBe('error')
    // Status code alone leaves a trace UI's error view and message-based
    // alerting with nothing to show.
    expect(turn?.errorMessage).toBe('UNKNOWN: nope')
  })

  it('relays an agent-error operational record as a conventions-shaped exception event', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ops('agent-error', 1_100, { name: 'Error', message: 'loop failed' }),
      ledger('turn/end', 1, 1_200, { turn: 0, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } }, 'error'),
    ]
    const turn = fold(records).find((s) => s.name === 'turn 0')
    const exception = turn?.events.find((e) => e.name === 'exception')
    expect(exception).toBeDefined()
    // A receiver renders the exception from these keys; the name alone is an
    // empty panel.
    expect(exception?.attributes?.['exception.type']).toBe('Error')
    expect(exception?.attributes?.['exception.message']).toBe('loop failed')
    expect(turn?.error).toBe(true)
    // turn/end states how the turn actually concluded, so its reason owns the
    // status message; the loop failure stays legible on the exception event.
    expect(turn?.errorMessage).toBe('UNKNOWN: x')
  })

  it('reports the loop failure as the status message when no turn/end follows', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ops('agent-error', 1_100, { name: 'Error', message: 'loop failed' }),
      ops('shutdown', 1_200),
    ]
    const turn = fold(records).find((s) => s.name === 'turn 0')
    expect(turn?.errorMessage).toBe('loop failed')
  })
})

describe('unknown event types', () => {
  it('records a type without a span of its own as a span event on the open step', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('step/start', 1, 1_010, { turn: 0, step: 0 }),
      ledger('some-plugin/did-a-thing', 2, 1_020, { detail: 'x' }),
      ledger('step/end', 3, 1_030, { turn: 0, step: 0 }),
      ledger('turn/end', 4, 1_040, { turn: 0, reason: { kind: 'completed' } }),
    ]
    const step = fold(records).find((s) => s.name === 'step 0')
    expect(step?.events.map((e) => e.name)).toEqual(['some-plugin/did-a-thing'])
    expect(step?.events[0]?.attributes?.['dsh.event.seq']).toBe(2)
  })

  it('falls back to the turn span when no step is open', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('todo/write', 1, 1_010, { todos: [] }),
      ledger('turn/end', 2, 1_020, { turn: 0, reason: { kind: 'completed' } }),
    ]
    expect(fold(records).find((s) => s.name === 'turn 0')?.events.map((e) => e.name)).toEqual(['todo/write'])
  })
})

describe('force-end sweeps', () => {
  it('closes an unterminated turn when the next one starts', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('step/start', 1, 1_010, { turn: 0, step: 0 }),
      ledger('turn/start', 2, 2_000, { turn: 1 }),
      ledger('turn/end', 3, 2_010, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const spans = fold(records)
    const forced = spans.filter((s) => s.attributes['dsh.force_ended'] === true)
    expect(forced.map((s) => s.name)).toEqual(['step 0', 'turn 0'])
    expect(forced.every((s) => s.endEpochMillis === 2_000)).toBe(true)
    expect(spans.find((s) => s.name === 'turn 1')?.attributes['dsh.force_ended']).toBeUndefined()
  })

  it('closes open spans at the session shutdown record', () => {
    const spans = fold([
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('step/start', 1, 1_010, { turn: 0, step: 0 }),
      ops('shutdown', 1_500),
    ])
    expect(spans.map((s) => s.name)).toEqual(['step 0', 'turn 0'])
    expect(spans.every((s) => s.attributes['dsh.force_ended'] === true)).toBe(true)
  })

  it('closes open spans at endAll so nothing is stranded before the exporter', () => {
    const emitted: SpanDraft[] = []
    const folder = new SessionSpanFolder((draft) => emitted.push(draft))
    folder.fold(ledger('turn/start', 0, 1_000, { turn: 0 }))
    folder.fold(ledger('tool/call', 1, 1_010, { turn: 0, step: 0, callId: 'c', name: 'bash', arguments: '{}' }))
    expect(emitted).toHaveLength(0)
    folder.endAll(9_000)
    expect(emitted.map((s) => s.name)).toEqual(['tool bash', 'turn 0'])
    expect(emitted.every((s) => s.endEpochMillis === 9_000)).toBe(true)
  })

  it('parents a tool call on the turn when its step already closed', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ledger('step/start', 1, 1_010, { turn: 0, step: 0 }),
      ledger('step/end', 2, 1_020, { turn: 0, step: 0 }),
      ledger('tool/call', 3, 1_030, { turn: 0, step: 0, callId: 'c', name: 'bash', arguments: '{}' }),
      ledger('tool/result', 4, 1_040, toolResultBody(0, 0, 'c', 'ok')),
    ]
    expect(fold(records).find((s) => s.name === 'tool bash')?.parentSpanId).toBe(turnSpanIdFor(SESSION, 0))
  })

  it('closes and discards one session at endSession, stamping its last record time', () => {
    const emitted: SpanDraft[] = []
    const folder = new SessionSpanFolder((draft) => emitted.push(draft))
    folder.fold(ledger('turn/start', 0, 1_000, { turn: 0 }))
    folder.fold(ledger('step/start', 1, 1_500, { turn: 0, step: 0 }))
    folder.endSession(SESSION)
    expect(emitted.map((s) => s.name)).toEqual(['step 0', 'turn 0'])
    expect(emitted.every((s) => s.endEpochMillis === 1_500)).toBe(true)
    // A second call finds nothing: the state is gone, not merely closed.
    folder.endSession(SESSION)
    expect(emitted).toHaveLength(2)
  })
})

describe('turn coordinates', () => {
  it('synthesizes a root for a step whose turn/start never arrived', () => {
    // A redaction rule withholding turn/start, or a crash window, leaves the
    // step deriving identifiers for a turn the folder never opened.
    const records = [
      ledger('step/start', 1, 1_010, { turn: 4, step: 0 }),
      ledger('step/end', 2, 1_020, { turn: 4, step: 0 }),
      ledger('turn/end', 3, 1_030, { turn: 4, reason: { kind: 'completed' } }),
    ]
    const spans = fold(records)
    const turn = spans.find((s) => s.name === 'turn 4')
    const step = spans.find((s) => s.name === 'step 0')
    // The root exists and the child's declared parent is it, so the collector
    // receives no span whose parent never ships.
    expect(turn?.spanId).toBe(turnSpanIdFor(SESSION, 4))
    expect(step?.parentSpanId).toBe(turn?.spanId)
    expect(turn?.traceId).toBe(step?.traceId)
    expect(turn?.attributes['dsh.turn.synthesized']).toBe(true)
  })

  it('does not strand a step recorded under a turn other than the open one', () => {
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      // turn 1's own start is missing; its step must not land in turn 0's tree
      // nor in a trace whose root is never sent.
      ledger('step/start', 1, 2_000, { turn: 1, step: 0 }),
      ledger('step/end', 2, 2_010, { turn: 1, step: 0 }),
      ledger('turn/end', 3, 2_020, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const spans = fold(records)
    const step = spans.find((s) => s.name === 'step 0')
    expect(step?.traceId).toBe(traceIdFor(SESSION, 1))
    expect(step?.parentSpanId).toBe(turnSpanIdFor(SESSION, 1))
    // Turn 0 is force-ended rather than left open behind its successor.
    const first = spans.find((s) => s.spanId === turnSpanIdFor(SESSION, 0))
    expect(first?.attributes['dsh.force_ended']).toBe(true)
  })

  it('adopts a synthesized root when the real turn/start arrives after it', () => {
    const records = [
      ledger('tool/call', 1, 1_010, { turn: 0, step: 0, callId: 'c', name: 'bash', arguments: '{}' }),
      ledger('turn/start', 2, 1_020, { turn: 0 }),
      ledger('turn/end', 3, 1_030, { turn: 0, reason: { kind: 'completed' } }),
    ]
    const spans = fold(records)
    // One root, not a force-ended synthetic plus a real one.
    expect(spans.filter((s) => s.name === 'turn 0')).toHaveLength(1)
    expect(spans.find((s) => s.name === 'turn 0')?.attributes['dsh.turn.synthesized']).toBeUndefined()
  })
})

describe('operational records', () => {
  it('keeps an unrecognized op on the timeline instead of truncating the trace', () => {
    // The seam owns the op set and may extend it. Treating an unknown op as
    // shutdown would force-end the turn and split everything after it away.
    const records = [
      ledger('turn/start', 0, 1_000, { turn: 0 }),
      ops('capture-lag', 1_100, { op: 'capture-lag', millis: 40 }),
      ledger('step/start', 1, 1_200, { turn: 0, step: 0 }),
      ledger('step/end', 2, 1_300, { turn: 0, step: 0 }),
      ledger('turn/end', 3, 1_400, { turn: 0, reason: { kind: 'completed' } }),
    ]
    const spans = fold(records)
    expect(spans.map((s) => s.name)).toEqual(['step 0', 'turn 0'])
    expect(spans.some((s) => s.attributes['dsh.force_ended'] === true)).toBe(false)
    const turn = spans.find((s) => s.name === 'turn 0')
    expect(turn?.events.map((e) => e.name)).toEqual(['capture-lag'])
  })
})

describe('replay equality', () => {
  it('produces identical identifiers and times when the same events are folded twice', () => {
    const first = fold(completeTurn())
    const second = fold(completeTurn())
    const identity = (spans: SpanDraft[]) =>
      spans.map((s) => [s.name, s.traceId, s.spanId, s.parentSpanId, s.startEpochMillis, s.endEpochMillis])
    expect(identity(second)).toEqual(identity(first))
  })

  it('is unaffected by seq gaps, which the seam creates by design', () => {
    const gapped = completeTurn().map((record, index) => ({
      ...record,
      attributes: { ...record.attributes, 'event.seq': index * 7 },
    }))
    const ids = (spans: SpanDraft[]) => spans.map((s) => [s.name, s.traceId, s.spanId])
    expect(ids(fold(gapped))).toEqual(ids(fold(completeTurn())))
  })
})
