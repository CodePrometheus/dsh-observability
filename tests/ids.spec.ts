/**
 * Identifier derivation unit tier: the properties the exporter's
 * duplicate-tolerance and replay-equality guarantees rest on — same
 * coordinates yield the same id, distinct coordinates do not collide, and
 * every id is wire-valid.
 */

import { describe, expect, it } from 'vitest'
import { stepSpanIdFor, toolSpanIdFor, traceIdFor, turnSpanIdFor } from '../src/ids.ts'

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/

describe('traceIdFor', () => {
  it('derives the same trace id for the same session and turn', () => {
    expect(traceIdFor('session-a', 3)).toBe(traceIdFor('session-a', 3))
  })

  it('separates turns of one session and sessions at one turn', () => {
    const ids = new Set([
      traceIdFor('session-a', 3),
      traceIdFor('session-a', 4),
      traceIdFor('session-b', 3),
    ])
    expect(ids.size).toBe(3)
  })

  it('produces a wire-valid, non-zero trace id', () => {
    const id = traceIdFor('session-a', 0)
    expect(id).toMatch(TRACE_ID_PATTERN)
    expect(id).not.toBe('0'.repeat(32))
  })
})

describe('span id derivation', () => {
  it('gives a turn, its steps, and its tools distinct span ids', () => {
    const ids = new Set([
      turnSpanIdFor('session-a', 1),
      stepSpanIdFor('session-a', 1, 0),
      stepSpanIdFor('session-a', 1, 1),
      toolSpanIdFor('session-a', 1, 0, 'call-1'),
      toolSpanIdFor('session-a', 1, 0, 'call-2'),
    ])
    expect(ids.size).toBe(5)
  })

  it('separates two calls of the same tool within one step by call id', () => {
    expect(toolSpanIdFor('s', 1, 0, 'call-1')).not.toBe(toolSpanIdFor('s', 1, 0, 'call-2'))
  })

  it('is stable across calls', () => {
    expect(stepSpanIdFor('session-a', 2, 5)).toBe(stepSpanIdFor('session-a', 2, 5))
    expect(toolSpanIdFor('session-a', 2, 5, 'c')).toBe(toolSpanIdFor('session-a', 2, 5, 'c'))
  })

  it('produces wire-valid, non-zero span ids', () => {
    for (const id of [turnSpanIdFor('s', 0), stepSpanIdFor('s', 0, 0), toolSpanIdFor('s', 0, 0, 'c')]) {
      expect(id).toMatch(SPAN_ID_PATTERN)
      expect(id).not.toBe('0'.repeat(16))
    }
  })

  it('does not let a session id absorb a turn boundary', () => {
    // A separator that can occur inside a session id would let ('a', 1) and
    // ('a 1', <nothing>) serialize alike; the space separator cannot.
    expect(turnSpanIdFor('session-a', 1)).not.toBe(turnSpanIdFor('session-a 1', 1))
  })
})
