/**
 * Attribute-mapping unit tier: the payload ceiling that bounds what a single
 * tool result can put on one span, and the request-attribute replacement that
 * keeps a superseded header from reading as the current configuration.
 */

import { describe, expect, it } from 'vitest'
import type { Attributes } from '@opentelemetry/api'
import { CLIP_MARKER, applyRequestAttributes, serializePayload } from '../src/semconv.ts'

describe('serializePayload', () => {
  it('returns a payload that fits unchanged', () => {
    expect(serializePayload('short', 32)).toEqual({ text: 'short', clipped: false })
  })

  it('leaves a payload of exactly the ceiling unclipped', () => {
    const exact = 'x'.repeat(32)
    expect(serializePayload(exact, 32)).toEqual({ text: exact, clipped: false })
  })

  it('bounds the clipped result by the ceiling, marker included', () => {
    const { text, clipped } = serializePayload('x'.repeat(200), 32)
    expect(clipped).toBe(true)
    expect(text).toHaveLength(32)
    expect(text.endsWith(CLIP_MARKER)).toBe(true)
  })

  it('holds the ceiling one character over the limit', () => {
    const { text, clipped } = serializePayload('x'.repeat(33), 32)
    expect(clipped).toBe(true)
    expect(text).toHaveLength(32)
  })

  it('holds a ceiling smaller than the marker itself', () => {
    // A ceiling this small is a misconfiguration, not a deployment default,
    // but it must still bound the result rather than overshoot by the marker.
    for (const maxChars of [1, 5, CLIP_MARKER.length]) {
      const { text } = serializePayload('x'.repeat(50), maxChars)
      expect(text.length).toBeLessThanOrEqual(maxChars)
    }
  })

  it('never cuts a surrogate pair in half', () => {
    // Each emoji is two UTF-16 code units, so an odd cut would strand a high
    // surrogate that the OTLP encoder replaces with U+FFFD.
    const emoji = '🙂'.repeat(50)
    for (let maxChars = CLIP_MARKER.length + 1; maxChars <= CLIP_MARKER.length + 8; maxChars++) {
      const { text } = serializePayload(emoji, maxChars)
      expect(text.length).toBeLessThanOrEqual(maxChars)
      expect(text.isWellFormed()).toBe(true)
    }
  })

  it('serializes a structured payload before measuring it', () => {
    expect(serializePayload({ a: 1 }, 32).text).toBe('{"a":1}')
  })
})

describe('applyRequestAttributes', () => {
  it('writes the provider and model, omitting scalars the config never set', () => {
    const attributes: Attributes = {}
    applyRequestAttributes(attributes, { provider: 'deepseek', model: 'deepseek-chat' })
    expect(attributes['gen_ai.provider.name']).toBe('deepseek')
    expect(attributes['gen_ai.request.model']).toBe('deepseek-chat')
    // An exported null would read as a configured zero to an aggregating
    // collector, so an unset scalar has no key at all.
    expect('gen_ai.request.temperature' in attributes).toBe(false)
  })

  it('clears a scalar the superseding configuration dropped', () => {
    const attributes: Attributes = {}
    applyRequestAttributes(attributes, { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.2, maxTokens: 512 })
    applyRequestAttributes(attributes, { provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(attributes['gen_ai.request.model']).toBe('deepseek-reasoner')
    expect('gen_ai.request.temperature' in attributes).toBe(false)
    expect('gen_ai.request.max_tokens' in attributes).toBe(false)
  })

  it('leaves attributes it does not own in place', () => {
    const attributes: Attributes = { 'dsh.turn': 3 }
    applyRequestAttributes(attributes, { provider: 'deepseek', model: 'deepseek-chat' })
    expect(attributes['dsh.turn']).toBe(3)
  })
})
