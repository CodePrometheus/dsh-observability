/**
 * Config unit tier: every rejection path fires at plugin load, before any
 * transport is constructed, and the sharing disclosure matches the selected
 * mode. `DISABLED` must read no transport setting at all, which is asserted
 * through throwing getters rather than by inspecting internals.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { recordFeedback } from '@deepseek-ai/dsh-command-feedback'
import SessionStore from '@deepseek-ai/dsh-session'
import OtlpTracesSessionBackend, { type Config, TelemetryMode } from '../src/index.ts'

/** A context with the one service the backend injects. */
async function contextWithSessions(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx
}

const VALID_URL = 'http://127.0.0.1:4318/v1/traces'

describe('rejected configuration', () => {
  it.each([
    [{ mode: TelemetryMode.FULL }, /exporter\.url is required/],
    [{ mode: TelemetryMode.FULL, exporter: { url: '' } }, /exporter\.url is required/],
    // `exporter` reaches the constructor as z.any(), so a YAML `url:` with no
    // value arrives as null and any non-string reaches it untyped.
    [{ mode: TelemetryMode.FULL, exporter: { url: null } }, /exporter\.url is required/],
    [{ mode: TelemetryMode.FULL, exporter: { url: 4318 } }, /exporter\.url is required/],
    [{ mode: TelemetryMode.FULL, exporter: { url: 'not-a-url' } }, /not a valid URL/],
    [{ mode: TelemetryMode.FULL, exporter: { url: 'ftp://collector/v1/traces' } }, /must be http\(s\)/],
    [{ mode: TelemetryMode.FEEDBACK_ONLY, exporter: { url: VALID_URL }, processor: { maxExportBatchSize: 0 } }, /maxExportBatchSize/],
    [{ mode: TelemetryMode.FULL, exporter: { url: VALID_URL }, processor: { maxExportBatchSize: 1.5 } }, /maxExportBatchSize/],
    [{ mode: TelemetryMode.FULL, exporter: { url: VALID_URL }, shutdownTimeoutMillis: 0 }, /shutdownTimeoutMillis/],
    [{ mode: TelemetryMode.FULL, exporter: { url: VALID_URL }, shutdownTimeoutMillis: Number.POSITIVE_INFINITY }, /shutdownTimeoutMillis/],
    [{ mode: TelemetryMode.FULL, exporter: { url: VALID_URL }, maxAttributeChars: 0 }, /maxAttributeChars/],
  ])('rejects %j at plugin load', async (config, message) => {
    const ctx = await contextWithSessions()
    await expect(ctx.plugin(OtlpTracesSessionBackend, config as Config)).rejects.toThrow(message)
  })

  it('rejects an unknown direct mode before reading transport config', async () => {
    const ctx = await contextWithSessions()
    let exporterRead = false
    const config = {
      mode: 'INVALID',
      get exporter() {
        exporterRead = true
        throw new Error('transport config was read')
      },
    } as unknown as Config

    expect(() => new OtlpTracesSessionBackend(ctx, config)).toThrow(/unsupported mode "INVALID"/)
    expect(exporterRead).toBe(false)
  })
})

describe('disabled mode', () => {
  it('reads no transport setting', async () => {
    const ctx = await contextWithSessions()
    const transportRead = vi.fn(() => {
      throw new Error('transport config was read')
    })
    const config = {
      mode: TelemetryMode.DISABLED,
      get exporter() {
        return transportRead()
      },
      get processor() {
        return transportRead()
      },
    } as unknown as Config

    // Direct construction, not ctx.plugin: the `z.any()` fields make schema
    // validation itself touch every configured property, so only bypassing the
    // schema isolates what the constructor reads.
    new OtlpTracesSessionBackend(ctx, config)
    expect(transportRead).not.toHaveBeenCalled()
  })

  it('is the default when no mode is configured', async () => {
    const ctx = await contextWithSessions()
    // No exporter.url, which every uploading mode requires: loading without a
    // rejection is itself the evidence that the default is DISABLED.
    await ctx.plugin(OtlpTracesSessionBackend, {} as Config)
    expect(ctx.sessionTelemetry.sharing).toBe('disabled')
  })
})

