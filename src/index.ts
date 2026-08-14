/**
 * OTLP traces backend for the DeepSeek Harness telemetry seam.
 *
 * The harness ships one telemetry Service Provider, and it exports OTLP
 * **logs**. This package is a second provider for the same Service Definition,
 * exporting OTLP **traces**: each turn becomes a trace whose spans are the
 * model steps and tool executions inside it, with GenAI semantic-convention
 * attributes. Any collector that accepts OTLP/HTTP traces receives them; no
 * vendor is assumed.
 *
 * The seam accepts exactly one backend per context and throws on a duplicate,
 * so a composition mounting this plugin disables the base profile's
 * `session-telemetry-otel` row (the shipped `cordis.patch.yml` does that).
 *
 * @module dsh-observability
 */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration-merges `feedback/record` into SessionEventMap; the FEEDBACK_ONLY
// consent listener below is typed against it.
import type {} from '@deepseek-ai/dsh-command-feedback'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import {
  SessionTelemetryBackend,
  SessionTelemetryCoordinator,
  type SessionTelemetryRecord,
  type SessionTelemetrySharingStatus,
  type SessionTelemetrySink,
} from '@deepseek-ai/dsh-session-telemetry'
import type { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import type { BasicTracerProvider, BufferConfig } from '@opentelemetry/sdk-trace-base'
import { buildReadableSpan, buildTracePipeline } from './otel.ts'
import { DEFAULT_MAX_ATTRIBUTE_CHARS, SessionSpanFolder } from './projection.ts'

// The package manifest is the single source of the instrumentation-scope
// version, matching the harness's own provider.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Instrumentation scope reported on every exported span. */
const SCOPE_NAME = 'dsh-observability'

/** Sharing policy selected by {@link Config.mode}. */
export enum TelemetryMode {
  FULL = 'FULL',
  FEEDBACK_ONLY = 'FEEDBACK_ONLY',
  DISABLED = 'DISABLED',
}

/** Default sharing policy for the schema and for direct construction. */
export const DEFAULT_TELEMETRY_MODE = TelemetryMode.DISABLED

/** Default outer allowance for the SDK's complete shutdown sequence. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 3_000

// Node clamps larger timer delays to one millisecond. A runtime protocol
// limit, not a deployment default.
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647

const DISABLED_FEEDBACK_WARNING = 'dsh-observability is DISABLED; nothing will be shared and this feedback remains local'
const NON_CANONICAL_FEEDBACK_WARNING = 'dsh-observability ignored a feedback event absent from the canonical session log'
const DROP_RECORD: SessionTelemetrySink['emit'] = () => {}

/** Fail closed when direct construction bypasses the runtime config schema. */
function assertNever(value: never): never {
  throw new Error(`dsh-observability: unsupported mode ${JSON.stringify(value)}`)
}

/** Resolve the default and reject unknown runtime values before transport setup. */
function resolveMode(mode: TelemetryMode | undefined): TelemetryMode {
  const resolved = mode ?? DEFAULT_TELEMETRY_MODE
  switch (resolved) {
    case TelemetryMode.FULL:
    case TelemetryMode.FEEDBACK_ONLY:
    case TelemetryMode.DISABLED:
      return resolved
    default:
      return assertNever(resolved)
  }
}

/** Map the serialized mode onto the seam's backend-independent sharing vocabulary. */
function sharingStatusFor(mode: TelemetryMode): SessionTelemetrySharingStatus {
  switch (mode) {
    case TelemetryMode.FULL: return 'full'
    case TelemetryMode.FEEDBACK_ONLY: return 'feedback-only'
    case TelemetryMode.DISABLED: return 'disabled'
    /* v8 ignore next 2 -- resolveMode already rejected unknown values; the closed enum cannot reach the default. */
    default: return assertNever(mode)
  }
}

/**
 * Plugin configuration: one sharing policy, two verbatim SDK option objects,
 * and two package-owned bounds. Uploading modes validate their endpoint and
 * bounds at plugin load; `DISABLED` reads neither.
 */
export interface Config {
  /** Sharing policy; defaults to local-only `DISABLED` behavior. */
  mode?: TelemetryMode
  /**
   * Passed verbatim to the SDK's OTLP/HTTP trace exporter — the complete
   * `OTLPExporterNodeConfigBase` shape (`headers`, `timeoutMillis`,
   * `compression`, `keepAlive`, …), owned and documented by the SDK. `url` is
   * the one field this package requires and validates itself.
   */
  exporter?: OTLPExporterNodeConfigBase & {
    /** Full traces endpoint (e.g. `http://127.0.0.1:4318/v1/traces`). Required outside `DISABLED`; validated at load. */
    url?: string
  }
  /** Passed verbatim to `BatchSpanProcessor`; the SDK owns and documents these knobs. */
  processor?: BufferConfig
  /** Maximum time spent awaiting the SDK provider's complete shutdown path. */
  shutdownTimeoutMillis?: number
  /** Serialized-payload ceiling per span attribute; longer payloads are clipped and marked. */
  maxAttributeChars?: number
}

/**
 * Schemastery validator for {@link Config}; cordis runs it before the plugin
 * starts. It checks only the top-level fields; value checks live in the
 * constructor so their errors name the fields. Both SDK option objects pass
 * through unchanged — the SDK defines and validates their fields, and
 * re-declaring them here would silently drop every field this plugin did not
 * repeat.
 */
export const Config: z<Config> = z.object({
  mode: z.union(Object.values(TelemetryMode)).default(DEFAULT_TELEMETRY_MODE),
  exporter: z.any(),
  processor: z.any(),
  shutdownTimeoutMillis: z.number(),
  maxAttributeChars: z.number(),
})

/**
 * The backend plugin — the only entry a deployment loads. It always registers
 * the telemetry service (a duplicate load throws). Uploading modes wire the
 * SDK pipeline, the folding projection, and a {@link SessionTelemetryCoordinator};
 * `DISABLED` constructs no SDK state and listens only to warn when recorded
 * feedback stays local.
 */
export class OtlpTracesSessionBackend extends SessionTelemetryBackend {
  static inject = ['sessions']
  static Config = Config

  private readonly directEmit: SessionTelemetrySink['emit']
  private readonly provider: BasicTracerProvider | undefined
  private readonly folder: SessionSpanFolder | undefined
  private readonly shutdownTimeoutMillis: number
  override readonly sharing: SessionTelemetrySharingStatus

  constructor(ctx: Context, config: Config) {
    const mode = resolveMode(config.mode)
    super(ctx)
    this.sharing = sharingStatusFor(mode)
    if (mode === TelemetryMode.DISABLED) {
      this.directEmit = DROP_RECORD
      this.provider = undefined
      this.folder = undefined
      this.shutdownTimeoutMillis = DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'feedback/record') ctx.logger.warn(DISABLED_FEEDBACK_WARNING)
      })
      return
    }

    // `exporter` passes through the schema as z.any(), so a YAML `url:` with no
    // value arrives as null and every non-string reaches this check untyped.
    const url = config.exporter?.url
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`dsh-observability: exporter.url is required and must be a non-empty string (the full OTLP traces endpoint), got ${JSON.stringify(url)}`)
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      // Re-thrown as a config error: the only way here is a malformed url string.
      throw new Error(`dsh-observability: exporter.url is not a valid URL: ${JSON.stringify(url)}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`dsh-observability: exporter.url must be http(s), got ${parsed.protocol}`)
    }
    // The SDK accepts a non-positive batch size, but its shutdown drain then
    // splices empty batches without consuming the queue, so dispose would hang
    // forever with records queued.
    const batchSize = config.processor?.maxExportBatchSize
    if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
      throw new Error(`dsh-observability: processor.maxExportBatchSize must be a positive integer, got ${String(batchSize)}`)
    }
    const shutdownTimeoutMillis = config.shutdownTimeoutMillis ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
    if (!Number.isFinite(shutdownTimeoutMillis) || shutdownTimeoutMillis <= 0 || shutdownTimeoutMillis > MAX_TIMER_DELAY_MILLIS) {
      throw new Error(`dsh-observability: shutdownTimeoutMillis must be a positive finite number no greater than ${MAX_TIMER_DELAY_MILLIS}, got ${String(shutdownTimeoutMillis)}`)
    }
    const maxAttributeChars = config.maxAttributeChars ?? DEFAULT_MAX_ATTRIBUTE_CHARS
    if (!Number.isInteger(maxAttributeChars) || maxAttributeChars < 1) {
      throw new Error(`dsh-observability: maxAttributeChars must be a positive integer, got ${String(maxAttributeChars)}`)
    }
    this.shutdownTimeoutMillis = shutdownTimeoutMillis

    const { provider, processor, resource } = buildTracePipeline({
      exporter: { ...config.exporter, url },
      ...config.processor === undefined ? {} : { processor: config.processor },
      resourceAttributes: {
        'service.name': APP_IDENTITY.product,
        'service.version': APP_IDENTITY.version,
      },
    })
    this.provider = provider
    this.folder = new SessionSpanFolder(
      (draft) => { processor.onEnd(buildReadableSpan(draft, resource, { name: SCOPE_NAME, version })) },
      { maxAttributeChars },
    )
    const folder = this.folder
    const enqueue: SessionTelemetrySink['emit'] = (record) => { folder.fold(record) }
    const backend: SessionTelemetrySink = { emit: enqueue, shutdown: () => this.shutdown() }
    if (mode === TelemetryMode.FULL) {
      this.directEmit = enqueue
      new SessionTelemetryCoordinator(ctx, backend, 'live')
      return
    }
    this.directEmit = DROP_RECORD
    const coordinator = new SessionTelemetryCoordinator(ctx, backend, 'on-demand')
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'feedback/record') return
      // Consent is the committed record, not an independently emitted bus value.
      if (session.events[event.seq] !== event) {
        ctx.logger.warn(NON_CANONICAL_FEEDBACK_WARNING)
        return
      }
      coordinator.captureSession(session, event.seq)
      // captureSession replays synchronously, and on-demand capture creates no
      // shutdown record, so this is the only point at which the folder learns
      // the replay is over. Without it every captured session's draft is
      // retained for the life of the process.
      folder.endSession(String(session.id))
    })
  }

  /**
   * Fold a direct service record, in `FULL` only. Direct calls are no-ops in
   * `FEEDBACK_ONLY` and `DISABLED`; feedback replay reaches the folder through
   * the coordinator's private backend capability instead.
   * @param record - the logical record offered directly to the service.
   */
  emit(record: SessionTelemetryRecord): void {
    this.directEmit(record)
  }

  // The seam's optional flush() hint is deliberately NOT implemented. The batch
  // processor exports on its own cadence (`processor.scheduledDelayMillis`),
  // and this backend is the SDK pipeline's only caller — forwarding the hint to
  // forceFlush() would be the sole source of concurrent flushes, whose
  // undocumented interaction with shutdown's internal drain silently drops tail
  // spans.

  /**
   * Close any span still open, then ask the SDK to drain and quiesce, rejecting
   * after the package-owned deadline.
   *
   * The provider promise stays observed past the deadline so a later rejection
   * cannot surface as an unhandled rejection. `DISABLED` has no provider and
   * resolves immediately.
   * @returns resolves when the SDK pipeline quiesces or is disabled, or rejects at the configured deadline.
   */
  async shutdown(): Promise<void> {
    if (this.provider === undefined) return
    // Spans left open would never reach the exporter. The seam's own shutdown
    // markers already force-end live-captured sessions; this covers on-demand
    // capture, which creates no operational records.
    this.folder?.endAll(Date.now())
    const providerShutdown = this.provider.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`dsh-observability: provider shutdown exceeded ${this.shutdownTimeoutMillis}ms`))
      }, this.shutdownTimeoutMillis)
    })
    try {
      await Promise.race([providerShutdown, deadline])
    } finally {
      /* v8 ignore else -- the Promise executor assigns timer synchronously before this race starts. */
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

export default OtlpTracesSessionBackend
