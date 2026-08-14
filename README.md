# dsh-observability

English | [中文](README.zh.md)

OpenTelemetry **traces** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): exports each agent session as an OTLP span tree — turn to trace, model step to a child span, tool call to a child of its step — with GenAI semantic-convention attributes, to any collector that accepts OTLP/HTTP.

This is a community plugin (`dsh-plugin` topic), not part of the official repository. It implements the harness's public telemetry Service Definition (`@deepseek-ai/dsh-session-telemetry`) as a second Service Provider beside the official one, which exports OTLP **logs**.

## Install

The package ships a `cordis.patch.yml`, so it installs as a profile bundle:

```sh
dsh plugin --profile web add dsh-observability
export DSH_OBSERVABILITY_MODE=FULL
export DSH_OBSERVABILITY_OTLP_URL=http://127.0.0.1:4318/v1/traces
```

Sharing stays off until `DSH_OBSERVABILITY_MODE` says otherwise. Configuring an endpoint is not consent to upload session content — see [What leaves the machine](#what-leaves-the-machine).

The bundled patch disables the base profile's `session-telemetry-otel` row: the telemetry Service Definition accepts exactly one backend per context and throws on a duplicate load.

Or mount it as an explicit `cordis.yml` row:

```yaml
- id: session-telemetry-otlp-traces
  name: dsh-observability
  config:
    mode: FULL                 # FULL | FEEDBACK_ONLY | DISABLED (default)
    exporter:                  # passed verbatim to the SDK's OTLP/HTTP trace exporter
      url: http://127.0.0.1:4318/v1/traces
      compression: gzip
    processor: {}              # optional; passed verbatim to BatchSpanProcessor
    shutdownTimeoutMillis: 3000
    maxAttributeChars: 32768
```

## Config

| Field | Meaning |
|---|---|
| `mode` | `FULL` exports every session live; `FEEDBACK_ONLY` replays and exports the canonical session log only when the user records feedback; `DISABLED` (default) constructs nothing and nothing leaves the process. The vocabulary and consent semantics are the Service Definition's, identical to the official provider. |
| `exporter` | The complete `OTLPExporterNodeConfigBase` object, passed verbatim to the OTLP/HTTP trace exporter. `url` is required outside `DISABLED` and must be the **full traces path** (`…/v1/traces`). |
| `processor` | Passed verbatim to `BatchSpanProcessor` (`scheduledDelayMillis`, `maxQueueSize`, `maxExportBatchSize`, …); batching, retry, and loss policy are the SDK's documented behavior. |
| `shutdownTimeoutMillis` | Plugin-owned outer deadline on the SDK's shutdown drain. Defaults to 3000. |
| `maxAttributeChars` | Serialized-payload ceiling per span attribute (default 32768). The ceiling bounds the exported value with its `…[clipped]` marker included, and a clipped span carries `dsh.payload_clipped=true` — the marker alone cannot be trusted, since a payload may genuinely end in it. The canonical session log keeps the full bytes. |

Misconfiguration fails loud at plugin load, before any transport is constructed: a `url` that is missing, empty, not a string, malformed, or not `http(s)`; a non-positive-integer `processor.maxExportBatchSize` (the SDK accepts it but then hangs on shutdown); a non-positive or non-finite `shutdownTimeoutMillis`; a non-positive `maxAttributeChars`; or an unknown `mode`.

## Field mapping

| dsh session event | Span |
|---|---|
| `turn/start` / `turn/end` | trace root span; the end reason lands on `dsh.turn.end_reason`, and an error reason sets status ERROR with the failure's `code: message` |
| `step/start` / `step/end` | child span with `gen_ai.operation.name=chat` |
| `request/header` | `gen_ai.request.model`, `gen_ai.provider.name`, and the sampling scalars, backfilled onto the step already open. A later header replaces them outright, so a scalar it drops does not survive from the previous one |
| first `assistant/chunk` of a step | `dsh.step.time_to_first_chunk_ms` (time to first token) |
| `assistant/message` | assembled reply plus all five `gen_ai.usage.*` counts (input, output, cache read, cache write, reasoning) |
| `tool/call` + `tool/result` | child span of the requesting step, with `gen_ai.operation.name=execute_tool`; a failing result sets status ERROR with the reported failure's `code: name`, when it reports one |
| `user/message` | the turn's claimed human prompt (`source.kind` is `user`) becomes `dsh.turn.input` on the trace root. The same event type also carries `agent.inject()` context and goal continuation rounds, which stay on the timeline as span events rather than replacing the prompt |
| `agent-error` ops record | `exception` span event carrying `exception.type` / `exception.message`, plus status ERROR on the open span |
| every other event type (todo, plan, compaction, hooks, plugin events) | point-in-time span event on the innermost open span |
| an ops record whose op this package does not recognize | point-in-time span event; the seam owns that op set and may extend it, so an unknown op never truncates the trace |

Identifiers are **derived, not generated**: `traceId` from `(session.id, turn)` and `spanId` from `(session.id, turn, step[, callId])`. Live capture and `FEEDBACK_ONLY` canonical-log replay of the same events therefore produce identical trees, and a duplicate handoff after a cursor-less re-adoption lands on the existing span instead of creating a second, disconnected one. Every timestamp comes from the record's own `time`, never the wall clock, for the same reason.

Spans left open by a missing terminal event are closed by a force-end sweep and marked `dsh.force_ended`: at the next `turn/start` with an open predecessor, at the session's `shutdown` operational record, at the end of a `FEEDBACK_ONLY` replay, and at backend shutdown.

A missing `turn/start` — a crash window, or a record a redaction rule withheld — does not orphan the turn's children. The first child recorded under an unopened turn synthesizes that turn's root span, marked `dsh.turn.synthesized`, so the collector never receives a span whose declared parent it will never be sent.

## What leaves the machine

In uploading modes, span attributes carry user and assistant message content, tool arguments and results (command output, file contents), model and usage metadata, and the session `cwd` (a local path), as returned by the `session-telemetry/record` waterfall.

**This plugin ships no redaction rules.** With no waterfall listener mounted, records reach the exporter exactly as captured, so a deployment exporting beyond a trusted boundary mounts its own rules. Provider API keys are structurally absent: adapter credentials are constructor parameters, never session events, so they never enter the session log and therefore never reach telemetry. Serialized payloads are clipped at `maxAttributeChars` per attribute; the canonical log keeps the full bytes.

## Model Experience

None, as this plugin only observes the session stream through the telemetry Service Definition and hands folded spans to the OTel SDK; it never contributes to a model request.

#### KV Cache effect

None; this plugin neither assembles nor sends a provider request.

## Testing

```sh
npm test                            # unit: id derivation, folding projection, config fail-loud paths
npm run build && npm run test:e2e   # REAL composition through the Loader against a mock collector
```

The e2e tier follows the official repository's REAL-composition pattern: the fixture `cordis.yml` loads the **built** `lib/index.js` — the same file a deployment loads — and assertions run against the OTLP payload on the wire, not against internals.

## Version compatibility

DeepSeek Harness is in developer preview with no compatibility promises; this plugin pins exact `@deepseek-ai/dsh-*` versions.

| dsh-observability | `@deepseek-ai/dsh-*` | `@deepseek-ai/cordis` |
|---|---|---|
| 0.1.x | 0.1.0-rc.6 | 4.0.1 |

## Known Limitations and Deferred Work

- **Best-effort delivery.** Inherited from the Service Definition: the handoff cursor marks handed-off, not delivered. Whatever sits in the SDK batch queue at crash time is lost, and a cursor-less re-adoption may re-hand a prefix. Derived identifiers make those repeats idempotent at the receiver, but a durable outbox is out of scope.
- **No built-in redaction rules.** See [What leaves the machine](#what-leaves-the-machine).
- **Subagent lineage is not stitched.** A forked session's tree starts at its inherited boundary; `session.parent_id` and `session.seed_length` ride the span attributes, but no trace links are created.
- **One backend per context.** Running this plugin and the official OTLP-logs provider simultaneously requires a multi-sink evolution of the upstream Service Definition.
- **No metrics signal.** The Service Definition's record vocabulary is log-shaped (time, severity, attributes, body), so counters and histograms would have to be derived here rather than captured; only traces are exported.

## License

[MIT](LICENSE.txt)