describe('disposal', () => {
  it('removes the service when its fiber disposes', async () => {
    const ctx = await contextWithSessions()
    const fiber = await ctx.plugin(OtlpTracesSessionBackend, {
      mode: TelemetryMode.FULL,
      exporter: { url: VALID_URL },
    } as Config)
    expect(ctx.get('sessionTelemetry')).toBeDefined()

    await fiber.dispose()
    // The registration is an effect: unloading the fiber must unwind it, or a
    // reload would hit the Service Definition's one-backend-per-context throw.
    expect(ctx.get('sessionTelemetry')).toBeUndefined()
  })

  it('can be reloaded after disposal', async () => {
    const ctx = await contextWithSessions()
    const config = { mode: TelemetryMode.FULL, exporter: { url: VALID_URL } } as Config
    const first = await ctx.plugin(OtlpTracesSessionBackend, config)
    await first.dispose()
    const second = await ctx.plugin(OtlpTracesSessionBackend, config)
    expect(ctx.get('sessionTelemetry')).toBeDefined()
    await second.dispose()
  })
})

describe('feedback-only capture', () => {
  /**
   * Event types the seam handed over, observed through its own redaction
   * waterfall: this tier constructs no collector, and the waterfall is the
   * only capture-time extension point that does not require one.
   */
  function handedOver(ctx: Context): string[] {
    const types: string[] = []
    ctx.on('session-telemetry/record', (record, next) => {
      const type = record.attributes['event.type']
      if (typeof type === 'string') types.push(type)
      return next()
    })
    return types
  }

  async function bootFeedbackOnly(): Promise<{ ctx: Context; types: string[]; dispose: () => Promise<void> }> {
    const ctx = await contextWithSessions()
    const fiber = await ctx.plugin(OtlpTracesSessionBackend, {
      mode: TelemetryMode.FEEDBACK_ONLY,
      exporter: { url: VALID_URL },
    } as Config)
    return { ctx, types: handedOver(ctx), dispose: () => fiber.dispose() }
  }

  it('captures nothing until the user records feedback', async () => {
    const { ctx, types, dispose } = await bootFeedbackOnly()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 0 })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    // On-demand capture registers no firehose listener, so a live turn alone
    // must leave the process silent.
    expect(types).toEqual([])

    recordFeedback(session, 'this went well')
    expect(types).toContain('turn/start')
    expect(types).toContain('turn/end')
    await dispose()
  })

  it('ignores a feedback event absent from the canonical session log', async () => {
    const { ctx, types, dispose } = await bootFeedbackOnly()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 0 })
    // A bus value that was never committed to the log is not consent. This is
    // a silent-failure path: without the check a copy would be captured, and
    // without coverage a harness that publishes copies would disable capture
    // entirely behind one warning.
    ctx.emit('session/event', session, {
      type: 'feedback/record',
      seq: session.events.length,
      time: Date.now(),
      data: { text: 'not committed' },
    })
    expect(warn).toHaveBeenCalledWith('dsh-observability ignored a feedback event absent from the canonical session log')
    expect(types).toEqual([])
    await dispose()
  })

  it('warns that recorded feedback stays local when disabled', async () => {
    const ctx = await contextWithSessions()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.plugin(OtlpTracesSessionBackend, { mode: TelemetryMode.DISABLED } as Config)
    const types = handedOver(ctx)
    const session = ctx.sessions.create()
    recordFeedback(session, 'stays here')
    expect(warn).toHaveBeenCalledWith('dsh-observability is DISABLED; nothing will be shared and this feedback remains local')
    expect(types).toEqual([])
  })
})

describe('sharing disclosure', () => {
  it.each([
    [TelemetryMode.FULL, 'full'],
    [TelemetryMode.FEEDBACK_ONLY, 'feedback-only'],
    [TelemetryMode.DISABLED, 'disabled'],
  ])('discloses %s as %s', async (mode, sharing) => {
    const ctx = await contextWithSessions()
    await ctx.plugin(OtlpTracesSessionBackend, { mode, exporter: { url: VALID_URL } } as Config)
    expect(ctx.sessionTelemetry.sharing).toBe(sharing)
    await ctx.sessionTelemetry.shutdown()
  })
})
